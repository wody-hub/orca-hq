import { createHash } from "node:crypto";

import {
  CODEX_HQ_MODEL,
  CodexHqSession,
  CodexPortError,
  type CodexTurnRequest,
  type HqQueueTerminalRecord
} from "@orca-hq/codex-hq";
import type { CommandEnvelope, ExecutionProposal } from "@orca-hq/core";
import type { OrcaOperation, OrcaReceipt } from "@orca-hq/orca-adapter";
import { ControlStore, openDatabase } from "@orca-hq/persistence";
import type { ProjectRegistryEntry } from "@orca-hq/project-registry";
import {
  ExecutionLifecycle,
  ExecutionService,
  VerificationService,
  type AssignmentArtifact,
  type AssignmentArtifactReference,
  type AssignmentArtifactStageInput,
  type AssignmentArtifactStore,
  type ReadyWorktreePlacement,
  type VerificationCommit,
  type VerificationInput,
  type VerificationReport,
  type VerificationTask,
  type WorkerProviderId
} from "@orca-hq/worker-routing";

function receipt(id: string, result: unknown): OrcaReceipt {
  return { id, ok: true, result };
}

export class LaunchOrca {
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
        return receipt("receipt-run", { runId: "orca-run-1" });
      case "create_task": {
        const taskId = `orca-task-${++this.#task}`;
        this.#taskRuns.set(taskId, "orca-run-1");
        return receipt(`receipt-task-${this.#task}`, { taskId, runId: "orca-run-1", status: "ready" });
      }
      case "dispatch_worker": {
        const dispatchId = `orca-dispatch-${++this.#dispatch}`;
        const runId = this.#taskRuns.get(operation.taskId) ?? "orca-run-1";
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
        if (binding === undefined) throw new Error("unknown scripted Dispatch");
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
      case "stop_worker":
        return receipt(`receipt-stop-${operation.dispatchId}`, {
          dispatchId: operation.dispatchId,
          state: "stopped",
          verdict: "stopped"
        });
      case "release_worker":
        return receipt(`receipt-release-${operation.dispatchId}`, {
          dispatchId: operation.dispatchId,
          state: "released",
          verdict: "released"
        });
      case "list_projects":
        return receipt("receipt-projects", { repos: [] });
    }
  }
}

export class MemoryAssignmentArtifacts implements AssignmentArtifactStore {
  referenceFor(taskId: string): AssignmentArtifactReference {
    const digest = createHash("sha256").update(taskId).digest("hex");
    return Object.freeze({
      protocol: 1,
      artifactId: `assignment:${digest}`,
      path: `/tmp/orca-pilot-assignment-${digest}.json`
    });
  }

  async stage(input: AssignmentArtifactStageInput): Promise<AssignmentArtifact> {
    return Object.freeze({
      ...input.reference,
      version: input.version,
      ownerDispatchId: input.ownerDispatchId,
      content: input.content,
      sha256: createHash("sha256").update(input.content).digest("hex")
    });
  }

  async cleanup(): Promise<"removed"> {
    return "removed";
  }
}

const launchProject: ProjectRegistryEntry = {
  projectKey: "pilot-launch",
  orcaProjectId: "orca-pilot-launch",
  repoId: "repo-pilot-launch",
  absolutePath: "/tmp/orca-pilot-launch",
  aliases: ["pilot launch"],
  component: "backend",
  defaultBaseRef: "main",
  instructionsFiles: [],
  setupPolicy: "run",
  allowedOperations: ["L0"],
  requiredChecks: ["pnpm test"],
  sensitivePaths: [],
  lockKey: "pilot-launch"
};

const launchProposal: ExecutionProposal = {
  proposalId: "pilot-launch",
  commandId: "pilot-launch-command",
  selectedProjectKey: launchProject.projectKey,
  routeCandidates: [{ projectKey: launchProject.projectKey, score: 1, evidence: ["scripted:launch"] }],
  baseRef: "main",
  allowedScope: ["src/**"],
  prohibitedEffects: ["write", "push", "deployment", "secret access"],
  acceptanceCommands: ["pnpm test"],
  riskLevel: "L0",
  tasks: [{
    localId: "investigate",
    title: "Inspect scripted launch",
    dependsOn: [],
    role: "investigate",
    preferredAgent: "codex"
  }]
};

function launchPlacement(): ReadyWorktreePlacement {
  return Object.freeze({
    kind: "ready",
    repositoryPath: launchProject.absolutePath,
    baseRef: "main",
    baseCommit: "a".repeat(40),
    worktree: Object.freeze({
      kind: "existing-read-only",
      path: launchProject.absolutePath,
      branch: "main",
      head: "a".repeat(40)
    }),
    permissions: "read-only",
    requiresEditingLease: false
  });
}

async function exerciseLaunchFailures(failures: 1 | 2) {
  const database = openDatabase(":memory:");
  try {
    const store = new ControlStore(database);
    store.insertCommand({
      commandId: launchProposal.commandId,
      idempotencyKey: "pilot:launch-command",
      channel: "slack",
      externalMessageId: "pilot-launch-message",
      principalId: "owner",
      receivedAt: "2026-09-04T00:00:00.000Z",
      text: "Inspect scripted launch"
    });
    const orca = new LaunchOrca();
    const service = new ExecutionService({
      orca,
      placements: {
        async resolve() { return launchPlacement(); },
        async createWorktree(placement) { return placement; }
      },
      locks: {
        acquire() { return { kind: "acquired" }; },
        release() { return { kind: "released" }; }
      },
      lifecycle: new ExecutionLifecycle({ store }),
      assignmentArtifacts: new MemoryAssignmentArtifacts(),
      providerCapabilities: {
        codex: { worker: "available", hq: "available" },
        claude: { worker: "available", hq: "unavailable" },
        providerChildEnvironmentIsolation: {
          kind: "verified_effective_allowlist",
          effectiveEnvironmentKeys: ["HOME", "PATH"]
        },
        assignmentArtifactAccess: { kind: "same_host" }
      }
    });
    const started = await service.start({
      authorization: "authorized",
      proposal: launchProposal,
      project: launchProject
    });
    if (started.kind !== "started") throw new Error("scripted launch did not start");
    let outcome = await service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "pilot-launch-failure-1",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    });
    if (failures === 2) {
      outcome = await service.recordLaunchFailure({
        dispatchId: "orca-dispatch-2",
        failureId: "pilot-launch-failure-2",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      });
    }
    const dispatchStates = store
      .loadDispatchesForTask("task:pilot-launch:investigate")
      .map((dispatch) => (dispatch as { state: string }).state);
    return Object.freeze({
      outcome,
      providerLaunches: orca.calls.filter(({ kind }) => kind === "dispatch_worker").length,
      dispatchStates: Object.freeze(dispatchStates)
    });
  } finally {
    database.close();
  }
}

export async function startDurablePilotExecution(
  store: ControlStore,
  repositoryPath: string
) {
  const project: ProjectRegistryEntry = {
    ...launchProject,
    projectKey: "pilot-restart",
    orcaProjectId: "orca-pilot-restart",
    repoId: "repo-pilot-restart",
    absolutePath: repositoryPath,
    lockKey: "pilot-restart"
  };
  const proposal: ExecutionProposal = {
    ...launchProposal,
    proposalId: "pilot-restart",
    commandId: "pilot-restart-command",
    selectedProjectKey: project.projectKey,
    routeCandidates: [{ projectKey: project.projectKey, score: 1, evidence: ["scripted:restart"] }],
    tasks: ["one", "two"].map((suffix) => ({
      localId: `inspect-${suffix}`,
      title: `Inspect restart ${suffix}`,
      dependsOn: [],
      role: "investigate" as const,
      preferredAgent: "codex" as const
    }))
  };
  const orca = new LaunchOrca();
  const placement: ReadyWorktreePlacement = Object.freeze({
    ...launchPlacement(),
    repositoryPath,
    worktree: Object.freeze({
      kind: "existing-read-only",
      path: repositoryPath,
      branch: "main",
      head: "a".repeat(40)
    })
  });
  const service = new ExecutionService({
    orca,
    placements: {
      async resolve() { return placement; },
      async createWorktree(value) { return value; }
    },
    locks: {
      acquire() { return { kind: "acquired" }; },
      release() { return { kind: "released" }; }
    },
    lifecycle: new ExecutionLifecycle({ store }),
    assignmentArtifacts: new MemoryAssignmentArtifacts(),
    providerCapabilities: {
      codex: { worker: "available", hq: "available" },
      claude: { worker: "available", hq: "unavailable" },
      providerChildEnvironmentIsolation: {
        kind: "verified_effective_allowlist",
        effectiveEnvironmentKeys: ["HOME", "PATH"]
      },
      assignmentArtifactAccess: { kind: "same_host" }
    }
  });
  const started = await service.start({ authorization: "authorized", proposal, project });
  if (started.kind !== "started") throw new Error("durable restart fixture did not start");
  return Object.freeze({ service, orca, proposal, project, started });
}

const verifierEffects = Object.freeze({
  filesModified: false,
  committed: false,
  pushed: false,
  pullRequestChanged: false,
  merged: false,
  deployed: false,
  secretsAccessed: false,
  productionAccessed: false
});

function inputFor(
  identity: string,
  implementationProvider: WorkerProviderId,
  repositoryPath: string,
  cycle: 0 | 1 | 2
): VerificationInput {
  return {
    runId: `run-${identity}`,
    implementationTaskId: `task-${identity}`,
    implementationDispatchId: `dispatch-${identity}`,
    implementationProvider,
    cycle,
    projectRoute: {
      projectKey: "sandbox-web",
      orcaProjectId: "orca-sandbox-web",
      repositoryPath
    },
    requestedScope: ["src/**"],
    changedFiles: ["src/pilot.ts"],
    gitDiff: { sha256: "b".repeat(64), summary: "1 file changed" },
    testReceipts: [{
      command: "pnpm test",
      exitCode: 0,
      outcome: "passed",
      auditReference: `audit:${identity}:test`
    }],
    prohibitedEffects: ["push", "deployment", "secret access"],
    workerResult: {
      outcome: "completed",
      summary: "synthetic implementation completed",
      auditReference: `audit:${identity}:worker`
    },
    auditReferences: [`audit:${identity}:Dispatch`, `audit:${identity}:worker`]
  };
}

function reportFor(task: VerificationTask, verdict: "pass" | "fail"): VerificationReport {
  const commandEvidence = task.testReceipts.map(({ auditReference }) => auditReference);
  return {
    reportId: `report-${task.taskId}`,
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
    commands: task.testReceipts,
    implementationProvider: task.implementationProvider,
    verifierProvider: task.preferredAgent,
    findings: verdict === "pass" ? [] : ["synthetic acceptance failure"],
    evidence: verdict === "pass" ? [...commandEvidence, `audit:${task.taskId}:verifier`] : [],
    auditReferences: [...task.auditReferences, `audit:${task.taskId}:verifier`],
    verifierEffects
  };
}

export class FakeAgents {
  readonly commits: VerificationCommit[] = [];
  readonly #tasks = new Map<string, VerificationTask>();
  readonly #verification = new VerificationService({
    store: {
      saveVerificationTask: (task) => { this.#tasks.set(task.taskId, task); },
      loadVerificationTask: (taskId) => this.#tasks.get(taskId),
      commitVerification: (commit) => { this.commits.push(commit); }
    },
    completionTarget: {
      channel: "tailscale-web",
      destination: "/commands/completed",
      nextAttemptAt: "2026-09-04T00:00:00.000Z"
    }
  });

  async verifiedPair(
    identity: string,
    implementationProvider: WorkerProviderId,
    repositoryPath: string
  ) {
    const task = await this.#verification.start(
      inputFor(identity, implementationProvider, repositoryPath, 0)
    );
    const decision = await this.#verification.complete(reportFor(task, "pass"));
    return Object.freeze({
      implementationProvider,
      verifierProvider: task.preferredAgent,
      decision,
      evidence: this.commits.at(-1)?.report.evidence ?? []
    });
  }

  async failTwoCycles(repositoryPath: string) {
    const commitStart = this.commits.length;
    const first = await this.#verification.start(inputFor("failure-1", "codex", repositoryPath, 1));
    const firstDecision = await this.#verification.complete(reportFor(first, "fail"));
    const second = await this.#verification.start(inputFor("failure-2", "codex", repositoryPath, 2));
    const secondDecision = await this.#verification.complete(reportFor(second, "fail"));
    const successOutboxes = this.commits.slice(commitStart).filter(({ outboxMessage }) =>
      outboxMessage?.template === "success"
    ).length;
    return Object.freeze({ firstDecision, secondDecision, successOutboxes });
  }

  async simulateCodexAuthenticationLoss() {
    const command: CommandEnvelope = {
      commandId: "pilot-auth-loss",
      idempotencyKey: "pilot:auth-loss",
      channel: "slack",
      externalMessageId: "pilot-auth-loss-message",
      principalId: "owner",
      receivedAt: "2026-09-04T00:00:00.000Z",
      text: "인증 복구 후 다시 계획해줘"
    };
    const queued: CommandEnvelope[] = [];
    const deferred: HqQueueTerminalRecord[] = [];
    const opened: CodexTurnRequest[] = [];
    let claimed = false;
    const session = new CodexHqSession({
      models: { authorityModel: CODEX_HQ_MODEL },
      codex: {
        async openTurn(request) {
          opened.push(request);
          throw new CodexPortError("authentication_required");
        }
      },
      queue: {
        async enqueue(value) { queued.push(value); },
        async claimNext() {
          if (claimed || queued[0] === undefined) return undefined;
          claimed = true;
          return { claimToken: "pilot-auth-loss-claim", command: queued[0] };
        },
        async complete() { throw new Error("authentication loss must remain deferred"); },
        async defer(record) { deferred.push(record); }
      },
      registry: {
        async searchProjects() { return []; },
        async inspectProject() { return undefined; }
      },
      policy: { async previewPolicy() { return { kind: "rejected", reason: "invalid_context" }; } }
    });

    const outcome = await session.plan(command);
    return Object.freeze({
      outcome,
      deferredCommandIds: Object.freeze(deferred.map(({ commandId }) => commandId)),
      openedAuthorityModels: Object.freeze(opened.map(({ model }) => model))
    });
  }

  async simulateSafeLaunchRetry() {
    return exerciseLaunchFailures(1);
  }

  async simulateLaunchRetryExhaustion() {
    return exerciseLaunchFailures(2);
  }
}
