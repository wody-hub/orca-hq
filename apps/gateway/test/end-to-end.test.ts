import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalService,
  IdentityResolver,
  type ExecutionProposal,
  type PersistedApproval,
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

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw failure;
}

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

function executionProposal(commandId: string, riskLevel: "L0" | "L1" | "L2" | "L3"): ExecutionProposal {
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
  riskLevel: "L0" | "L1" | "L2" | "L3" = "L1",
  now: () => Date = () => new Date("2026-09-03T00:00:00.000Z")
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
    allowedOperations: ["L0", "L1", "L2", "L3"],
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
      gateway: {
        databasePath: join(directory, "control.sqlite"),
        shutdownDrainMs: 1_000,
        httpPort: 0,
        allowEphemeralHttpPortForTests: true,
        outboxPollMs: 10
      },
      projectRegistryPath,
      discoveredProjects: [{ orcaProjectId: "orca-sandbox", absolutePath: directory, approved: true }],
      assignmentArtifactRootDirectory: join(directory, "assignments"),
      outboxWorkerId: "gateway-e2e",
      completionDestinations: {
        slack: "C-HQ-COMPLETIONS",
        tailscaleWeb: "/commands/completed"
      },
      serveConfiguration: {
        funnelEnabled: false,
        publicExposure: false,
        gatewayBindAddress: "127.0.0.1",
        upstreamAddress: "127.0.0.1:0",
        httpsEnabled: true,
        advertisedHost: "hq.example.ts.net",
        expectedTailnetDnsSuffix: "example.ts.net"
      }
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
      slack: {
        async deliver(message) {
          deliveries.push((message.payload as { text: string }).text);
          return { providerMessageId: "slack-9001" };
        }
      },
      telegram: {
        async deliver(message) {
          return deliverTelegramMessage(message, {
            async send(input) {
              deliveries.push(input.text);
              return { messageId: 9001 };
            }
          });
        }
      },
      "tailscale-web": {
        async deliver(message) {
          deliveries.push((message.payload as { text: string }).text);
          return { providerMessageId: "tailscale-9001" };
        }
      }
    },
    dispatchControl: { async stop() { return true; }, async retry() { return true; } },
    now
  };
}

async function approvalRequest(
  composition: Awaited<ReturnType<typeof createProductionGateway>>,
  riskLevel: "L2" | "L3"
) {
  const commandId = `command-${riskLevel.toLowerCase()}`;
  composition.services.store.insertCommand({
    commandId,
    idempotencyKey: `test:${commandId}`,
    channel: "tailscale-web",
    externalMessageId: `dashboard:${commandId}`,
    principalId: "owner",
    receivedAt: "2026-09-03T00:00:00.000Z",
    text: "샌드박스 프로젝트 변경 승인"
  });
  const accepted = await composition.gateway.acceptCommand({
    commandId,
    channel: "tailscale-web",
    text: "샌드박스 프로젝트 변경 승인"
  });
  const approval = composition.services.store.listApprovals()[0];
  if (approval === undefined) throw new Error("approval request missing");
  return { accepted, approval };
}

async function confirmThroughDashboard(
  composition: Awaited<ReturnType<typeof createProductionGateway>>,
  approval: PersistedApproval,
  phrase?: string
) {
  const app = composition.services.httpApp;
  if (app === undefined) throw new Error("production HTTP app missing");
  const login = await app.inject({
    method: "POST",
    url: "/auth/session",
    headers: { "tailscale-user-login": "owner@example.test" }
  });
  const cookie = (login.headers["set-cookie"] as string).split(";")[0];
  return app.inject({
    method: "POST",
    url: `/api/approvals/${approval.request.approvalId}/confirm`,
    headers: {
      "tailscale-user-login": "owner@example.test",
      cookie,
      origin: "https://hq.tailnet.example",
      "x-csrf-token": login.headers["x-csrf-token"] as string,
      "idempotency-key": `approve:${approval.request.approvalId}:${phrase ?? "l2"}`
    },
    payload: {
      digest: approval.request.digest,
      ...(phrase === undefined ? {} : { phrase })
    }
  });
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

async function acceptDurableCommand(
  composition: Awaited<ReturnType<typeof createProductionGateway>>,
  channel: "slack" | "tailscale-web"
) {
  const commandId = `command-${channel}`;
  composition.services.store.insertCommand({
    commandId,
    idempotencyKey: `test:${commandId}`,
    channel,
    externalMessageId: `${channel}:501`,
    principalId: "owner",
    receivedAt: "2026-09-03T00:00:00.000Z",
    text: "샌드박스 프로젝트 테스트 수정해줘"
  });
  await composition.gateway.acceptCommand({ commandId, channel, text: "샌드박스 프로젝트 테스트 수정해줘" });
  return composition.services.store.listCommands().find((command) => command.commandId === commandId);
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
  it("keeps an L2 proposal waiting without a Dispatch and resumes it once from durable approval", async () => {
    // Break caught: production trusts a literal authorization capability and dispatches L2 before durable approval.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-e2e-l2-"));
    const orca = new FakeOrcaBoundary();
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      const host = await createGatewayHost(async () => boundaries(directory, orca, [], "L2"));
      composition = await createProductionGateway(host.config, host.dependencies);
      await composition.gateway.start();

      const { accepted, approval } = await approvalRequest(composition, "L2");
      expect(accepted).toEqual({ state: "waiting_approval" });
      expect(composition.services.store.listRunRecords()).toEqual([
        expect.objectContaining({ commandId: "command-l2", state: "waiting_approval" })
      ]);
      expect(composition.services.store.listTasks()).toEqual([]);
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(0);

      expect((await confirmThroughDashboard(composition, approval)).statusCode).toBe(200);
      expect(composition.services.store.findApproval(approval.request.approvalId)?.state).toBe("consumed");
      expect(composition.services.store.listRunRecords()).toEqual([
        expect.objectContaining({ commandId: "command-l2", state: "active" })
      ]);
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);

      expect((await confirmThroughDashboard(composition, approval)).statusCode).toBe(403);
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers the same approved proposal after a crash between approval consumption and execution", async () => {
    // Break caught: a consumed approval with a still-waiting durable Run is skipped forever on restart.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-e2e-approval-recovery-"));
    const firstOrca = new FakeOrcaBoundary();
    let first: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    let restarted: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      const firstHost = await createGatewayHost(async () => boundaries(directory, firstOrca, [], "L2"));
      first = await createProductionGateway(firstHost.config, firstHost.dependencies);
      await first.gateway.start();
      const { approval } = await approvalRequest(first, "L2");
      const service = new ApprovalService(first.services.store);
      expect(service.confirm(
        approval.request,
        owner,
        new Date("2026-09-03T00:00:00.000Z")
      ).kind).toBe("approved");
      expect(service.validate(
        approval.request.approvalId,
        approval.request.digest,
        new Date("2026-09-03T00:00:00.000Z")
      )).toEqual({ kind: "approved" });
      expect(first.services.store.findApproval(approval.request.approvalId)?.state).toBe("consumed");
      expect(first.services.store.listTasks()).toEqual([]);
      await first.gateway.stop();

      const restartedOrca = new FakeOrcaBoundary();
      const restartedHost = await createGatewayHost(async () => boundaries(directory, restartedOrca, [], "L2"));
      restarted = await createProductionGateway(restartedHost.config, restartedHost.dependencies);
      await restarted.gateway.start();

      expect(restarted.services.store.listRunRecords()).toEqual([
        expect.objectContaining({ commandId: "command-l2", state: "active" })
      ]);
      expect(restartedOrca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
      expect(restarted.services.store.findApproval(approval.request.approvalId)?.state).toBe("consumed");
    } finally {
      await restarted?.gateway.stop();
      await first?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps an L3 proposal stopped for a wrong phrase and resumes only for the exact phrase", async () => {
    // Break caught: a button click or arbitrary phrase creates an L3 Dispatch.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-e2e-l3-"));
    const orca = new FakeOrcaBoundary();
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      const host = await createGatewayHost(async () => boundaries(directory, orca, [], "L3"));
      composition = await createProductionGateway(host.config, host.dependencies);
      await composition.gateway.start();

      const { approval } = await approvalRequest(composition, "L3");
      expect((await confirmThroughDashboard(composition, approval, "APPROVE OTHER")).statusCode).toBe(403);
      expect(composition.services.store.findApproval(approval.request.approvalId)?.state).toBe("pending");
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(0);

      const exactPhrase = `APPROVE DEPLOY_PRODUCTION ${approval.request.digest.slice(0, 12).toUpperCase()}`;
      expect((await confirmThroughDashboard(composition, approval, exactPhrase)).statusCode).toBe(200);
      expect(composition.services.store.findApproval(approval.request.approvalId)?.state).toBe("consumed");
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an approval that expires before durable execution resumes", async () => {
    // Break caught: production confirms a stale digest and creates a Dispatch without revalidating its fixed expiry.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-e2e-expired-"));
    const orca = new FakeOrcaBoundary();
    let confirming = false;
    let confirmationClockReads = 0;
    const now = () => {
      if (!confirming) return new Date("2026-09-03T10:00:00.000Z");
      confirmationClockReads += 1;
      return new Date(confirmationClockReads === 1
        ? "2026-09-03T10:00:00.000Z"
        : "2026-09-03T10:15:00.000Z");
    };
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      const host = await createGatewayHost(async () => boundaries(directory, orca, [], "L2", now));
      composition = await createProductionGateway(host.config, host.dependencies);
      await composition.gateway.start();
      const { approval } = await approvalRequest(composition, "L2");

      confirming = true;
      expect((await confirmThroughDashboard(composition, approval)).statusCode).toBe(403);
      expect(composition.services.store.findApproval(approval.request.approvalId)?.state).toBe("expired");
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(0);
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
      await eventually(() => {
        expect(composition?.services.store.getOutbox("report-command-501:success")?.state)
          .toBe("delivered");
      });

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

  it.each([
    ["slack", "C-HQ-COMPLETIONS", "slack-9001"],
    ["tailscale-web", "/commands/completed", "tailscale-9001"]
  ] as const)(
    "commits and delivers a verified-success Outbox for %s with a configured destination",
    async (channel, destination, providerMessageId) => {
      // Break caught: resolving a configured non-Telegram destination can interrupt the durable verification commit.
      const directory = await mkdtemp(join(tmpdir(), `orca-production-e2e-${channel}-`));
      const deliveries: string[] = [];
      const orca = new FakeOrcaBoundary();
      let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
      try {
        const host = await createGatewayHost(async () => boundaries(directory, orca, deliveries));
        composition = await createProductionGateway(host.config, host.dependencies);
        await composition.gateway.start();
        const command = await acceptDurableCommand(composition, channel);
        if (command === undefined) throw new Error(`${channel} command missing`);
        const verificationTask = await completeImplementationAndVerifier(composition);

        await composition.services.execution.recordVerificationReport(reportFor(verificationTask, "pass"));
        await eventually(() => {
          expect(composition?.services.store.getOutbox("report-command-501:success")?.state)
            .toBe("delivered");
        });

        expect(composition.services.store.listRunRecords()).toEqual([
          expect.objectContaining({
            id: "run:proposal-command-501",
            commandId: command.commandId,
            state: "verified_success"
          })
        ]);
        expect(composition.services.store.listAuditEvents().map(({ eventType }) => eventType))
          .toContain("verification.passed");
        expect(composition.services.store.listOutbox()).toEqual([
          expect.objectContaining({
            id: "report-command-501:success",
            commandId: command.commandId,
            channel,
            destination,
            state: "delivered",
            providerMessageId
          })
        ]);
        expect(deliveries).toEqual(["검증 완료"]);
      } finally {
        await composition?.gateway.stop();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

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

  it("keeps verified evidence and audits an unresolved malformed Telegram delivery target", async () => {
    // Break caught: malformed Telegram externalMessageId throws before verified_success can be committed.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-e2e-unresolved-delivery-"));
    const orca = new FakeOrcaBoundary();
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      const host = await createGatewayHost(async () => boundaries(directory, orca, []));
      composition = await createProductionGateway(host.config, host.dependencies);
      await composition.gateway.start();
      composition.services.store.insertCommand({
        commandId: "command-malformed-telegram",
        idempotencyKey: "test:command-malformed-telegram",
        channel: "telegram",
        externalMessageId: "malformed",
        principalId: "owner",
        receivedAt: "2026-09-03T00:00:00.000Z",
        text: "샌드박스 프로젝트 테스트 수정해줘"
      });
      await composition.gateway.acceptCommand({
        commandId: "command-malformed-telegram",
        channel: "telegram",
        text: "샌드박스 프로젝트 테스트 수정해줘"
      });
      const verificationTask = await completeImplementationAndVerifier(composition);

      await expect(composition.services.execution.recordVerificationReport(
        reportFor(verificationTask, "pass")
      )).resolves.toMatchObject({ kind: "verified_success" });
      expect(composition.services.store.listRunRecords()).toEqual([
        expect.objectContaining({
          commandId: "command-malformed-telegram",
          state: "verified_success"
        })
      ]);
      expect(composition.services.store.listOutbox()).toEqual([]);
      expect(composition.services.store.listAuditEvents()).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "verification.passed" }),
        expect.objectContaining({
          eventType: "delivery_target_unresolved",
          data: expect.objectContaining({ reason: "invalid_external_message_id" })
        })
      ]));
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
