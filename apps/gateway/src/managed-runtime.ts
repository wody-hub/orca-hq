import { OperationsOrca } from "./operations-orca.js";
import { selectOrcaCliExecutable } from "./managed-projects.js";
import { createHash } from "node:crypto";
import type { ManagedCommandInput, CommandProject } from "./managed-commands.js";
import type { ProgressStore } from "./progress-store.js";
import type { NativeRetentionPolicy } from "./native-launch.js";
import { createNativeCoordinator, type NativeCoordinatorRelay } from "./native-coordinator.js";
import { createWorkerAdmission, type WorkerAdmission, type WorkerLimit } from "./worker-admission.js";
import { createNativeWorkPlanner } from "./native-work-planner.js";
import type { ProgressRuntimeOptions } from "./progress-runtime.js";
import { readFile, mkdir } from "node:fs/promises";
import { openDatabase } from "@orca-hq/persistence";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parsePilotConfigText, pilotConfigurationPath, type LaunchProfile, type PilotConfig } from "@orca-hq/core";
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

/**
 * Parse the admission limit at the env-var boundary so a typo names the variable and its accepted
 * values instead of surfacing the constructor's anonymous `maxActiveWorkers` TypeError at boot.
 */
export function parseMaxActiveWorkers(raw: string | undefined): WorkerLimit {
  if (raw === undefined || raw.trim() === "") return 10;
  const value = raw.trim();
  if (value === "unlimited") return "unlimited";
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0)
    throw new TypeError(`HQ_MAX_ACTIVE_WORKERS="${raw}" is not usable: set a positive whole number (for example 10) or "unlimited".`);
  return parsed;
}

/** The profile set an installed config without `nativeExecution.roleProfiles` keeps running on. */
export const defaultNativeRoleProfiles: Readonly<Record<string, LaunchProfile>> = Object.freeze({
  primary: { agent: "codex", model: "gpt-5.6-sol", effort: "high", reason: "HQ substantive work in the existing project checkout" }
});

export interface NativeExecutionSettings {
  readonly maxActiveWorkers: WorkerLimit;
  readonly retentionPolicy: NativeRetentionPolicy;
  readonly profiles: Readonly<Record<string, LaunchProfile>>;
}

/**
 * Resolves what the installed runtime actually runs on from the parsed config file, with the
 * env var kept only as an operator override for hosts where editing the file is impractical.
 * Precedence is deliberately one-directional: a value present in the config file always wins, and
 * `HQ_MAX_ACTIVE_WORKERS` is consulted only where the file left the limit unset.
 */
export function resolveNativeExecutionSettings(
  config: Pick<PilotConfig, "nativeExecution">,
  env: Readonly<Partial<Record<"HQ_MAX_ACTIVE_WORKERS", string>>> = process.env
): NativeExecutionSettings {
  const native = config.nativeExecution;
  return {
    maxActiveWorkers: native?.maxActiveWorkers ?? parseMaxActiveWorkers(env.HQ_MAX_ACTIVE_WORKERS),
    retentionPolicy: native?.retentionPolicy ?? "retain",
    profiles: native?.roleProfiles ?? defaultNativeRoleProfiles
  };
}

export function resolveOperationsCapacity(config: Pick<PilotConfig, "nativeExecution">, env: Readonly<Partial<Record<"HQ_MAX_ACTIVE_WORKERS", string>>>) {
  const { maxActiveWorkers: limit } = resolveNativeExecutionSettings(config, env);
  const source = config.nativeExecution?.maxActiveWorkers !== undefined ? "config" as const : env.HQ_MAX_ACTIVE_WORKERS?.trim() ? "environment" as const : "default" as const;
  return { limit, source };
}

/** Native composition shared by installed channels and isolated integration fixtures. */
export function createManagedNativeRuntime(options: {
  store: ProgressStore; admission: WorkerAdmission; relay: NativeCoordinatorRelay;
  catalog: { list(): Promise<CommandProject[]>; resolve(id: string): Promise<CommandProject> };
  router: ProgressRuntimeOptions["router"]; retentionPolicy: NativeRetentionPolicy;
  /** Role launch profiles, keyed by role name; defaults to a single codex "primary" when omitted
   * (an installed config without `nativeExecution.roleProfiles` keeps today's behavior). */
  profiles?: Readonly<Record<string, LaunchProfile>>;
  /** The only `/hq ` command surface. There is deliberately no conversational execute path here. */
  commands?: { execute(input: ManagedCommandInput): Promise<ManagedCommandResult> };
  hasLegacyConflict?: ProgressRuntimeOptions["hasLegacyConflict"];
  legacyGetJob?: ProgressRuntimeOptions["getJob"];
  legacyReadJobs?: ProgressRuntimeOptions["readJobs"];
  stopJob?: (id: string) => Promise<CommandJob>;
  pollMs?: number;
}) {
  const profiles = options.profiles ?? defaultNativeRoleProfiles;
  const primary = profiles.primary;
  if (!primary) throw new Error("native_profile_primary_required");
  const planner = createNativeWorkPlanner({ profiles });
  const native = createNativeCoordinator({ store: options.store, admission: options.admission, relay: options.relay,
    retentionPolicy: options.retentionPolicy, ...(options.hasLegacyConflict ? { hasLegacyConflict: options.hasLegacyConflict } : {}), ...(options.pollMs ? { pollMs: options.pollMs } : {}),
    planner: { async plan(input) {
      if (!input.execution) throw Error("native_admission_required");
      const context = options.store.getContext(input.execution.contextId);
      if (!context?.projectIds.length) throw Error("native_project_required");
      const projects = await Promise.all(context.projectIds.map(id => options.catalog.resolve(id)));
      if (projects.some(p => !p.enabled)) throw Error("native_project_disabled");
      let scope = input.nativeScope;
      // A declared scope is a narrowing claim. Resolve its selector through the catalog (aliases
      // included) and fail closed: an unmatched or only partially covering scope must never be
      // widened back into a write claim on every checkout in the context.
      if (scope) {
        const scoped = await options.catalog.resolve(scope.projectId).catch(() => undefined);
        if (!scoped || !projects.some(p => p.id === scoped.id)) throw Error("native_scope_project_mismatch");
        if (projects.some(p => p.id !== scoped.id)) throw Error("native_scope_project_uncovered");
        scope = { ...scope, projectId: scoped.id };
      }
      const attempts = projects.map(project => {
        const prior = options.admission.listAttempts().filter(a => a.item.contextId === context.contextId && a.item.projectId === project.id && a.item.worktreeId === (scope?.projectId === project.id ? scope.worktreeId : `${project.id}::${project.absolutePath}`) && a.item.profile.agent === primary.agent && a.item.profile.model === primary.model && a.item.profile.effort === primary.effort && a.state === "settled" && a.resourceVerdict === "retained_idle").at(-1);
        return { attemptId: "attempt_" + createHash("sha256").update(JSON.stringify([input.id, project.id])).digest("hex"), projectId: project.id,
          ...(prior?.receipt ? { resumeTerminalHandle: prior.receipt.terminalHandle } : {}) };
      });
      return planner.plan({ context: { requestId: input.execution.requestId, contextId: context.contextId, generation: input.execution.generation }, attempts,
        projects: projects.map(p => {
          const selected = scope?.projectId === p.id ? scope : undefined;
          const worktreeId = selected?.worktreeId ?? `${p.id}::${p.absolutePath}`;
          return { projectId: p.id, worktreeId, checkoutResourceKey: `checkout:${worktreeId.slice(worktreeId.indexOf("::") + 2)}`, resources: selected?.resources ?? [{ resourceKey: `checkout:${p.absolutePath}`, mode: "write" as const }] };
        }),
        proposedItems: attempts.map(a => ({ attemptId: a.attemptId, objective: `${input.text}\n\n이전 업무 요약: ${context.summary || "없음"}`, access: scope?.projectId === a.projectId ? scope.access : "write", resources: scope?.projectId === a.projectId ? scope.resources : [{ resourceKey: `checkout:${projects.find(p => p.id === a.projectId)!.absolutePath}`, mode: "write" }], dependsOn: [], profileKey: "primary" })) });
    } }
  });
  const progress = createProgressRuntime({ store: options.store, reservations: createExecutionReservations(options.store),
    router: options.router, catalog: options.catalog, nativeExecution: true,
    execute: input => native.execute(input),
    getJob: id => native.getJob(id) ?? options.legacyGetJob?.(id),
    readJobs: async requestId => {
      const jobs = native.listJobs();
      const legacy = await options.legacyReadJobs?.(requestId);
      return { text: [...jobs.map(formatManagedJob), legacy?.text].filter(Boolean).join("\n\n") || "저장된 Orca 작업이 없습니다." };
    },
    pendingNativeQuestions: () => native.pendingQuestions(),
    answerNativeQuestion: (id, text, requestId) => native.answerQuestion(id, text, requestId),
    controlJob: async (action, jobId, requestId, text) => {
      if (action === "guidance") return native.guidance(jobId, text, requestId);
      if (action === "stop") {
        if (native.getJob(jobId)) return native.stop(jobId);
        if (!options.stopJob) throw Error("native_stop_unavailable");
        const job = await options.stopJob(jobId); return { text: formatManagedJob(job), jobId };
      }
      const job = native.getJob(jobId) ?? await options.legacyGetJob?.(jobId);
      if (!job) throw Error("native_job_not_found"); return { text: formatManagedJob(job), jobId };
    }, ...(options.pollMs ? { pollMs: options.pollMs } : {})
  });
  /**
   * Every channel execute path the managed service exposes, in one place: `/hq ` goes to the command
   * surface and all other text goes to native admission. A conversational fallback would have to be
   * added here, which is what the composition test asserts is absent.
   */
  const execute = (input: ManagedCommandInput): Promise<ManagedCommandResult> =>
    input.text.startsWith("/hq ") && options.commands ? options.commands.execute(input) : progress.executeLegacy(input);
  return { native, progress, execute };
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
  let native: ReturnType<typeof createNativeCoordinator> | undefined;
  const { maxActiveWorkers, retentionPolicy, profiles } = resolveNativeExecutionSettings(config, process.env);
  const admission = createWorkerAdmission({ store: progressStore, maxActiveWorkers });
  let service: Awaited<ReturnType<typeof startManagedService>> | undefined;
  const coordinator = z
    .object({ coordinatorHandle: z.string().startsWith("term_") })
    .passthrough()
    .parse(
      JSON.parse(
        await readFile(join(directory, "relay-coordinator.json"), "utf8"),
      ),
    );
  const recovery = createRelayCoordinator({ directory, run: runOrca, assertActive: () => admission.heartbeat() });
  let compatibility:
    ReturnType<typeof createExecutionCompatibility> | undefined;
  const engine = createOrcaRelay({
    nativeOnly: true,
    nativeAdmission: admission,
    nativeRetentionPolicy: retentionPolicy,
    assertNativeCoordinator: () => admission.heartbeat(),
    resolveNativeProject: id => catalog.resolve(id),
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
      if (native?.getJob(job.id)) return;
      await progress?.notify(job);
      await service?.notify(job);
    },
  });
  compatibility = createExecutionCompatibility({
    store: progressStore,
    legacyJobs: () => engine.listActiveCached().filter(job => !admission.listAttempts().some(a => a.receipt?.taskId === job.id)),
  });
  const catalog = createProjectCatalog({
    directory,
    legacyRegistryPath: config.projectRegistryPath,
    defaultSensitivePaths: [".env", ".env.*", "**/*.pem"],
    isBusy: (id) => engine.isBusy(id),
  });
  const commands = createManagedCommands({
    catalog,
    jobs: { ...engine, get: id => native?.getJob(id) ?? engine.get(id), list: async () => [...(native?.listJobs() ?? []), ...await engine.list()],
      stop: async id => { if (native?.getJob(id)) { await native.stop(id); return native.getJob(id)!; } return engine.stop(id); }
    },
    nativeExecute: async (input, action) => {
      const prior = action.job && admission.listAttempts().find(a => a.receipt?.taskId === action.job!.id);
      if (action.kind === "followup" && prior?.state === "active") return native!.guidance(action.job!.id, action.prompt, input.id);
      if (action.kind === "retry" && (!action.job || !["failed", "stopped"].includes(action.job.state))) throw Error("native_retry_requires_settled_failure");
      if (prior && prior.state !== "settled") throw Error("native_previous_attempt_unsettled");
      const worktreeId = action.worktree ?? prior?.item.worktreeId ?? `${action.project.id}::${action.project.absolutePath}`;
      const nativeScope = input.nativeScope ?? { projectId: action.project.id, worktreeId, access: action.kind === "review" ? "read" as const : prior?.item.access ?? "write" as const,
        resources: prior?.item.resources ?? [{ resourceKey: `checkout:${worktreeId.slice(worktreeId.indexOf("::") + 2)}`, mode: action.kind === "review" ? "read" as const : "write" as const }] };
      return progress!.executeLegacy({ ...input, nativeScope,
        text: prior ? `/context ${prior.item.contextId} ${action.prompt}` : `${action.project.id} ${action.prompt}` });
    },
    observe: (project, intent) => createOrcaObserver().observe(project, intent),
  });
  const locations = createProjectLocations();
  const tools = createAgentTools({
    catalog,
    nativeExecution: true,
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
  const composition = createManagedNativeRuntime({
    store: progressStore, admission, relay: engine, catalog, commands,
    router: createModelContextRouter(routerClient), retentionPolicy, profiles,
    hasLegacyConflict: resources => compatibility!.hasLegacyConflict(resources),
    legacyGetJob: id => { try { return engine.getCached(id); } catch { return undefined; } },
    legacyReadJobs: createObservedJobListReader(engine), stopJob: id => engine.stop(id)
  });
  progress = composition.progress;
  native = composition.native;
  const progressControl = createProgressControl(progress);
  const operationsAbort = new AbortController();
  const operationsOrca = new OperationsOrca({ executablePath: selectOrcaCliExecutable(), signal: operationsAbort.signal });
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
      operations: {
        store: progressStore,
        submit: input => progress!.submit(input),
        orca: operationsOrca,
        capacity: { ...resolveOperationsCapacity(config, process.env), snapshot: () => admission.snapshot(), attempts: () => admission.listAttempts() }
      },
      beforeReady: async () => {
        await engine.start();
        await native!.start();
        await progress!.start();
      },
      getJob: (id) => engine.getCached(id),
      execute: (input) => composition.execute(input),
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
        operationsAbort.abort();
        await Promise.all([client.close(), routerClient.close()]);
        await native?.close();
        await progress?.close();
        await service?.stop();
        await conversation.close();
        await engine.close();
        progressStore.close();
      },
    };
  } catch (e) {
    operationsAbort.abort();
    await Promise.all([client.close(), routerClient.close()]);
    await native?.close();
    await progress?.close();
    await service?.stop();
    await conversation.close();
    await engine.close();
    progressStore.close();
    throw e;
  }
}
