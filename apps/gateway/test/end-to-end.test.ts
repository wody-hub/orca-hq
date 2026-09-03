import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IdentityResolver,
  type ExecutionProposal,
  type PrincipalBinding
} from "@orca-hq/core";
import type { OrcaOperation, OrcaReceipt } from "@orca-hq/orca-adapter";
import { createLocalSessionService } from "@orca-hq/tailscale-adapter";
import {
  createTelegramAdapter,
  deliverTelegramMessage
} from "@orca-hq/telegram-adapter";
import type {
  DispatchRecord,
  VerificationReport,
  VerificationTask
} from "@orca-hq/worker-routing";
import { describe, expect, it } from "vitest";

import {
  createGatewayHost,
  type GatewayExternalBoundaries
} from "../src/host.js";
import { createProductionGateway } from "../src/production.js";

const owner: PrincipalBinding = {
  principalId: "owner",
  slackUserIds: [],
  telegramUserIds: ["10"],
  telegramChatIds: ["20"],
  tailscaleLoginNames: ["owner@example.test"],
  roles: ["owner"]
};

const verifierCommands = [{
  command: "pnpm test",
  exitCode: 0,
  outcome: "passed" as const,
  auditReference: "audit:verifier:test"
}];

function receipt(id: string, result: unknown): OrcaReceipt {
  return { id, ok: true, result };
}

class FakeOrcaBoundary {
  readonly calls: OrcaOperation[] = [];
  readonly #taskRuns = new Map<string, string>();
  readonly #dispatches = new Map<string, Readonly<{ taskId: string; runId: string }>>();
  #task = 0;
  #dispatch = 0;

  async health() {
    return { compatible: true } as never;
  }

  async execute(operation: OrcaOperation): Promise<OrcaReceipt> {
    this.calls.push(structuredClone(operation));
    switch (operation.kind) {
      case "create_run":
        return receipt("receipt-run", { runId: "orca-run-501" });
      case "create_task": {
        this.#task += 1;
        const taskId = `orca-task-${this.#task}`;
        this.#taskRuns.set(taskId, "orca-run-501");
        return receipt(`receipt-task-${this.#task}`, {
          taskId,
          runId: "orca-run-501",
          status: "ready"
        });
      }
      case "dispatch_worker": {
        this.#dispatch += 1;
        const dispatchId = `orca-dispatch-${this.#dispatch}`;
        const runId = this.#taskRuns.get(operation.taskId) ?? "orca-run-501";
        this.#dispatches.set(dispatchId, { taskId: operation.taskId, runId });
        return receipt(`receipt-dispatch-${this.#dispatch}`, {
          dispatchId,
          taskId: operation.taskId,
          runId,
          state: "ready",
          stage: "ready",
          setup: { state: "running" },
          effects: [],
          launch: {
            providerEnvironment: {
              kind: "verified_effective_allowlist",
              effectiveEnvironmentKeys: ["HOME", "PATH"]
            }
          }
        });
      }
      case "show_worker": {
        const binding = this.#dispatches.get(operation.dispatchId);
        if (binding === undefined) throw new Error("unknown fake dispatch");
        return receipt(`receipt-show-${operation.dispatchId}`, {
          dispatch: {
            id: operation.dispatchId,
            task_id: binding.taskId,
            run_id: binding.runId,
            status: "dispatched"
          },
          worker: {
            dispatch_id: operation.dispatchId,
            state: "ready",
            stage: "ready",
            agent_terminal_handle: `terminal-${operation.dispatchId}`
          },
          terminal: null,
          observation: { status: "ready", exactWorker: true },
          terminalResource: {
            id: `terminal-${operation.dispatchId}`,
            ownershipState: "owned",
            releaseState: "active"
          }
        });
      }
      case "read_worker":
        return receipt(`receipt-read-${operation.dispatchId}`, {
          dispatchId: operation.dispatchId,
          source: "transcript",
          cursor: "cursor-1",
          status: { worker: "ready", terminal: "running" },
          transcript: {
            messages: [],
            limited: false,
            nextCursor: "cursor-1",
            returnedMessageCount: 0
          },
          warnings: [],
          archived: false
        });
      case "release_worker":
        return receipt(`receipt-release-${operation.dispatchId}`, {
          dispatchId: operation.dispatchId,
          state: "released",
          verdict: "released"
        });
      case "stop_worker":
        return receipt(`receipt-stop-${operation.dispatchId}`, {
          dispatchId: operation.dispatchId,
          state: "stopped",
          verdict: "stopped"
        });
      case "list_projects":
        return receipt("receipt-projects", { repos: [] });
    }
  }
}

function executionProposal(commandId: string, riskLevel: "L0" | "L1"): ExecutionProposal {
  return {
    proposalId: "proposal-command-501",
    commandId,
    selectedProjectKey: "sandbox",
    routeCandidates: [{ projectKey: "sandbox", score: 1, evidence: ["alias:sandbox"] }],
    baseRef: "main",
    allowedScope: ["src/**"],
    prohibitedEffects: ["push", "deployment", "secret access"],
    acceptanceCommands: ["pnpm test"],
    riskLevel,
    tasks: [{
      localId: riskLevel === "L0" ? "investigate" : "implement",
      title: riskLevel === "L0" ? "요청 조사" : "요청 구현",
      dependsOn: [],
      role: riskLevel === "L0" ? "investigate" : "implement",
      preferredAgent: "codex"
    }]
  };
}

function reportFor(task: VerificationTask, verdict: "pass" | "fail"): VerificationReport {
  return {
    reportId: verdict === "pass" ? "report-command-501" : "report-command-501-failed",
    runId: task.runId,
    verificationTaskId: task.taskId,
    implementationTaskId: task.implementationTaskId,
    implementationDispatchId: task.implementationDispatchId,
    cycle: task.cycle,
    verdict,
    projectRoute: task.projectRoute,
    changedFiles: task.changedFiles,
    diffSha256: task.gitDiff.sha256,
    diffSummary: task.gitDiff.summary,
    commands: verifierCommands,
    implementationProvider: task.implementationProvider,
    verifierProvider: task.preferredAgent,
    findings: verdict === "pass" ? [] : ["acceptance behavior is incomplete"],
    evidence: ["audit:verifier:test"],
    auditReferences: [...task.auditReferences, "audit:verifier:test"],
    verifierEffects: {
      filesModified: false,
      committed: false,
      pushed: false,
      pullRequestChanged: false,
      merged: false,
      deployed: false,
      secretsAccessed: false,
      productionAccessed: false
    }
  };
}

function boundaries(
  directory: string,
  orca: FakeOrcaBoundary,
  deliveries: string[],
  riskLevel: "L0" | "L1" = "L1"
): GatewayExternalBoundaries {
  const head = "a".repeat(40);
  const project = {
    projectKey: "sandbox",
    orcaProjectId: "orca-sandbox",
    repoId: "repo-sandbox",
    absolutePath: directory,
    aliases: ["sandbox"],
    component: "backend",
    defaultBaseRef: "main",
    instructionsFiles: [],
    setupPolicy: "run",
    allowedOperations: ["L0", "L1"],
    requiredChecks: ["pnpm test"],
    sensitivePaths: [".env"],
    lockKey: "sandbox"
  } as const;
  const projectRegistryPath = join(directory, "projects.yaml");
  writeFileSync(
    projectRegistryPath,
    `projects:\n${JSON.stringify([project], null, 2).replace(/^/gm, "  ")}`,
    "utf8"
  );
  return {
    settings: {
      gateway: { databasePath: join(directory, "control.sqlite"), shutdownDrainMs: 1_000 },
      projectRegistryPath,
      discoveredProjects: [{ orcaProjectId: "orca-sandbox", absolutePath: directory, approved: true }],
      assignmentArtifactRootDirectory: join(directory, "assignments"),
      outboxWorkerId: "gateway-e2e"
    },
    secrets: { async validate() {} },
    orca,
    proposalModel: {
      async plan(command) {
        return { kind: "proposal", proposal: executionProposal(command.commandId, riskLevel) };
      }
    },
    git: {
      async repositoryStatus() { return { dirty: false, head, branch: "main" }; },
      async resolveRevision() { return head; },
      async branchOccupancy() { return []; },
      async pathExists() { return false; },
      async createWorktree() {}
    },
    verificationEvidence: {
      collectImplementation() {
        return {
          changedFiles: ["src/feature.ts"],
          gitDiff: { sha256: "b".repeat(64), summary: "1 file changed" },
          testReceipts: [{
            command: "pnpm test",
            exitCode: 0,
            outcome: "passed" as const,
            auditReference: "audit:implementation:test"
          }],
          auditReferences: ["audit:implementation:dispatch"]
        };
      },
      collectVerifierCommands() {
        return verifierCommands;
      },
      captureRepositorySnapshot({ dispatch, phase }) {
        const durable = dispatch as DispatchRecord;
        return {
          repositoryPath: durable.assignment.repo.repositoryPath,
          worktreePath: durable.assignment.worktree.path,
          worktreeKind: durable.assignment.worktree.kind,
          head: durable.assignment.worktree.head,
          branch: durable.assignment.worktree.branch,
          statusSha256: "c".repeat(64),
          diffSha256: "b".repeat(64),
          auditReference: phase === "before_verifier"
            ? "audit:repository:before"
            : "audit:repository:after"
        };
      }
    },
    httpOptions: {
      bindings: [owner],
      resolver: new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] }),
      sessions: createLocalSessionService({ signingKey: new Uint8Array(32).fill(1) }),
      peerAddress: () => "127.0.0.1",
      allowedOrigin: "https://hq.tailnet.example",
      csrfSigningKey: new Uint8Array(32).fill(2)
    },
    slack: { async start() {}, async stopIngress() {} },
    telegram: { async start() {}, async stopIngress() {} },
    transactions: { async drain() {} },
    outboundProviders: {
      telegram: {
        async deliver(message) {
          return deliverTelegramMessage(message, {
            async send(input) {
              deliveries.push(input.text);
              return { messageId: 9001 };
            }
          });
        }
      }
    },
    dispatchControl: { async stop() { return true; }, async retry() { return true; } },
    now: () => new Date("2026-09-03T00:00:00.000Z")
  };
}

async function acceptTelegram501(
  composition: Awaited<ReturnType<typeof createProductionGateway>>
) {
  const adapter = createTelegramAdapter({ botIdentity: "bot", maxVoiceBytes: 1_000 }, {
    ingress: composition.services.store,
    identities: new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] }),
    cursorStore: { async load() { return undefined; }, async save() {} },
    outbox: { async enqueue() {} },
    approvalPort: { async request() {} }
  });
  await adapter.handleUpdate({
    update_id: 501,
    message: {
      message_id: 501,
      date: 1_788_220_800,
      from: { id: 10 },
      chat: { id: 20 },
      text: "샌드박스 프로젝트 테스트 수정해줘"
    }
  });
  const command = composition.services.store.listCommands().find(({ externalMessageId }) =>
    externalMessageId === "20:501"
  );
  if (command === undefined) throw new Error("normalized command 501 missing");
  await composition.gateway.acceptCommand({
    commandId: command.commandId,
    channel: "telegram",
    text: command.text
  });
  return command;
}

async function completeImplementationAndVerifier(
  composition: Awaited<ReturnType<typeof createProductionGateway>>
): Promise<VerificationTask> {
  const implementation = composition.services.store.listTasks().find(({ role }) => role === "implement");
  if (implementation === undefined) throw new Error("implementation Task missing");
  const implementationDispatch = composition.services.store.loadDispatchesForTask(implementation.id)[0] as DispatchRecord | undefined;
  if (implementationDispatch?.orcaDispatchId === undefined) throw new Error("implementation Dispatch missing");
  await composition.services.execution.recordWorkerMessage({
    kind: "worker_done",
    messageId: "worker-command-501-done",
    dispatchId: implementationDispatch.orcaDispatchId,
    outcome: "completed",
    summary: "implementation complete"
  });
  const verifier = composition.services.store.listTasks().find(({ role }) => role === "verify");
  const verificationTask = verifier?.payload as VerificationTask | undefined;
  if (verifier === undefined || verificationTask === undefined) throw new Error("verifier Task missing");
  const verifierDispatch = composition.services.store.loadDispatchesForTask(verifier.id)[0] as DispatchRecord | undefined;
  if (verifierDispatch?.orcaDispatchId === undefined) throw new Error("verifier Dispatch missing");
  await composition.services.execution.recordWorkerMessage({
    kind: "worker_done",
    messageId: "verifier-command-501-done",
    dispatchId: verifierDispatch.orcaDispatchId,
    outcome: "completed",
    summary: "verification complete"
  });
  return verificationTask;
}

describe("Gateway production state machine E2E", () => {
  it("moves Telegram message 501 through worker, verifier and a delivered verified-success Outbox", async () => {
    // Break caught: a fake command flow can directly insert verified_success, Dispatches, or the expected delivery text.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-e2e-pass-"));
    const deliveries: string[] = [];
    const orca = new FakeOrcaBoundary();
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      const host = await createGatewayHost(async () => boundaries(directory, orca, deliveries));
      composition = await createProductionGateway(host.config, host.dependencies);
      await composition.gateway.start();
      const command = await acceptTelegram501(composition);
      const verificationTask = await completeImplementationAndVerifier(composition);
      await composition.services.execution.recordVerificationReport(reportFor(verificationTask, "pass"));
      await composition.services.outbox.tick("2026-09-03T00:00:00.000Z");

      expect(composition.services.store.listRunRecords()).toEqual([
        expect.objectContaining({
          id: "run:proposal-command-501",
          commandId: command.commandId,
          state: "verified_success"
        })
      ]);
      expect(composition.services.store.listTasks().map(({ id, role, state }) => ({ id, role, state })))
        .toEqual([
          { id: "task:proposal-command-501:implement", role: "implement", state: "worker_done" },
          { id: "task:proposal-command-501:implement:verify:0", role: "verify", state: "verified_success" }
        ]);
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(2);
      expect(composition.services.store.listOutbox()).toEqual([
        expect.objectContaining({
          id: "report-command-501:success",
          commandId: command.commandId,
          channel: "telegram",
          destination: "20",
          template: "success",
          state: "delivered",
          providerMessageId: "9001"
        })
      ]);
      expect(composition.services.store.listAuditEvents().map(({ eventType }) => eventType))
        .toContain("verification.passed");
      expect(deliveries).toEqual(["검증 완료"]);
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps failed verifier evidence durable and blocks verified success delivery", async () => {
    // Break caught: verifier failure can still mark the Run successful or enqueue the same success message.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-e2e-fail-"));
    const deliveries: string[] = [];
    const orca = new FakeOrcaBoundary();
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      const host = await createGatewayHost(async () => boundaries(directory, orca, deliveries));
      composition = await createProductionGateway(host.config, host.dependencies);
      await composition.gateway.start();
      await acceptTelegram501(composition);
      const verificationTask = await completeImplementationAndVerifier(composition);
      await composition.services.execution.recordVerificationReport(reportFor(verificationTask, "fail"));
      await composition.services.outbox.tick("2026-09-03T00:00:00.000Z");

      expect(composition.services.store.listRunRecords()).toEqual([
        expect.objectContaining({ id: "run:proposal-command-501", state: "active" })
      ]);
      expect(composition.services.store.listTasks()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "task:proposal-command-501:implement:verify:0",
          state: "verification_failed"
        })
      ]));
      expect(composition.services.store.listAuditEvents().map(({ eventType }) => eventType))
        .toContain("verification.failed");
      expect(composition.services.store.listOutbox()).toEqual([]);
      expect(deliveries).toEqual([]);
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the real L0 investigation path without creating an approval or verifier", async () => {
    // Break caught: L0 is dead code or requires a fabricated approval before ExecutionService starts.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-e2e-l0-"));
    const deliveries: string[] = [];
    const orca = new FakeOrcaBoundary();
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      const host = await createGatewayHost(async () => boundaries(directory, orca, deliveries, "L0"));
      composition = await createProductionGateway(host.config, host.dependencies);
      await composition.gateway.start();
      await acceptTelegram501(composition);
      const investigation = composition.services.store.listTasks().find(({ role }) => role === "investigate");
      if (investigation === undefined) throw new Error("investigation Task missing");
      const dispatch = composition.services.store.loadDispatchesForTask(investigation.id)[0] as DispatchRecord | undefined;
      if (dispatch?.orcaDispatchId === undefined) throw new Error("investigation Dispatch missing");
      await composition.services.execution.recordWorkerMessage({
        kind: "worker_done",
        messageId: "investigation-command-501-done",
        dispatchId: dispatch.orcaDispatchId,
        outcome: "completed",
        summary: "investigation complete"
      });

      expect(composition.services.store.listApprovals()).toEqual([]);
      expect(composition.services.store.listRunRecords()).toEqual([
        expect.objectContaining({ id: "run:proposal-command-501", state: "investigation_complete" })
      ]);
      expect(composition.services.store.listTasks().map(({ role }) => role)).toEqual(["investigate"]);
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
      expect(composition.services.store.listOutbox()).toEqual([]);
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
