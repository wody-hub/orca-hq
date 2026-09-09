import { readFile, mkdir } from "node:fs/promises";
import { openDatabase } from "@orca-hq/persistence";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parsePilotConfigText, pilotConfigurationPath } from "@orca-hq/core";
import { readLocalCredential } from "./local-runtime.js";
import { createProjectCatalog } from "./managed-projects.js";
import { createOrcaRelay, runOrca } from "./orca-relay.js";
import { createRelayCoordinator } from "./relay-coordinator.js";
import { createOrcaObserver } from "./managed-observe.js";
import {
  createManagedCommands,
  formatManagedJob,
  type CommandJob,
  type ManagedCommandResult,
} from "./managed-commands.js";
import { startManagedService } from "./managed-service.js";
import { createLocalChannels } from "./local-channels.js";
import {
  createAgentConversation,
  agentInstructions,
} from "./agent-conversation.js";
import { createCodexSessionClient } from "./codex-session.js";
import { createAgentTools } from "./agent-tools.js";
import { openProgressStore } from "./progress-store.js";
import {
  createExecutionReservations,
  normalizeResourceAccesses,
} from "./execution-reservations.js";
import { createExecutionCompatibility } from "./execution-compatibility.js";
import { createProgressRuntime } from "./progress-runtime.js";
import { createProgressControl } from "./progress-control.js";
import {
  createModelContextRouter,
  routerInstructions,
} from "./context-router.js";
import { createProjectLocations } from "./project-locations.js";

const activeJobStates = new Set(["queued", "running", "recovery_required"]);
const terminalJobStates = new Set(["succeeded", "failed", "stopped"]);

export function createObservedJobListReader(source: {
  listActiveCached(): CommandJob[];
  listCached(): CommandJob[];
}): (requestId: string) => Promise<ManagedCommandResult> {
  const newestFirst = (left: CommandJob, right: CommandJob) =>
    (Date.parse(right.updatedAt) || Date.parse(right.createdAt) || 0) -
    (Date.parse(left.updatedAt) || Date.parse(left.createdAt) || 0);
  return async () => {
    const active = source
      .listActiveCached()
      .filter((job) => activeJobStates.has(job.state))
      .sort(newestFirst);
    const activeIds = new Set(active.map((job) => job.id));
    const recent = source
      .listCached()
      .filter(
        (job) => terminalJobStates.has(job.state) && !activeIds.has(job.id),
      )
      .sort(newestFirst)
      .slice(0, 20);
    const observed = [...active, ...recent]
      .map((job) => job.updatedAt || job.createdAt)
      .filter(Boolean)
      .sort((left, right) => (Date.parse(right) || 0) - (Date.parse(left) || 0))
      .at(0);
    return {
      text: [
        `현재 활성 작업 ${active.length}개 (마지막 관찰 스냅샷 기준)`,
        observed
          ? `최근 기록된 작업 업데이트: ${observed}`
          : "저장된 관찰 기록이 없습니다.",
        "이 목록은 HQ가 저장한 관찰 결과이며, 그 이후 상태가 변경되었을 수 있습니다.",
        active.length ? active.map(formatManagedJob).join("\n\n") : "",
        `최근 종료 작업 ${recent.length}개 (저장된 최근 최대 20개)`,
        recent.length ? recent.map(formatManagedJob).join("\n\n") : "",
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 14000),
    };
  };
}

export async function startManagedRuntime() {
  process.umask(0o077);
  const configPath = pilotConfigurationPath({
    homeDirectory: homedir(),
    configDirectory: process.env.XDG_CONFIG_HOME,
  });
  const config = parsePilotConfigText(await readFile(configPath, "utf8"));
  const directory = dirname(configPath);
  const owner = z
    .object({
      slackUserId: z.string().regex(/^U[A-Z0-9]+$/),
      telegramUserId: z.string().regex(/^\d+$/),
    })
    .strict()
    .parse(
      JSON.parse(await readFile(join(directory, "managed-owner.json"), "utf8")),
    );
  const accounts = [
    "slack-app-token",
    "slack-bot-token",
    "slack-channel-id",
    "telegram-bot-token",
    "telegram-allowed-chat-id",
  ] as const;
  const values = await Promise.all(accounts.map(readLocalCredential));
  const credentials = Object.fromEntries(
    accounts.map((a, i) => [a, values[i]!]),
  ) as Record<(typeof accounts)[number], string>;
  if (owner.telegramUserId !== credentials["telegram-allowed-chat-id"])
    throw new Error("managed_owner_mismatch");
  const progressStore = openProgressStore({
    databasePath: join(directory, "progress.sqlite"),
    ownerKey: "local",
  });
  let progress: ReturnType<typeof createProgressRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startManagedService>> | undefined;
  const coordinator = z
    .object({ coordinatorHandle: z.string().startsWith("term_") })
    .passthrough()
    .parse(
      JSON.parse(
        await readFile(join(directory, "relay-coordinator.json"), "utf8"),
      ),
    );
  const recovery = createRelayCoordinator({ directory, run: runOrca });
  let compatibility:
    ReturnType<typeof createExecutionCompatibility> | undefined;
  const engine = createOrcaRelay({
    authorizeLegacyExecution: (project, worktreeId, signal) =>
      compatibility!.authorizeLegacy(project, worktreeId, signal),
    databasePath: join(directory, "orca-relay.sqlite"),
    coordinatorHandle: coordinator.coordinatorHandle,
    resolveCoordinator: (runId) => recovery.resolve(runId),
    authorizeExecution: async (execution, project, worktreeId) => {
      progressStore.assertExecutionGeneration(
        execution.contextId,
        execution.generation,
      );
      if (!worktreeId) throw new Error("progress_checkout_required");
      const separator = worktreeId.indexOf("::");
      if (separator < 0) throw new Error("native_checkout_unknown");
      const actual = normalizeResourceAccesses([
        { resourceKey: worktreeId.slice(separator + 2), mode: "read" },
      ])[0]!.resourceKey;
      const held = progressStore
        .listExecutionReservations(execution.contextId)
        .filter(
          (r) =>
            r.requestId === execution.requestId &&
            r.generation === execution.generation &&
            r.state === "acquired",
        );
      if (
        !held.some(
          (r) =>
            r.resourceKey === actual || actual.startsWith(r.resourceKey + "/"),
        )
      )
        throw new Error("native_checkout_unreserved");
    },
    onUpdate: async (job) => {
      await progress?.notify(job);
      await service?.notify(job);
    },
  });
  compatibility = createExecutionCompatibility({
    store: progressStore,
    legacyJobs: () => engine.listActiveCached(),
  });
  const catalog = createProjectCatalog({
    directory,
    legacyRegistryPath: config.projectRegistryPath,
    defaultSensitivePaths: [".env", ".env.*", "**/*.pem"],
    isBusy: (id) => engine.isBusy(id),
  });
  const commands = createManagedCommands({
    catalog,
    jobs: engine,
    observe: (project, intent) => createOrcaObserver().observe(project, intent),
  });
  const locations = createProjectLocations();
  const tools = createAgentTools({
    catalog,
    execute: (input) => commands.execute(input),
    locations,
    listJobs: () => engine.listCached(),
  });
  const agentDirectory = join(directory, "agent-workspace");
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const client = createCodexSessionClient({
    cwd: agentDirectory,
    instructions: agentInstructions,
    tools: tools.specs,
  });
  const conversation = createAgentConversation({
    directory,
    client,
    tools,
    confirmProject: async (proposal) => {
      const path =
        proposal.mode === "create"
          ? await locations.create(proposal.path)
          : proposal.path;
      const project = await catalog.add(path);
      return {
        projectId: project.id,
        text: `${project.name}을 Orca에 등록했습니다. 경로: ${project.absolutePath}`,
      };
    },
  });
  const routerClient = createCodexSessionClient({
    cwd: agentDirectory,
    instructions: routerInstructions,
    tools: [],
  });
  progress = createProgressRuntime({
    store: progressStore,
    reservations: createExecutionReservations(progressStore),
    hasLegacyConflict: (resources) =>
      compatibility!.hasLegacyConflict(resources),
    router: createModelContextRouter(routerClient),
    catalog,
    execute: (input) => conversation.execute(input),
    readJobs: createObservedJobListReader(engine),
    getJob: (id) => engine.getCached(id),
    controlJob: (action, jobId, requestId, text) =>
      commands.execute({
        id: requestId,
        text:
          "/hq " +
          JSON.stringify(
            action === "guidance"
              ? { action: "jobs.followup", jobId, prompt: text }
              : {
                  action: action === "stop" ? "jobs.stop" : "jobs.show",
                  jobId,
                },
          ),
        source: "terminal",
        userId: "local",
      }),
  });
  const progressControl = createProgressControl(progress);
  try {
    await catalog.list();
    const previous = openDatabase(config.databasePath);
    const initialCursors: Partial<
      Record<"slack" | "telegram", string | number>
    > = {};
    try {
      if (
        previous
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_text_cursors'",
          )
          .get()
      ) {
        const rows = previous
          .prepare("SELECT channel,value_json FROM local_text_cursors")
          .all() as Array<{ channel: string; value_json: string }>;
        for (const row of rows)
          if (row.channel === "slack" || row.channel === "telegram")
            initialCursors[row.channel] = JSON.parse(row.value_json) as
              string | number;
      }
    } finally {
      previous.close();
    }
    service = await startManagedService({
      directory,
      databasePath: join(
        dirname(config.databasePath),
        "managed-control.sqlite",
      ),
      initialCursors,
      owner,
      progress: progressControl,
      beforeReady: async () => {
        await engine.start();
        await progress!.start();
      },
      getJob: (id) => engine.getCached(id),
      execute: (input) => conversation.execute(input),
      channelFactory: (ports) =>
        createLocalChannels({
          partialStart: true,
          slackAppToken: credentials["slack-app-token"],
          slackBotToken: credentials["slack-bot-token"],
          slackChannelId: credentials["slack-channel-id"],
          telegramBotToken: credentials["telegram-bot-token"],
          telegramChatId: credentials["telegram-allowed-chat-id"],
          ...ports,
        }),
    });
    return {
      async stop() {
        await Promise.all([client.close(), routerClient.close()]);
        await progress?.close();
        await service?.stop();
        await conversation.close();
        await engine.close();
        progressStore.close();
      },
    };
  } catch (e) {
    await Promise.all([client.close(), routerClient.close()]);
    await progress?.close();
    await service?.stop();
    await conversation.close();
    await engine.close();
    progressStore.close();
    throw e;
  }
}
