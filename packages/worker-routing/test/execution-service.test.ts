import { createHash } from "node:crypto";
import { dirname } from "node:path";

import type { ExecutionProposal } from "@orca-hq/core";
import type { OrcaOperation, OrcaReceipt } from "../../orca-adapter/src/index.js";
import type { ProjectRegistryEntry } from "../../project-registry/src/index.js";
import { ControlStore, openDatabase } from "../../persistence/src/index.js";
import type Database from "better-sqlite3";
import {
  createSandboxRepo,
  type SandboxRepo
} from "../../test-support/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AssignmentArtifactSchema,
  CodexWorkerProvider,
  ExecutionLifecycle,
  ExecutionService,
  GitWorktreePlacementService,
  WorkerProviderError,
  parseWorkerAssignment,
  workerPrompt,
  type AssignmentArtifact,
  type AssignmentArtifactReference,
  type AssignmentArtifactStageInput,
  type AssignmentArtifactStore,
  type AuthorizedProposal,
  type DispatchRecord,
  type EditingLockPort,
  type GitRepositoryStatus,
  type GitWorktreeOccupancy,
  type GitWorktreePort,
  type LifecycleMessage,
  type LifecycleMessageSink,
  type LifecycleStore,
  type LifecycleTransition,
  type LaunchFailureCommit,
  type LaunchFailureReservationCommit,
  type LaunchInterventionCommit,
  type LaunchSuccessCommit,
  type ImplementationVerificationEvidence,
  type ProviderCapabilities,
  type ProviderInspectReceipt,
  type ProviderStartReceipt,
  type RunRecord,
  type TaskRecord,
  type UserVisibleLifecycleMessage,
  type WorkerAssignment,
  type WorkerDoneCommit,
  type WorkerLaunchPolicy,
  type WorkerMessage,
  type WorkerProvider,
  type WorkerProviderRegistryPort,
  VerificationService,
  type VerificationCommit,
  type VerificationLifecycleStore,
  type VerificationObligation,
  type VerificationReport,
  type VerificationTask
} from "../src/index.js";

const project: ProjectRegistryEntry = {
  projectKey: "synthetic-api",
  orcaProjectId: "orca-project-1",
  repoId: "repo-1",
  absolutePath: "/srv/orca/projects/synthetic-api",
  aliases: ["synthetic api"],
  component: "backend",
  defaultBaseRef: "main",
  instructionsFiles: ["AGENTS.md"],
  setupPolicy: "run",
  allowedOperations: ["L0", "L1"],
  requiredChecks: ["pnpm test"],
  sensitivePaths: [".env"],
  lockKey: "synthetic-api"
};

const proposal: ExecutionProposal = {
  proposalId: "proposal-1",
  commandId: "command-1",
  selectedProjectKey: project.projectKey,
  routeCandidates: [
    { projectKey: project.projectKey, score: 1, evidence: ["exact alias"] }
  ],
  baseRef: "main",
  allowedScope: ["src/**", "test/**"],
  prohibitedEffects: ["push", "deployment", "secret access"],
  acceptanceCommands: ["pnpm test"],
  riskLevel: "L1",
  tasks: [
    {
      localId: "implement",
      title: "Implement the requested API change",
      dependsOn: [],
      role: "implement",
      preferredAgent: "codex"
    }
  ]
};

const privatePilotPolicy: WorkerLaunchPolicy = {
  kind: "orca_supervised_private_pilot",
  secretBoundaryAttestation: {
    channelAndVoiceSecrets: "keychain_or_runtime_only",
    absentFromAssignment: true,
    absentFromPromptArtifact: true,
    absentFromLogsAndAudit: true,
    absentFromConfiguredProviderEnvironment: true,
    inheritedProviderChildEnvironmentInspection: "not_available"
  }
};

function withUnsafeProviderStartAuditFields(
  receiptValue: ProviderStartReceipt,
  secret: string,
  includeEnvironmentClaim: boolean
): ProviderStartReceipt {
  const result = receiptValue.orcaReceipt.result as Record<string, unknown>;
  return {
    ...receiptValue,
    orcaReceipt: {
      ...receiptValue.orcaReceipt,
      result: {
        ...result,
        setup: {
          ...(result.setup as Record<string, unknown>),
          diagnostic: secret
        },
        effects: [{ diagnostic: secret }],
        diagnostic: secret,
        ...(includeEnvironmentClaim
          ? {
              launch: {
                providerEnvironment: {
                  kind: "verified_effective_allowlist",
                  effectiveEnvironmentKeys: ["HOME", "PATH"]
                }
              }
            }
          : {})
      },
      _meta: { diagnostic: secret }
    }
  };
}

function withUnsafeProviderInspectAuditFields(
  receiptValue: ProviderInspectReceipt,
  secrets: Readonly<{
    slack: string;
    telegram: string;
    tailscale: string;
    openAiVoice: string;
  }>,
  source: "transcript" | "terminal"
): ProviderInspectReceipt {
  const showResult = receiptValue.showReceipt.result as Record<string, unknown>;
  const dispatch = showResult.dispatch as Record<string, unknown>;
  const worker = showResult.worker as Record<string, unknown>;
  const observation = showResult.observation as Record<string, unknown>;
  const terminalResource = showResult.terminalResource as Record<string, unknown>;
  const readResult = receiptValue.readReceipt.result as Record<string, unknown>;
  return {
    ...receiptValue,
    showReceipt: {
      ...receiptValue.showReceipt,
      result: {
        ...showResult,
        dispatch: { ...dispatch, diagnostic: secrets.slack },
        worker: { ...worker, diagnostic: secrets.telegram },
        terminal: { lines: [secrets.tailscale], diagnostic: secrets.openAiVoice },
        observation: { ...observation, diagnostic: secrets.openAiVoice },
        terminalResource: { ...terminalResource, diagnostic: secrets.slack },
        diagnostic: secrets.telegram
      },
      _meta: { diagnostic: secrets.tailscale }
    },
    readReceipt: {
      ...receiptValue.readReceipt,
      result: {
        dispatchId: readResult.dispatchId,
        source,
        cursor: readResult.cursor,
        status: {
          ...(readResult.status as Record<string, unknown>),
          diagnostic: secrets.slack
        },
        warnings: [secrets.telegram],
        archived: readResult.archived,
        ...(source === "transcript"
          ? {
              transcript: {
                messages: [{
                  id: "message-1",
                  role: "assistant",
                  blocks: [{ type: "text", text: secrets.openAiVoice }],
                  timestamp: 1,
                  source: "worker",
                  diagnostic: secrets.slack
                }],
                limited: false,
                nextCursor: "cursor-1",
                returnedMessageCount: 1,
                diagnostic: secrets.telegram
              }
            }
          : {
              terminal: {
                lines: [secrets.openAiVoice],
                limited: false,
                nextCursor: "cursor-1",
                diagnostic: secrets.telegram
              }
            }),
        diagnostic: secrets.tailscale
      },
      _meta: { diagnostic: secrets.tailscale }
    }
  };
}

function authorized(
  proposalOverride: ExecutionProposal = proposal,
  projectOverride: ProjectRegistryEntry = project,
  currentWorktreeApproval?: AuthorizedProposal["currentWorktreeApproval"]
): AuthorizedProposal {
  return {
    authorization: "authorized",
    proposal: proposalOverride,
    project: projectOverride,
    ...(currentWorktreeApproval === undefined ? {} : { currentWorktreeApproval })
  };
}

class RecordingOrca {
  readonly calls: OrcaOperation[] = [];
  releaseError: Error | undefined;
  stopError: Error | undefined;
  releaseResult: { state: string; verdict: string } = {
    state: "released",
    verdict: "released"
  };
  stopResult: { state: string; verdict: string } = {
    state: "stopped",
    verdict: "stopped"
  };
  afterStop?: (() => Promise<void>) | undefined;
  dispatchErrorOnCall: number | undefined;
  createTaskErrorOnCall: number | undefined;
  createTaskRunId: string | undefined;
  dispatchRunId: string | undefined;
  showTaskId: string | undefined;
  showRunId: string | undefined;
  showWorkerState = "ready";
  readWorkerState = "ready";
  readonly showWorkerStateByDispatch = new Map<string, string>();
  readonly readWorkerStateByDispatch = new Map<string, string>();
  showTerminalHandle: string | null | undefined;
  showTerminalResourceId: string | undefined;
  showTerminalOwnershipState = "owned";
  showTerminalReleaseState = "active";
  malformedDispatchId: string | undefined;
  dispatchTaskId: string | undefined;
  effectiveEnvironmentKeys: string[] = ["HOME", "PATH"];
  includeProviderEnvironment = true;
  startSecretExtensions: Readonly<{
    slack: string;
    telegram: string;
    tailscale: string;
    openAiVoice: string;
  }> | undefined;
  #task = 0;
  #dispatch = 0;
  readonly #dispatchTasks = new Map<string, string>();

  constructor(readonly events: string[] = []) {}

  async execute(operation: OrcaOperation): Promise<OrcaReceipt> {
    this.calls.push(structuredClone(operation));
    this.events.push(`orca:${operation.kind}`);
    switch (operation.kind) {
      case "create_run":
        return receipt("run-receipt", { runId: "orca-run-1" });
      case "create_task": {
        this.#task += 1;
        if (this.createTaskErrorOnCall === this.#task) {
          throw new Error(`synthetic create_task failure ${this.#task}`);
        }
        return receipt(`task-receipt-${this.#task}`, {
          taskId: `orca-task-${this.#task}`,
          runId: this.createTaskRunId ?? "orca-run-1",
          status: "ready"
        });
      }
      case "dispatch_worker": {
        this.#dispatch += 1;
        if (this.dispatchErrorOnCall === this.#dispatch) {
          throw Object.assign(new Error(`synthetic worker-start failure ${this.#dispatch}`), {
            code: "orca_command_failed",
            orcaCode: "worker_start_rejected"
          });
        }
        if (this.malformedDispatchId !== undefined) {
          return receipt(`dispatch-receipt-${this.#dispatch}`, {
            dispatchId: this.malformedDispatchId
          });
        }
        const extensions = this.startSecretExtensions;
        const orcaDispatchId = `orca-dispatch-${this.#dispatch}`;
        this.#dispatchTasks.set(orcaDispatchId, operation.taskId);
        return {
          id: `dispatch-receipt-${this.#dispatch}`,
          ok: true,
          result: {
            dispatchId: orcaDispatchId,
            taskId: this.dispatchTaskId ?? operation.taskId,
            runId: this.dispatchRunId ?? "orca-run-1",
            state: "ready",
            stage: "ready",
            setup: {
              state: "running",
              ...(extensions === undefined ? {} : { diagnostic: extensions.tailscale })
            },
            effects: extensions === undefined ? [] : [{ diagnostic: extensions.openAiVoice }],
            ...(this.includeProviderEnvironment
              ? {
                  launch: {
                    providerEnvironment: {
                      kind: "verified_effective_allowlist",
                      effectiveEnvironmentKeys: this.effectiveEnvironmentKeys
                    },
                    ...(extensions === undefined ? {} : { diagnostic: extensions.slack })
                  }
                }
              : {}),
            ...(extensions === undefined ? {} : { diagnostic: extensions.telegram })
          },
          ...(extensions === undefined ? {} : { _meta: { diagnostic: extensions.slack } })
        };
      }
      case "show_worker": {
        const workerState = this.showWorkerStateByDispatch.get(operation.dispatchId)
          ?? this.showWorkerState;
        return receipt(`show-receipt-${operation.dispatchId}`, {
          dispatch: {
            id: operation.dispatchId,
            task_id: this.showTaskId
              ?? this.#dispatchTasks.get(operation.dispatchId)
              ?? "unknown-task",
            run_id: this.showRunId ?? "orca-run-1",
            status: "dispatched"
          },
          worker: {
            dispatch_id: operation.dispatchId,
            state: workerState,
            stage: "ready",
            agent_terminal_handle: this.showTerminalHandle === undefined
              ? `terminal-${operation.dispatchId}`
              : this.showTerminalHandle
          },
          terminal: null,
          observation: { status: workerState, exactWorker: true },
          terminalResource: {
            id: this.showTerminalResourceId ?? `terminal-${operation.dispatchId}`,
            ownershipState: this.showTerminalOwnershipState,
            releaseState: this.showTerminalReleaseState
          }
        });
      }
      case "read_worker":
        return receipt(`read-receipt-${operation.dispatchId}`, {
          dispatchId: operation.dispatchId,
          source: "transcript",
          cursor: "cursor-1",
          status: {
            worker: this.readWorkerStateByDispatch.get(operation.dispatchId)
              ?? this.readWorkerState,
            terminal: "running"
          },
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
        if (this.stopError !== undefined) throw this.stopError;
        const stopReceipt = receipt(`stop-receipt-${operation.dispatchId}`, {
          dispatchId: operation.dispatchId,
          state: this.stopResult.state,
          verdict: this.stopResult.verdict
        });
        await this.afterStop?.();
        return stopReceipt;
      case "release_worker":
        if (this.releaseError !== undefined) throw this.releaseError;
        return receipt(`release-receipt-${operation.dispatchId}`, {
          dispatchId: operation.dispatchId,
          state: this.releaseResult.state,
          verdict: this.releaseResult.verdict
        });
      default:
        throw new Error(`unexpected operation ${operation.kind}`);
    }
  }
}

function receipt(id: string, result: unknown): OrcaReceipt {
  return { id, ok: true, result };
}

class MemoryLifecycleStore implements LifecycleStore {
  readonly runs = new Map<string, RunRecord>();
  readonly tasks = new Map<string, TaskRecord>();
  readonly dispatches = new Map<string, DispatchRecord>();
  readonly transitions: LifecycleTransition[] = [];
  readonly messages: LifecycleMessage[] = [];
  readonly verificationObligations = new Map<string, VerificationObligation[]>();
  readonly #messageIds = new Set<string>();
  readonly #doneDispatches = new Set<string>();
  failWorkerDoneCommitOnce = false;
  failAssignmentArtifactSaveOnce = false;
  failAssignmentArtifactCleanupSaveOnce = false;

  async saveRun(record: RunRecord): Promise<void> {
    this.runs.set(record.id, structuredClone(record));
  }

  async saveTask(record: TaskRecord): Promise<void> {
    this.tasks.set(record.id, structuredClone(record));
  }

  async saveDispatch(record: DispatchRecord): Promise<void> {
    const current = this.dispatches.get(record.id);
    if (
      this.failAssignmentArtifactSaveOnce
      && current?.assignmentArtifact === undefined
      && record.assignmentArtifact !== undefined
      && record.assignmentArtifactCleanup === undefined
      && (record as { assignmentArtifactCleanupFailure?: unknown })
        .assignmentArtifactCleanupFailure === undefined
    ) {
      this.failAssignmentArtifactSaveOnce = false;
      throw new Error("synthetic assignment artifact persistence failure");
    }
    if (
      this.failAssignmentArtifactCleanupSaveOnce
      && record.assignmentArtifactCleanup !== undefined
    ) {
      this.failAssignmentArtifactCleanupSaveOnce = false;
      throw new Error("synthetic assignment artifact cleanup persistence failure");
    }
    this.dispatches.set(record.id, structuredClone(record));
  }

  async appendTransition(transition: LifecycleTransition): Promise<void> {
    this.transitions.push(structuredClone(transition));
  }

  async appendMessageOnce(message: LifecycleMessage): Promise<"inserted" | "duplicate"> {
    if (this.#messageIds.has(message.messageId)) return "duplicate";
    this.#messageIds.add(message.messageId);
    this.messages.push(structuredClone(message));
    return "inserted";
  }

  async commitWorkerDone(input: WorkerDoneCommit): Promise<"inserted" | "duplicate"> {
    if (this.#doneDispatches.has(input.message.dispatchId)) return "duplicate";
    if (this.failWorkerDoneCommitOnce) {
      this.failWorkerDoneCommitOnce = false;
      throw new Error("synthetic worker_done transaction failure");
    }
    this.#doneDispatches.add(input.message.dispatchId);
    this.messages.push(structuredClone(input.message));
    this.dispatches.set(input.dispatch.id, structuredClone(input.dispatch));
    this.tasks.set(input.task.id, structuredClone(input.task));
    this.transitions.push(...structuredClone(input.transitions));
    return "inserted";
  }

  async commitLaunchFailure(input: LaunchFailureCommit): Promise<"inserted" | "duplicate"> {
    if (this.#messageIds.has(input.message.messageId)) return "duplicate";
    this.#messageIds.add(input.message.messageId);
    this.messages.push(structuredClone(input.message));
    this.dispatches.set(input.dispatch.id, structuredClone(input.dispatch));
    this.transitions.push(structuredClone(input.transition));
    return "inserted";
  }

  async reserveLaunchFailure(
    input: LaunchFailureReservationCommit
  ): Promise<"inserted" | "duplicate"> {
    const current = this.dispatches.get(input.dispatch.id);
    if (current?.state === "launch_failure_reserved") return "duplicate";
    this.dispatches.set(input.dispatch.id, structuredClone(input.dispatch));
    this.transitions.push(structuredClone(input.transition));
    return "inserted";
  }

  async commitLaunchSuccess(input: LaunchSuccessCommit): Promise<"inserted" | "duplicate"> {
    this.dispatches.set(input.dispatch.id, structuredClone(input.dispatch));
    this.tasks.set(input.task.id, structuredClone(input.task));
    this.transitions.push(...structuredClone(input.transitions));
    return "inserted";
  }

  async commitLaunchIntervention(
    input: LaunchInterventionCommit
  ): Promise<"inserted" | "duplicate"> {
    this.dispatches.set(input.dispatch.id, structuredClone(input.dispatch));
    this.tasks.set(input.task.id, structuredClone(input.task));
    this.runs.set(input.run.id, structuredClone(input.run));
    this.transitions.push(...structuredClone(input.transitions));
    return "inserted";
  }

  ensureVerificationObligations(
    runId: string,
    obligations: readonly VerificationObligation[]
  ): void {
    const existing = this.verificationObligations.get(runId);
    if (existing === undefined) {
      this.verificationObligations.set(runId, structuredClone(obligations));
      return;
    }
    expect(existing.map(({ rootImplementationTaskId }) => rootImplementationTaskId))
      .toEqual(obligations.map(({ rootImplementationTaskId }) => rootImplementationTaskId));
  }

  setVerificationObligationVerifier(input: Readonly<{
    runId: string;
    rootImplementationTaskId: string;
    currentImplementationTaskId: string;
    implementationDispatchId: string;
    cycle: number;
    verificationTaskId: string;
  }>): void {
    const obligations = this.verificationObligations.get(input.runId);
    if (obligations === undefined) return;
    const index = obligations.findIndex(({ rootImplementationTaskId }) =>
      rootImplementationTaskId === input.rootImplementationTaskId
    );
    const current = obligations[index];
    if (current === undefined) return;
    obligations[index] = {
      ...current,
      currentImplementationTaskId: input.currentImplementationTaskId,
      implementationDispatchId: input.implementationDispatchId,
      cycle: input.cycle,
      status: "verifier_running",
      verificationTaskId: input.verificationTaskId
    };
  }
}

class MemoryVerificationLifecycleStore implements VerificationLifecycleStore {
  readonly tasks: VerificationTask[] = [];
  readonly commits: VerificationCommit[] = [];

  saveVerificationTask(task: VerificationTask): void {
    this.tasks.push(structuredClone(task));
  }

  commitVerification(commit: VerificationCommit): void {
    this.commits.push(structuredClone(commit));
  }
}

function hostRepositorySnapshot(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    repositoryPath: project.absolutePath,
    worktreePath: "/srv/orca/worktrees/proposal-1/attempt-1",
    worktreeKind: "isolated" as const,
    head: "0123456789abcdef0123456789abcdef01234567",
    branch: "orca/proposal-1/attempt-1",
    statusSha256: "b".repeat(64),
    diffSha256: "a".repeat(64),
    auditReference: "audit:host:repository-snapshot",
    ...overrides
  };
}

function hostRepositorySnapshotFor(dispatch: DispatchRecord) {
  return hostRepositorySnapshot({
    repositoryPath: dispatch.assignment.repo.repositoryPath,
    worktreePath: dispatch.assignment.worktree.path,
    worktreeKind: dispatch.assignment.worktree.kind,
    head: dispatch.assignment.worktree.head,
    branch: dispatch.assignment.worktree.branch
  });
}

function executionVerificationHarness(collectImplementation = () => ({
  changedFiles: ["src/api.ts"],
  gitDiff: { sha256: "a".repeat(64), summary: "1 file changed" },
  testReceipts: [{
    command: "pnpm test",
    exitCode: 0,
    outcome: "passed" as const,
    auditReference: "audit:implementation:test"
  }],
  auditReferences: ["audit:implementation:dispatch"]
})) {
  const store = new MemoryVerificationLifecycleStore();
  const verifierCommands = [{
    command: "pnpm test",
    exitCode: 0,
    outcome: "passed" as const,
    auditReference: "audit:verifier:test"
  }];
  const service = new VerificationService({
    store,
    completionTarget: {
      commandId: proposal.commandId,
      channel: "slack",
      destination: "C123",
      nextAttemptAt: "2026-09-02T00:00:00.000Z"
    }
  });
  return {
    store,
    verifierCommands,
    verification: {
      service,
      evidence: {
        collectImplementation,
        captureRepositorySnapshot: ({ dispatch }: { dispatch: DispatchRecord }) =>
          hostRepositorySnapshotFor(dispatch),
        collectVerifierCommands: () => verifierCommands
      }
    }
  };
}

class RecordingMessageSink implements LifecycleMessageSink {
  readonly messages: UserVisibleLifecycleMessage[] = [];

  async publish(message: UserVisibleLifecycleMessage): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

class RecordingLocks implements EditingLockPort {
  readonly acquired: Array<Parameters<EditingLockPort["acquire"]>[0]> = [];
  readonly released: Array<Parameters<EditingLockPort["release"]>[0]> = [];
  acquireResult: ReturnType<EditingLockPort["acquire"]> = { kind: "acquired" };

  acquire(input: Parameters<EditingLockPort["acquire"]>[0]): ReturnType<EditingLockPort["acquire"]> {
    this.acquired.push(structuredClone(input));
    return this.acquireResult;
  }

  release(input: Parameters<EditingLockPort["release"]>[0]): ReturnType<EditingLockPort["release"]> {
    this.released.push(structuredClone(input));
    return { kind: "released" };
  }
}

class DurableLocks implements EditingLockPort {
  crashAfterReleaseOnce = false;
  readonly acquired: Array<Parameters<EditingLockPort["acquire"]>[0]> = [];
  readonly released: Array<Parameters<EditingLockPort["release"]>[0]> = [];

  constructor(readonly store: ControlStore) {}

  acquire(input: Parameters<EditingLockPort["acquire"]>[0]): ReturnType<EditingLockPort["acquire"]> {
    this.acquired.push(structuredClone(input));
    if (this.store.loadRunGraphForDispatch(input.dispatchId) === undefined) {
      return { kind: "acquired" };
    }
    return this.store.acquireWorktreeLock({
      ...input,
      acquiredAt: "2026-09-03T00:00:00.000Z",
      heartbeatAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:05:00.000Z"
    });
  }

  persistLatestAcquire(): void {
    const input = this.acquired.at(-1);
    if (input === undefined) throw new Error("no acquired lease to persist");
    this.store.acquireWorktreeLock({
      ...input,
      acquiredAt: "2026-09-03T00:00:00.000Z",
      heartbeatAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:05:00.000Z"
    });
  }

  release(input: Parameters<EditingLockPort["release"]>[0]): ReturnType<EditingLockPort["release"]> {
    this.released.push(structuredClone(input));
    const result = this.store.releaseWorktreeLock({
      ...input,
      releasedAt: "2026-09-03T00:01:00.000Z"
    });
    if (this.crashAfterReleaseOnce) {
      this.crashAfterReleaseOnce = false;
      throw new Error("synthetic process loss after durable lease release");
    }
    return result;
  }
}

class MemoryAssignmentArtifactStore implements AssignmentArtifactStore {
  readonly staged: AssignmentArtifact[] = [];
  readonly cleaned: AssignmentArtifact[] = [];
  readonly #current = new Map<string, AssignmentArtifact>();
  cleanupError: Error | undefined;

  constructor(readonly events: string[] = []) {}

  referenceFor(taskId: string): AssignmentArtifactReference {
    const digest = createHash("sha256").update(taskId).digest("hex");
    return {
      protocol: 1,
      artifactId: `assignment:${digest}`,
      path: `/var/run/orca-hq/assignments/${digest}.json`
    };
  }

  async stage(input: AssignmentArtifactStageInput): Promise<AssignmentArtifact> {
    const artifact: AssignmentArtifact = {
      ...input.reference,
      version: input.version,
      ownerDispatchId: input.ownerDispatchId,
      content: input.content,
      sha256: createHash("sha256").update(input.content).digest("hex")
    };
    this.#current.set(artifact.artifactId, artifact);
    this.staged.push(structuredClone(artifact));
    this.events.push(`artifact:stage:${artifact.version}`);
    return artifact;
  }

  async cleanup(artifact: AssignmentArtifact): Promise<"removed" | "missing" | "superseded"> {
    if (this.cleanupError !== undefined) throw this.cleanupError;
    const current = this.#current.get(artifact.artifactId);
    if (current === undefined) return "missing";
    if (
      current.version !== artifact.version
      || current.ownerDispatchId !== artifact.ownerDispatchId
      || current.sha256 !== artifact.sha256
    ) return "superseded";
    this.#current.delete(artifact.artifactId);
    this.cleaned.push(structuredClone(artifact));
    this.events.push(`artifact:cleanup:${artifact.version}`);
    return "removed";
  }
}

class MemoryGit implements GitWorktreePort {
  status: GitRepositoryStatus = {
    dirty: false,
    head: "0123456789abcdef0123456789abcdef01234567",
    branch: "main"
  };
  baseCommit = this.status.head;
  occupancy: GitWorktreeOccupancy[] = [{
    path: project.absolutePath,
    branch: "main",
    head: this.status.head
  }];
  existingPaths = new Set<string>();
  createError: Error | undefined;
  createErrorOnCall = 1;
  createCalls = 0;
  readonly created: Array<Parameters<GitWorktreePort["createWorktree"]>[0]> = [];

  async repositoryStatus(_repositoryPath: string): Promise<GitRepositoryStatus> {
    return structuredClone(this.status);
  }

  async resolveRevision(_repositoryPath: string, ref: string): Promise<string> {
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(ref) ? ref : this.baseCommit;
  }

  async branchOccupancy(_repositoryPath: string): Promise<readonly GitWorktreeOccupancy[]> {
    return structuredClone(this.occupancy);
  }

  async pathExists(path: string): Promise<boolean> {
    return this.existingPaths.has(path);
  }

  async createWorktree(
    input: Parameters<GitWorktreePort["createWorktree"]>[0]
  ): Promise<void> {
    this.createCalls += 1;
    if (this.createError !== undefined && this.createCalls === this.createErrorOnCall) {
      throw this.createError;
    }
    this.created.push(structuredClone(input));
    this.existingPaths.add(input.worktreePath);
    this.occupancy.push({
      path: input.worktreePath,
      branch: input.branch,
      head: input.baseCommit
    });
  }
}

function setup(
  git = new MemoryGit(),
  providerCapabilities?: ProviderCapabilities,
  providerFactory?: (orca: RecordingOrca) => WorkerProviderRegistryPort,
  workerLaunchPolicy?: WorkerLaunchPolicy,
  verification?: unknown
): {
  service: ExecutionService;
  orca: RecordingOrca;
  git: MemoryGit;
  locks: RecordingLocks;
  store: MemoryLifecycleStore;
  messages: RecordingMessageSink;
  artifacts: MemoryAssignmentArtifactStore;
  events: string[];
} {
  const events: string[] = [];
  const orca = new RecordingOrca(events);
  const locks = new RecordingLocks();
  const store = new MemoryLifecycleStore();
  const messages = new RecordingMessageSink();
  const artifacts = new MemoryAssignmentArtifactStore(events);
  const lifecycle = new ExecutionLifecycle({ store, messages });
  const supportedCapabilities: ProviderCapabilities = {
    codex: { worker: "available", hq: "available" },
    claude: { worker: "available", hq: "unavailable" },
    providerChildEnvironmentIsolation: {
      kind: "verified_effective_allowlist",
      effectiveEnvironmentKeys: ["HOME", "PATH"]
    },
    assignmentArtifactAccess: { kind: "same_host" }
  };
  return {
    service: new ExecutionService({
      orca,
      placements: new GitWorktreePlacementService(git),
      locks,
      lifecycle,
      assignmentArtifacts: artifacts,
      providerCapabilities: providerCapabilities ?? supportedCapabilities,
      ...(workerLaunchPolicy === undefined ? {} : { workerLaunchPolicy }),
      ...(providerFactory === undefined ? {} : { providers: providerFactory(orca) }),
      ...(verification === undefined ? {} : { verification })
    } as never),
    orca,
    git,
    locks,
    store,
    messages,
    artifacts,
    events
  };
}

const durableVerifierCommands = [{
  command: "pnpm test",
  exitCode: 0,
  outcome: "passed" as const,
  auditReference: "audit:durable:verifier:test"
}];

function durableExecutionService(
  store: ControlStore,
  orca: RecordingOrca,
  collectImplementation: (input: { task: TaskRecord }) => ImplementationVerificationEvidence =
    () => ({
      changedFiles: ["src/api.ts"],
      gitDiff: { sha256: "a".repeat(64), summary: "1 file changed" },
      testReceipts: [{
        command: "pnpm test",
        exitCode: 0,
        outcome: "passed" as const,
        auditReference: "audit:durable:implementation:test"
      }],
      auditReferences: ["audit:durable:implementation:dispatch"]
    }),
  locks: EditingLockPort = new RecordingLocks(),
  assignmentArtifacts: AssignmentArtifactStore = new MemoryAssignmentArtifactStore(),
  git: MemoryGit = new MemoryGit()
): ExecutionService {
  const lifecycle = new ExecutionLifecycle({ store, messages: new RecordingMessageSink() });
  const verification = new VerificationService({
    store,
    completionTarget: {
      commandId: proposal.commandId,
      channel: "slack",
      destination: "C123",
      nextAttemptAt: "2026-09-02T00:00:00.000Z"
    }
  });
  return new ExecutionService({
    orca,
    placements: new GitWorktreePlacementService(git),
    locks,
    lifecycle,
    assignmentArtifacts,
    providerCapabilities: {
      codex: { worker: "available", hq: "available" },
      claude: { worker: "available", hq: "unavailable" },
      providerChildEnvironmentIsolation: {
        kind: "verified_effective_allowlist",
        effectiveEnvironmentKeys: ["HOME", "PATH"]
      },
      assignmentArtifactAccess: { kind: "same_host" }
    },
    verification: {
      service: verification,
      evidence: {
        collectImplementation,
        captureRepositorySnapshot: ({ dispatch }: { dispatch: DispatchRecord }) =>
          hostRepositorySnapshotFor(dispatch),
        collectVerifierCommands: () => durableVerifierCommands
      }
    }
  });
}

function seedDurableCommand(database: Database.Database, idempotencyKey: string): void {
  const now = "2026-09-02T00:00:00.000Z";
  database.prepare(`
    INSERT OR IGNORE INTO principals (id, payload_json, created_at, updated_at)
    VALUES ('owner', '{}', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO commands (
      id, idempotency_key, channel, external_message_id, principal_id,
      received_at, payload_json, created_at
    ) VALUES ('command-1', ?, 'slack', '171.003', 'owner', ?, '{}', ?)
  `).run(idempotencyKey, now, now);
}

function rewriteDurableLaunchCheckpoint(
  database: Database.Database,
  input: Readonly<{
    dispatchState: "launching" | "running";
    keepInspections: boolean;
    mutateDispatch?: ((payload: Record<string, any>) => void) | undefined;
  }>
): void {
  const dispatchRow = database.prepare(`
    SELECT id, task_id, payload_json
    FROM dispatches
    WHERE json_extract(payload_json, '$.orcaDispatchId') = 'orca-dispatch-1'
  `).get() as { id: string; task_id: string; payload_json: string };
  const dispatchPayload = JSON.parse(dispatchRow.payload_json) as Record<string, any>;
  dispatchPayload.state = input.dispatchState;
  if (!input.keepInspections) delete dispatchPayload.providerInspectReceipts;
  input.mutateDispatch?.(dispatchPayload);
  database.prepare(`
    UPDATE dispatches SET state = ?, payload_json = ? WHERE id = ?
  `).run(input.dispatchState, JSON.stringify(dispatchPayload), dispatchRow.id);

  const taskRow = database.prepare(`
    SELECT payload_json FROM tasks WHERE id = ?
  `).get(dispatchRow.task_id) as { payload_json: string };
  const taskPayload = JSON.parse(taskRow.payload_json) as Record<string, unknown>;
  taskPayload.state = "ready";
  database.prepare(`
    UPDATE tasks SET state = 'ready', payload_json = ? WHERE id = ?
  `).run(JSON.stringify(taskPayload), dispatchRow.task_id);
  database.prepare(`
    DELETE FROM audit_events
    WHERE event_type = 'lifecycle.transition'
      AND subject_id IN (?, ?)
      AND json_extract(data_json, '$.to') = 'running'
  `).run(dispatchRow.id, dispatchRow.task_id);
}

function rewriteDurableLaunchGraph(
  database: Database.Database,
  input: Readonly<{
    dispatchState: DispatchRecord["state"];
    taskState?: TaskRecord["state"] | undefined;
    runState?: RunRecord["state"] | undefined;
    mutateDispatch?: ((payload: Record<string, any>) => void) | undefined;
  }>
): void {
  const dispatchRow = database.prepare(`
    SELECT id, task_id, payload_json
    FROM dispatches
    WHERE json_extract(payload_json, '$.orcaDispatchId') = 'orca-dispatch-1'
  `).get() as { id: string; task_id: string; payload_json: string };
  const dispatchPayload = JSON.parse(dispatchRow.payload_json) as Record<string, any>;
  dispatchPayload.state = input.dispatchState;
  input.mutateDispatch?.(dispatchPayload);
  database.prepare(`
    UPDATE dispatches SET state = ?, payload_json = ? WHERE id = ?
  `).run(input.dispatchState, JSON.stringify(dispatchPayload), dispatchRow.id);

  const taskRow = database.prepare(`
    SELECT run_id, payload_json FROM tasks WHERE id = ?
  `).get(dispatchRow.task_id) as { run_id: string; payload_json: string };
  const taskState = input.taskState ?? "running";
  const taskPayload = JSON.parse(taskRow.payload_json) as Record<string, any>;
  taskPayload.state = taskState;
  database.prepare(`
    UPDATE tasks SET state = ?, payload_json = ? WHERE id = ?
  `).run(taskState, JSON.stringify(taskPayload), dispatchRow.task_id);

  const runState = input.runState ?? "active";
  const runRow = database.prepare(`
    SELECT payload_json FROM runs WHERE id = ?
  `).get(taskRow.run_id) as { payload_json: string };
  const runPayload = JSON.parse(runRow.payload_json) as Record<string, any>;
  runPayload.state = runState;
  database.prepare(`
    UPDATE runs SET state = ?, payload_json = ? WHERE id = ?
  `).run(runState, JSON.stringify(runPayload), taskRow.run_id);
}

function durableReport(
  task: VerificationTask,
  verdict: "pass" | "fail",
  reportId: string
): VerificationReport {
  return {
    reportId,
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
    commands: durableVerifierCommands,
    implementationProvider: task.implementationProvider,
    verifierProvider: task.preferredAgent,
    findings: verdict === "pass" ? [] : ["acceptance behavior is incomplete"],
    evidence: ["audit:durable:verifier:test"],
    auditReferences: [...task.auditReferences, "audit:durable:verifier:test"],
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

function reportForTask(
  task: VerificationTask,
  commands: readonly {
    command: string;
    exitCode: number;
    outcome: "passed" | "failed";
    auditReference: string;
  }[],
  reportId = `report:${task.taskId}`
): VerificationReport {
  return {
    reportId,
    runId: task.runId,
    verificationTaskId: task.taskId,
    implementationTaskId: task.implementationTaskId,
    implementationDispatchId: task.implementationDispatchId,
    cycle: task.cycle,
    verdict: "pass",
    projectRoute: task.projectRoute,
    changedFiles: task.changedFiles,
    diffSha256: task.gitDiff.sha256,
    diffSummary: task.gitDiff.summary,
    commands: [...commands],
    implementationProvider: task.implementationProvider,
    verifierProvider: task.preferredAgent,
    findings: [],
    evidence: commands.map(({ auditReference }) => auditReference),
    auditReferences: [
      ...task.auditReferences,
      ...commands.map(({ auditReference }) => auditReference)
    ],
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

const sandboxes: SandboxRepo[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.cleanup()));
});

describe("ExecutionService preflight and dispatch", () => {
  it.each([
    {
      name: "duplicate Task IDs",
      tasks: [proposal.tasks[0]!, { ...proposal.tasks[0]!, title: "Duplicate ID" }],
      error: "duplicate Task localId: implement"
    },
    {
      name: "an unknown dependency",
      tasks: [{ ...proposal.tasks[0]!, dependsOn: ["missing"] }],
      error: "Task implement has unknown dependency missing"
    },
    {
      name: "a repeated dependency",
      tasks: [
        proposal.tasks[0]!,
        {
          ...proposal.tasks[0]!,
          localId: "follow-up",
          dependsOn: ["implement", "implement"]
        }
      ],
      error: "Task follow-up repeats dependency implement"
    },
    {
      name: "a self dependency",
      tasks: [{ ...proposal.tasks[0]!, dependsOn: ["implement"] }],
      error: "Task implement depends on itself"
    },
    {
      name: "a general cycle",
      tasks: [
        { ...proposal.tasks[0]!, localId: "first", dependsOn: ["second"] },
        { ...proposal.tasks[0]!, localId: "second", dependsOn: ["first"] }
      ],
      error: "execution proposal Task dependencies contain a cycle"
    }
  ])("rejects $name before any persistence, lock, Git, or Orca mutation", async ({ tasks, error }) => {
    // Break caught: malformed graphs must fail before acquiring edit authority or creating public records.
    const setupResult = setup();
    const invalidProposal: ExecutionProposal = { ...proposal, tasks };

    await expect(setupResult.service.start(authorized(invalidProposal))).rejects.toThrow(error);

    expect(setupResult.store.runs.size).toBe(0);
    expect(setupResult.store.tasks.size).toBe(0);
    expect(setupResult.store.dispatches.size).toBe(0);
    expect(setupResult.store.transitions).toEqual([]);
    expect(setupResult.locks.acquired).toEqual([]);
    expect(setupResult.locks.released).toEqual([]);
    expect(setupResult.git.created).toEqual([]);
    expect(setupResult.orca.calls).toEqual([]);
  });

  it("creates the Run and every Task before dispatching only the ready dependency root", async () => {
    // Break caught: dispatching while the DAG is only partially persisted can orphan dependency records.
    const { service, orca } = setup();
    const dependentTask = {
      localId: "verify-input",
      title: "Inspect implementation input",
      dependsOn: ["implement"],
      role: "investigate" as const,
      preferredAgent: "claude" as const
    };
    const withDependency: ExecutionProposal = {
      ...proposal,
      tasks: [
        dependentTask,
        proposal.tasks[0]!
      ]
    };

    await expect(service.start(authorized(withDependency))).resolves.toMatchObject({
      kind: "started",
      runId: "orca-run-1",
      dispatchIds: ["orca-dispatch-1"]
    });

    expect(orca.calls.map(({ kind }) => kind)).toEqual([
      "create_run",
      "create_task",
      "create_task",
      "dispatch_worker",
      "show_worker",
      "read_worker"
    ]);
    expect(orca.calls[2]).toMatchObject({
      kind: "create_task",
      dependencies: ["orca-task-1"]
    });
  });

  it("blocks a base branch checked out elsewhere before any Orca mutation", async () => {
    // Break caught: starting from an ambiguously occupied branch can edit the wrong checkout.
    const git = new MemoryGit();
    git.occupancy.push({ path: "/tmp/other", branch: "main", head: git.status.head });
    const { service, orca } = setup(git);

    await expect(service.start(authorized())).resolves.toEqual({
      kind: "review_required",
      reason: "base_branch_occupied_elsewhere",
      path: "/tmp/other",
      branch: "main"
    });
    expect(orca.calls).toEqual([]);
  });

  it("requires explicit current-worktree approval for uncommitted L1 input", async () => {
    // Break caught: silently excluding or editing dirty current work can lose user intent or data.
    const git = new MemoryGit();
    git.status = { ...git.status, dirty: true };
    const { service, orca, locks } = setup(git);

    await expect(service.start(authorized())).resolves.toEqual({
      kind: "review_required",
      reason: "dirty_current_worktree_requires_approval",
      path: project.absolutePath
    });
    expect(orca.calls).toEqual([]);
    expect(locks.acquired).toEqual([]);
  });

  it("uses the exact approved dirty checkout while still requiring an editing lease", async () => {
    // Break caught: approval for one checkout or HEAD must not authorize a different mutable input.
    const git = new MemoryGit();
    git.status = { ...git.status, dirty: true };
    const { service, git: placementGit, locks, store } = setup(git);

    await expect(service.start(authorized(proposal, project, {
      approvalId: "approval-current-1",
      worktreePath: project.absolutePath,
      head: git.status.head
    }))).resolves.toMatchObject({ kind: "started" });

    expect(placementGit.created).toEqual([]);
    expect(locks.acquired).toHaveLength(1);
    expect([...store.dispatches.values()][0]?.assignment).toMatchObject({
      worktree: {
        kind: "approved-current",
        path: project.absolutePath,
        head: git.status.head
      },
      permissions: "read-write"
    });
  });

  it("blocks an approved current checkout whose HEAD is not the resolved base commit", async () => {
    // Break caught: approval for a dirty checkout does not authorize running from a stale base.
    const git = new MemoryGit();
    git.status = { ...git.status, dirty: true };
    git.baseCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { service, orca, locks } = setup(git);

    await expect(service.start(authorized(proposal, project, {
      approvalId: "approval-current-1",
      worktreePath: project.absolutePath,
      head: git.status.head
    }))).resolves.toEqual({
      kind: "review_required",
      reason: "current_worktree_base_mismatch",
      path: project.absolutePath,
      head: git.status.head,
      baseCommit: git.baseCommit
    });

    expect(orca.calls).toEqual([]);
    expect(locks.acquired).toEqual([]);
  });

  it("runs L0 investigation in the existing checkout without a worktree or editing lease", async () => {
    // Break caught: a read-only investigation must not acquire edit authority or mutate Git placement.
    const { service, git, locks, orca, store } = setup();
    const readOnlyProposal: ExecutionProposal = {
      ...proposal,
      riskLevel: "L0",
      tasks: [{
        ...proposal.tasks[0]!,
        localId: "investigate",
        title: "Inspect current status",
        role: "investigate"
      }]
    };

    await expect(service.start(authorized(readOnlyProposal))).resolves.toMatchObject({
      kind: "started"
    });

    expect(locks.acquired).toEqual([]);
    expect(git.created).toEqual([]);
    expect(orca.calls.findLast(({ kind }) => kind === "dispatch_worker")).toMatchObject({
      kind: "dispatch_worker",
      worktree: project.absolutePath
    });
    expect([...store.dispatches.values()][0]?.assignment).toMatchObject({
      project: {
        projectKey: project.projectKey,
        orcaProjectId: project.orcaProjectId
      },
      repo: {
        repoId: project.repoId,
        repositoryPath: project.absolutePath
      },
      worktree: { kind: "existing-read-only", path: project.absolutePath },
      base: { ref: "main", commit: git.status.head },
      fileScope: proposal.allowedScope,
      acceptanceCommands: proposal.acceptanceCommands,
      prohibitedEffects: proposal.prohibitedEffects,
      taskId: "task:proposal-1:investigate",
      dispatchId: "dispatch:proposal-1:investigate:1",
      permissions: "read-only",
      nestedWorkers: "forbidden"
    });
  });

  it("blocks L0 investigation when the existing checkout HEAD is not the resolved base commit", async () => {
    // Break caught: read-only execution still must inspect the exact authorized revision.
    const git = new MemoryGit();
    git.baseCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { service, orca, locks } = setup(git);
    const readOnlyProposal: ExecutionProposal = {
      ...proposal,
      riskLevel: "L0",
      tasks: [{
        ...proposal.tasks[0]!,
        localId: "investigate",
        title: "Inspect current status",
        role: "investigate"
      }]
    };

    await expect(service.start(authorized(readOnlyProposal))).resolves.toEqual({
      kind: "review_required",
      reason: "current_worktree_base_mismatch",
      path: project.absolutePath,
      head: git.status.head,
      baseCommit: git.baseCommit
    });

    expect(orca.calls).toEqual([]);
    expect(locks.acquired).toEqual([]);
    expect(git.created).toEqual([]);
  });

  it("blocks a conflicting editing lock before creating a worktree or mutating Orca", async () => {
    // Break caught: checking the lease after worker start allows two editors into the same project.
    const setupResult = setup();
    setupResult.locks.acquireResult = {
      kind: "conflict",
      lease: { dispatchId: "dispatch-other" }
    };

    await expect(setupResult.service.start(authorized())).resolves.toEqual({
      kind: "review_required",
      reason: "editing_lock_conflict",
      dispatchId: "dispatch-other"
    });
    expect(setupResult.git.created).toEqual([]);
    expect(setupResult.orca.calls).toEqual([]);
    expect(setupResult.store.runs.size).toBe(0);
    expect(setupResult.store.tasks.size).toBe(0);
    expect(setupResult.store.dispatches.size).toBe(0);
    expect(setupResult.store.transitions).toEqual([]);

    setupResult.locks.acquireResult = { kind: "acquired" };
    await expect(setupResult.service.start(authorized())).resolves.toMatchObject({
      kind: "started",
      runId: "orca-run-1"
    });
  });

  it("releases the editing lease when isolated worktree creation fails", async () => {
    // Break caught: a Git placement error must not strand the project-wide editing lease.
    const git = new MemoryGit();
    git.createError = new Error("synthetic Git worktree failure");
    const { service, locks, orca } = setup(git);

    await expect(service.start(authorized())).rejects.toThrow("synthetic Git worktree failure");

    expect(locks.released).toEqual([{
      lockKey: project.lockKey,
      dispatchId: "dispatch:proposal-1:implement:1"
    }]);
    expect(orca.calls).toEqual([]);
  });

  it("releases the exact initial lease and persists intervention when worker-start fails", async () => {
    // Break caught: an Orca start rejection must not leave either edit authority or an active-looking Run.
    const setupResult = setup();
    setupResult.orca.dispatchErrorOnCall = 1;

    await expect(setupResult.service.start(authorized())).rejects.toMatchObject({
      code: "provider_process_failed",
      provider: "codex",
      phase: "start"
    });

    expect(setupResult.locks.released).toEqual([{
      lockKey: project.lockKey,
      dispatchId: "dispatch:proposal-1:implement:1"
    }]);
    expect(setupResult.store.dispatches.get("dispatch:proposal-1:implement:1")?.state)
      .toBe("intervention_required");
    expect(setupResult.store.tasks.get("task:proposal-1:implement")?.state)
      .toBe("intervention_required");
    expect(setupResult.store.runs.get("run:proposal-1")?.state)
      .toBe("intervention_required");
    expect(setupResult.artifacts.cleaned).toEqual([setupResult.artifacts.staged[0]]);
    expect(setupResult.store.dispatches.get("dispatch:proposal-1:implement:1"))
      .toMatchObject({ assignmentArtifactCleanup: { kind: "removed" } });
  });

  it("keeps the editing lease and artifact when a possibly-live worker has no Dispatch ID", async () => {
    // Break caught: uncertainty without an exact stop target must retain the project fence.
    const setupResult = setup(new MemoryGit(), undefined, () => {
      const provider: WorkerProvider = {
        id: "codex",
        start: async () => {
          throw new WorkerProviderError("invalid_provider_receipt", "codex", "start", {
            workerMayBeLive: true
          });
        },
        inspect: async () => {
          throw new Error("inspect must not run without a Dispatch ID");
        }
      };
      return { get: () => provider };
    });

    await expect(setupResult.service.start(authorized())).rejects.toMatchObject({
      code: "invalid_provider_receipt",
      provider: "codex",
      phase: "start",
      workerMayBeLive: true
    });

    expect(setupResult.orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([]);
    expect(setupResult.artifacts.cleaned).toEqual([]);
    expect(setupResult.locks.released).toEqual([]);
    expect(setupResult.store.dispatches.get("dispatch:proposal-1:implement:1"))
      .toMatchObject({
        state: "intervention_required",
        assignmentArtifact: setupResult.artifacts.staged[0]
      });
  });

  it("fails before mutation instead of substituting an unavailable preferred provider", async () => {
    // Break caught: falling back to Claude would execute an assignment that authorized Codex only.
    const capabilities: ProviderCapabilities = {
      codex: { worker: "unavailable", hq: "available" },
      claude: { worker: "available", hq: "unavailable" },
      providerChildEnvironmentIsolation: {
        kind: "verified_effective_allowlist",
        effectiveEnvironmentKeys: ["HOME", "PATH"]
      },
      assignmentArtifactAccess: { kind: "same_host" }
    };
    const setupResult = setup(new MemoryGit(), capabilities);

    await expect(setupResult.service.start(authorized())).rejects.toMatchObject({
      code: "provider_unavailable",
      provider: "codex",
      phase: "start"
    });

    expect(setupResult.orca.calls).toEqual([]);
    expect(setupResult.locks.acquired).toEqual([]);
    expect(setupResult.store.runs.size).toBe(0);
    expect(setupResult.store.tasks.size).toBe(0);
    expect(setupResult.store.dispatches.size).toBe(0);
  });

  it("fails closed before artifact or Orca mutation when provider child isolation is unsupported", async () => {
    // Break caught: production Orca 1.4.195 cannot attest the launched provider environment.
    const orca = new RecordingOrca();
    const locks = new RecordingLocks();
    const store = new MemoryLifecycleStore();
    const artifacts = new MemoryAssignmentArtifactStore();
    const service = new ExecutionService({
      orca,
      placements: new GitWorktreePlacementService(new MemoryGit()),
      locks,
      lifecycle: new ExecutionLifecycle({ store }),
      assignmentArtifacts: artifacts
    });

    await expect(service.start(authorized())).rejects.toMatchObject({
      code: "provider_environment_isolation_unavailable",
      provider: "codex",
      phase: "start"
    });
    expect(artifacts.staged).toEqual([]);
    expect(orca.calls).toEqual([]);
    expect(locks.acquired).toEqual([]);
    expect(store.runs.size).toBe(0);
  });

  it.each([
    {
      name: "missing",
      policy: { kind: "orca_supervised_private_pilot" }
    },
    {
      name: "false",
      policy: {
        ...privatePilotPolicy,
        secretBoundaryAttestation: {
          ...privatePilotPolicy.secretBoundaryAttestation,
          absentFromLogsAndAudit: false
        }
      }
    }
  ])("rejects a $name private-pilot attestation while configuration is still mutation-free", ({ policy }) => {
    // Break caught: accepting a partial or aspirational attestation would silently enable the exception.
    const orca = new RecordingOrca();
    const locks = new RecordingLocks();
    const store = new MemoryLifecycleStore();
    const artifacts = new MemoryAssignmentArtifactStore();
    let caught: unknown;

    try {
      new ExecutionService({
        orca,
        placements: new GitWorktreePlacementService(new MemoryGit()),
        locks,
        lifecycle: new ExecutionLifecycle({ store }),
        assignmentArtifacts: artifacts,
        providerCapabilities: {
          codex: { worker: "available", hq: "available" },
          claude: { worker: "available", hq: "unavailable" },
          providerChildEnvironmentIsolation: { kind: "unsupported" },
          assignmentArtifactAccess: { kind: "same_host" }
        },
        workerLaunchPolicy: policy as WorkerLaunchPolicy
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "private_pilot_secret_boundary_attestation_invalid"
    });
    expect(artifacts.staged).toEqual([]);
    expect(orca.calls).toEqual([]);
    expect(locks.acquired).toEqual([]);
    expect(store.runs.size).toBe(0);
  });

  it("persists an unverified boundary for an explicit private-pilot launch without Orca environment evidence", async () => {
    // Break caught: supervision must never be promoted into a verified provider child environment claim.
    const capabilities: ProviderCapabilities = {
      codex: { worker: "available", hq: "available" },
      claude: { worker: "available", hq: "unavailable" },
      providerChildEnvironmentIsolation: { kind: "unsupported" },
      assignmentArtifactAccess: { kind: "same_host" }
    };
    const setupResult = setup(
      new MemoryGit(),
      capabilities,
      undefined,
      privatePilotPolicy
    );
    setupResult.orca.includeProviderEnvironment = false;

    await expect(setupResult.service.start(authorized())).resolves.toMatchObject({
      kind: "started",
      dispatchIds: ["orca-dispatch-1"]
    });

    const dispatch = [...setupResult.store.dispatches.values()][0];
    expect(dispatch?.providerStartReceipt?.boundary.providerChildEnvironmentIsolation).toEqual({
      kind: "unverified_orca_supervised"
    });
    expect(dispatch?.receipt?.result).not.toHaveProperty("launch.providerEnvironment");
    expect(JSON.stringify(dispatch)).not.toContain("verified_effective_allowlist");
  });

  it("rejects and fences a private-pilot start receipt that asserts verified child isolation", async () => {
    // Break caught: an outer unverified label cannot coexist with a nested verified claim in durable audit.
    const capabilities: ProviderCapabilities = {
      codex: { worker: "available", hq: "available" },
      claude: { worker: "available", hq: "unavailable" },
      providerChildEnvironmentIsolation: { kind: "unsupported" },
      assignmentArtifactAccess: { kind: "same_host" }
    };
    const setupResult = setup(
      new MemoryGit(),
      capabilities,
      undefined,
      privatePilotPolicy
    );
    const extensionSecret = "private-receipt-extension-c8cb21cc";
    setupResult.orca.startSecretExtensions = {
      slack: extensionSecret,
      telegram: extensionSecret,
      tailscale: extensionSecret,
      openAiVoice: extensionSecret
    };

    await expect(setupResult.service.start(authorized())).rejects.toMatchObject({
      code: "invalid_provider_receipt",
      workerMayBeLive: true,
      trustedDispatchId: "orca-dispatch-1"
    });

    expect(setupResult.orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([{
      kind: "stop_worker",
      dispatchId: "orca-dispatch-1"
    }]);
    expect(setupResult.artifacts.cleaned).toEqual([setupResult.artifacts.staged[0]]);
    expect(setupResult.locks.released).toEqual([{
      lockKey: project.lockKey,
      dispatchId: "dispatch:proposal-1:implement:1"
    }]);
    const durableAudit = JSON.stringify({
      runs: [...setupResult.store.runs.values()],
      tasks: [...setupResult.store.tasks.values()],
      dispatches: [...setupResult.store.dispatches.values()],
      transitions: setupResult.store.transitions,
      messages: setupResult.store.messages
    });
    expect(durableAudit).not.toContain(extensionSecret);
    expect(durableAudit).not.toContain("verified_effective_allowlist");
  });

  it("sanitizes a private-pilot receipt returned by an injected provider before persistence", async () => {
    // Break caught: a custom registry port must not bypass the durable receipt allowlist.
    const capabilities: ProviderCapabilities = {
      codex: { worker: "available", hq: "available" },
      claude: { worker: "available", hq: "unavailable" },
      providerChildEnvironmentIsolation: { kind: "unsupported" },
      assignmentArtifactAccess: { kind: "same_host" }
    };
    const extensionSecret = "custom-provider-extension-e13704bc";
    const setupResult = setup(new MemoryGit(), capabilities, (orca) => {
      const delegate = new CodexWorkerProvider({ orca });
      const provider: WorkerProvider = {
        id: "codex",
        start: async (assignment, context) => withUnsafeProviderStartAuditFields(
          await delegate.start(assignment, context),
          extensionSecret,
          false
        ),
        inspect: (dispatchId) => delegate.inspect(dispatchId)
      };
      return { get: () => provider };
    }, privatePilotPolicy);
    setupResult.orca.includeProviderEnvironment = false;

    await expect(setupResult.service.start(authorized())).resolves.toMatchObject({
      kind: "started"
    });

    const durableAudit = JSON.stringify([...setupResult.store.dispatches.values()]);
    expect(durableAudit).not.toContain(extensionSecret);
    expect(durableAudit).not.toContain("verified_effective_allowlist");
  });

  it.each(["transcript", "terminal"] as const)(
    "reprojects injected private-pilot %s inspection receipts before persistence",
    async (source) => {
      // Break caught: a custom registry port must not restore raw worker output after provider sanitization.
      const capabilities: ProviderCapabilities = {
        codex: { worker: "available", hq: "available" },
        claude: { worker: "available", hq: "unavailable" },
        providerChildEnvironmentIsolation: { kind: "unsupported" },
        assignmentArtifactAccess: { kind: "same_host" }
      };
      const secrets = {
        slack: "xoxb-custom-inspection-slack-1f233df9",
        telegram: "custom-inspection-telegram-3a417fba",
        tailscale: "tskey-custom-inspection-b54dbcac",
        openAiVoice: "sk-custom-inspection-voice-03728e62"
      } as const;
      const setupResult = setup(new MemoryGit(), capabilities, (orca) => {
        const delegate = new CodexWorkerProvider({ orca });
        const provider: WorkerProvider = {
          id: "codex",
          start: (assignment, context) => delegate.start(assignment, context),
          inspect: async (dispatchId) => withUnsafeProviderInspectAuditFields(
            await delegate.inspect(dispatchId),
            secrets,
            source
          )
        };
        return { get: () => provider };
      }, privatePilotPolicy);
      setupResult.orca.includeProviderEnvironment = false;

      await expect(setupResult.service.start(authorized())).resolves.toMatchObject({
        kind: "started"
      });

      const receipt = [...setupResult.store.dispatches.values()][0]
        ?.providerInspectReceipts?.[0];
      expect(receipt?.showReceipt).toEqual({
        id: "show-receipt-orca-dispatch-1",
        ok: true,
        result: {
          dispatch: {
            id: "orca-dispatch-1",
            task_id: "orca-task-1",
            run_id: "orca-run-1",
            status: "dispatched"
          },
          worker: {
            dispatch_id: "orca-dispatch-1",
            state: "ready",
            stage: "ready",
            agent_terminal_handle: "terminal-orca-dispatch-1"
          },
          terminal: null,
          observation: { status: "ready", exactWorker: true },
          terminalResource: {
            id: "terminal-orca-dispatch-1",
            ownershipState: "owned",
            releaseState: "active"
          }
        }
      });
      expect(receipt?.readReceipt).toEqual({
        id: "read-receipt-orca-dispatch-1",
        ok: true,
        result: {
          dispatchId: "orca-dispatch-1",
          source,
          cursor: "cursor-1",
          status: { worker: "ready", terminal: "running" },
          ...(source === "transcript"
            ? {
                transcript: {
                  messages: [],
                  limited: false,
                  nextCursor: "cursor-1",
                  returnedMessageCount: 1
                }
              }
            : { terminal: { lines: [], limited: false, nextCursor: "cursor-1" } }),
          warnings: [],
          archived: false
        }
      });
      const durableAudit = JSON.stringify([...setupResult.store.dispatches.values()]);
      for (const value of Object.values(secrets)) expect(durableAudit).not.toContain(value);
      expect(durableAudit).not.toContain("blocks");
      expect(durableAudit).not.toContain("_meta");
      expect(durableAudit).not.toContain("diagnostic");
    }
  );

  it("rejects and fences a contradictory private-pilot receipt from an injected provider", async () => {
    // Break caught: dependency injection is not authority to weaken the service receipt boundary.
    const capabilities: ProviderCapabilities = {
      codex: { worker: "available", hq: "available" },
      claude: { worker: "available", hq: "unavailable" },
      providerChildEnvironmentIsolation: { kind: "unsupported" },
      assignmentArtifactAccess: { kind: "same_host" }
    };
    const extensionSecret = "custom-provider-claim-ea83df16";
    const setupResult = setup(new MemoryGit(), capabilities, (orca) => {
      const delegate = new CodexWorkerProvider({ orca });
      const provider: WorkerProvider = {
        id: "codex",
        start: async (assignment, context) => withUnsafeProviderStartAuditFields(
          await delegate.start(assignment, context),
          extensionSecret,
          true
        ),
        inspect: (dispatchId) => delegate.inspect(dispatchId)
      };
      return { get: () => provider };
    }, privatePilotPolicy);
    setupResult.orca.includeProviderEnvironment = false;

    await expect(setupResult.service.start(authorized())).rejects.toMatchObject({
      code: "invalid_provider_receipt",
      workerMayBeLive: true,
      trustedDispatchId: "orca-dispatch-1"
    });

    expect(setupResult.orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([{
      kind: "stop_worker",
      dispatchId: "orca-dispatch-1"
    }]);
    expect(setupResult.artifacts.cleaned).toEqual([setupResult.artifacts.staged[0]]);
    expect(setupResult.locks.released).toEqual([{
      lockKey: project.lockKey,
      dispatchId: "dispatch:proposal-1:implement:1"
    }]);
    const durableAudit = JSON.stringify([...setupResult.store.dispatches.values()]);
    expect(durableAudit).not.toContain(extensionSecret);
    expect(durableAudit).not.toContain("verified_effective_allowlist");
  });

  it("keeps synthetic channel, network, and voice secrets out of every private-pilot launch surface", async () => {
    // Break caught: a process-global secret must not migrate into durable assignment or audit material.
    const secrets = {
      SLACK_BOT_TOKEN: "xoxb-private-pilot-slack-93e468f2",
      TELEGRAM_BOT_TOKEN: "private-pilot-telegram-2f9029c1",
      TAILSCALE_AUTH_KEY: "tskey-auth-private-pilot-cb552d1a",
      OPENAI_API_KEY: "sk-private-pilot-voice-fd856297"
    } as const;
    for (const [key, value] of Object.entries(secrets)) vi.stubEnv(key, value);
    const capabilities: ProviderCapabilities = {
      codex: { worker: "available", hq: "available" },
      claude: { worker: "available", hq: "unavailable" },
      providerChildEnvironmentIsolation: { kind: "unsupported" },
      assignmentArtifactAccess: { kind: "same_host" }
    };
    const setupResult = setup(
      new MemoryGit(),
      capabilities,
      undefined,
      privatePilotPolicy
    );
    setupResult.orca.includeProviderEnvironment = false;
    setupResult.orca.startSecretExtensions = {
      slack: secrets.SLACK_BOT_TOKEN,
      telegram: secrets.TELEGRAM_BOT_TOKEN,
      tailscale: secrets.TAILSCALE_AUTH_KEY,
      openAiVoice: secrets.OPENAI_API_KEY
    };

    const result = await setupResult.service.start(authorized());
    const dispatch = [...setupResult.store.dispatches.values()][0];
    const artifact = setupResult.artifacts.staged[0];
    if (dispatch === undefined || artifact === undefined) {
      throw new Error("private-pilot launch did not persist its audit inputs");
    }
    const schemaErrors: unknown[] = [];
    try {
      parseWorkerAssignment({
        ...dispatch.assignment,
        SLACK_BOT_TOKEN: secrets.SLACK_BOT_TOKEN
      });
    } catch (error) {
      schemaErrors.push(error);
    }
    try {
      AssignmentArtifactSchema.parse({
        ...artifact,
        TELEGRAM_BOT_TOKEN: secrets.TELEGRAM_BOT_TOKEN
      });
    } catch (error) {
      schemaErrors.push(error);
    }
    expect(schemaErrors).toHaveLength(2);

    const taskSpecs = setupResult.orca.calls
      .filter((operation) => operation.kind === "create_task")
      .map((operation) => operation.spec);
    const dispatchOperation = setupResult.orca.calls.find(
      (operation) => operation.kind === "dispatch_worker"
    );
    expect(dispatchOperation).not.toHaveProperty("environment");
    const serializedAuditAndErrors = JSON.stringify({
      result,
      taskSpecs,
      assignment: dispatch.assignment,
      promptAndArtifact: setupResult.artifacts.staged,
      providerReceipts: {
        start: dispatch.providerStartReceipt,
        inspect: dispatch.providerInspectReceipts
      },
      lifecycle: {
        runs: [...setupResult.store.runs.values()],
        tasks: [...setupResult.store.tasks.values()],
        dispatches: [...setupResult.store.dispatches.values()],
        transitions: setupResult.store.transitions,
        messages: setupResult.store.messages
      },
      applicationConfiguredProviderLaunch: dispatchOperation,
      schemaErrors
    });
    for (const value of Object.values(secrets)) {
      expect(serializedAuditAndErrors).not.toContain(value);
    }
    expect(serializedAuditAndErrors).toContain("unverified_orca_supervised");
    expect(serializedAuditAndErrors).not.toContain("verified_effective_allowlist");
  });

  it("publishes an invariant Task reference before atomically staging the exact attempt", async () => {
    // Break caught: a receipt created after worker-start cannot deliver the assignment to the worker.
    const { service, orca, store, artifacts, events } = setup();

    await service.start(authorized());

    const taskOperation = orca.calls.find(({ kind }) => kind === "create_task");
    if (taskOperation?.kind !== "create_task") throw new Error("Task was not created");
    const spec = JSON.parse(taskOperation.spec) as Record<string, unknown>;
    const staged = artifacts.staged[0];
    expect(spec).toMatchObject({
      assignmentArtifact: {
        protocol: 1,
        artifactId: staged?.artifactId,
        path: staged?.path,
        format: "orca_hq_assignment_artifact_v1",
        requiredBeforeWork: true,
        integrity: "sha256_content",
        workerConsumption: "read_content_as_authoritative_assignment_before_work"
      }
    });
    expect(staged).toMatchObject({
      version: 1,
      ownerDispatchId: "dispatch:proposal-1:implement:1",
      content: workerPrompt([...store.dispatches.values()][0]!.assignment)
    });
    expect(events.indexOf("orca:create_task")).toBeLessThan(events.indexOf("artifact:stage:1"));
    expect(events.indexOf("artifact:stage:1")).toBeLessThan(events.indexOf("orca:dispatch_worker"));
    expect([...store.dispatches.values()][0]).toMatchObject({
      assignmentArtifact: {
        version: 1,
        ownerDispatchId: "dispatch:proposal-1:implement:1",
        sha256: staged?.sha256
      }
    });
  });

  it("cleans the exact staged artifact when its first lifecycle write fails", async () => {
    // Break caught: a failed metadata write must not erase the only cleanup handle before mutation.
    const setupResult = setup();
    setupResult.store.failAssignmentArtifactSaveOnce = true;

    await expect(setupResult.service.start(authorized()))
      .rejects.toThrow("synthetic assignment artifact persistence failure");

    expect(setupResult.orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toEqual([]);
    expect(setupResult.artifacts.cleaned).toEqual([setupResult.artifacts.staged[0]]);
    expect(setupResult.locks.released).toEqual([{
      lockKey: project.lockKey,
      dispatchId: "dispatch:proposal-1:implement:1"
    }]);
    expect(setupResult.store.dispatches.get("dispatch:proposal-1:implement:1"))
      .toMatchObject({
        assignmentArtifact: setupResult.artifacts.staged[0],
        assignmentArtifactCleanup: { kind: "removed" },
        state: "intervention_required"
      });
  });

  it("retains the lease and persists ownership when pre-start artifact cleanup fails", async () => {
    // Break caught: cleanup uncertainty cannot free edit authority or orphan an unowned file.
    const setupResult = setup();
    setupResult.store.failAssignmentArtifactSaveOnce = true;
    setupResult.artifacts.cleanupError = Object.assign(
      new Error("synthetic assignment artifact cleanup failure"),
      { code: "assignment_artifact_cleanup_failed", retryable: false }
    );

    await expect(setupResult.service.start(authorized()))
      .rejects.toThrow("synthetic assignment artifact persistence failure");

    expect(setupResult.orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toEqual([]);
    expect(setupResult.artifacts.cleaned).toEqual([]);
    expect(setupResult.locks.released).toEqual([]);
    expect(setupResult.store.dispatches.get("dispatch:proposal-1:implement:1"))
      .toMatchObject({
        assignmentArtifact: setupResult.artifacts.staged[0],
        assignmentArtifactCleanupFailure: {
          code: "assignment_artifact_cleanup_failed",
          retryable: false
        },
        state: "intervention_required"
      });
  });

  it("retains the lease when a safe rejection cleanup outcome cannot be persisted", async () => {
    // Break caught: deleting the file is insufficient until its exact cleanup outcome is durable.
    const setupResult = setup();
    setupResult.store.failAssignmentArtifactCleanupSaveOnce = true;
    setupResult.orca.dispatchErrorOnCall = 1;

    await expect(setupResult.service.start(authorized())).rejects.toMatchObject({
      code: "provider_process_failed",
      workerMayBeLive: false
    });

    expect(setupResult.artifacts.cleaned).toEqual([setupResult.artifacts.staged[0]]);
    expect(setupResult.locks.released).toEqual([]);
    expect(setupResult.store.dispatches.get("dispatch:proposal-1:implement:1"))
      .toMatchObject({
        assignmentArtifact: setupResult.artifacts.staged[0],
        assignmentArtifactCleanupFailure: {
          code: "assignment_artifact_cleanup_persistence_failed",
          retryable: false
        },
        state: "intervention_required"
      });
  });

  it.each([
    {
      name: "content",
      tamper(receipt: ProviderStartReceipt): ProviderStartReceipt {
        const content = `${receipt.promptArtifact.content} `;
        return {
          ...receipt,
          promptArtifact: {
            ...receipt.promptArtifact,
            content,
            sha256: createHash("sha256").update(content).digest("hex")
          }
        };
      }
    },
    {
      name: "sha256",
      tamper(receipt: ProviderStartReceipt): ProviderStartReceipt {
        return {
          ...receipt,
          promptArtifact: { ...receipt.promptArtifact, sha256: "0".repeat(64) }
        };
      }
    }
  ])("rejects a schema-valid provider receipt with altered prompt $name", async ({ tamper }) => {
    // Break caught: IDs alone cannot bind a provider receipt to the authorized assignment bytes.
    const setupResult = setup(new MemoryGit(), undefined, (orca) => {
      const delegate = new CodexWorkerProvider({ orca });
      const provider: WorkerProvider = {
        id: "codex",
        start: async (assignment, context) => tamper(await delegate.start(assignment, context)),
        inspect: (dispatchId) => delegate.inspect(dispatchId)
      };
      return { get: () => provider };
    });

    await expect(setupResult.service.start(authorized())).rejects.toMatchObject({
      code: "invalid_provider_receipt",
      provider: "codex",
      phase: "start",
      workerMayBeLive: true,
      trustedDispatchId: "orca-dispatch-1"
    });
    expect(setupResult.orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([{
      kind: "stop_worker",
      dispatchId: "orca-dispatch-1"
    }]);
    expect(setupResult.artifacts.cleaned).toEqual([setupResult.artifacts.staged[0]]);
    expect(setupResult.locks.released).toEqual([{
      lockKey: project.lockKey,
      dispatchId: "dispatch:proposal-1:implement:1"
    }]);
    expect(setupResult.store.dispatches.get("dispatch:proposal-1:implement:1"))
      .toMatchObject({
        state: "intervention_required",
        orcaDispatchId: "orca-dispatch-1",
        fenceReceipt: {
          id: "stop-receipt-orca-dispatch-1",
          result: { dispatchId: "orca-dispatch-1", verdict: "stopped" }
        },
        assignmentArtifactCleanup: { kind: "removed" }
      });
  });

  it("does not fence an unbound top-level provider Dispatch ID", async () => {
    // Break caught: a provider receipt must not redirect stop_worker away from Orca's nested receipt.
    const setupResult = setup(new MemoryGit(), undefined, (orca) => {
      const delegate = new CodexWorkerProvider({ orca });
      const provider: WorkerProvider = {
        id: "codex",
        start: async (assignment, context) => ({
          ...await delegate.start(assignment, context),
          orcaDispatchId: "orca-dispatch-unrelated"
        }),
        inspect: (dispatchId) => delegate.inspect(dispatchId)
      };
      return { get: () => provider };
    });

    const caught = await setupResult.service.start(authorized()).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: "invalid_provider_receipt",
      provider: "codex",
      phase: "start",
      workerMayBeLive: true
    });
    expect((caught as { trustedDispatchId?: string }).trustedDispatchId).toBeUndefined();
    expect(setupResult.orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([]);
    expect(setupResult.artifacts.cleaned).toEqual([]);
    expect(setupResult.locks.released).toEqual([]);
  });

  it("retains resources when a malformed raw start receipt contains an unrelated Dispatch ID", async () => {
    // Break caught: an unparsed result ID must not authorize stop or release the project fence.
    const setupResult = setup();
    setupResult.orca.malformedDispatchId = "orca-dispatch-unrelated";

    const caught = await setupResult.service.start(authorized()).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: "invalid_provider_receipt",
      workerMayBeLive: true
    });
    expect((caught as { trustedDispatchId?: string }).trustedDispatchId).toBeUndefined();
    expect(setupResult.orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([]);
    expect(setupResult.artifacts.cleaned).toEqual([]);
    expect(setupResult.locks.released).toEqual([]);
  });

  it("retains resources when a parsed start receipt belongs to another Task", async () => {
    // Break caught: exact Dispatch syntax is insufficient without exact expected Task binding.
    const setupResult = setup();
    setupResult.orca.dispatchTaskId = "orca-task-unrelated";

    const caught = await setupResult.service.start(authorized()).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: "invalid_provider_receipt",
      workerMayBeLive: true
    });
    expect((caught as { trustedDispatchId?: string }).trustedDispatchId).toBeUndefined();
    expect(setupResult.orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([]);
    expect(setupResult.artifacts.cleaned).toEqual([]);
    expect(setupResult.locks.released).toEqual([]);
  });

  it("fences only the fully bound Dispatch when later environment attestation fails", async () => {
    // Break caught: post-binding validation may stop the exact worker, never a raw or mismatched ID.
    const setupResult = setup();
    setupResult.orca.effectiveEnvironmentKeys = ["HOME"];

    await expect(setupResult.service.start(authorized())).rejects.toMatchObject({
      code: "invalid_provider_receipt",
      workerMayBeLive: true,
      trustedDispatchId: "orca-dispatch-1"
    });
    expect(setupResult.orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([{
      kind: "stop_worker",
      dispatchId: "orca-dispatch-1"
    }]);
    expect(setupResult.artifacts.cleaned).toEqual([setupResult.artifacts.staged[0]]);
    expect(setupResult.locks.released).toEqual([{
      lockKey: project.lockKey,
      dispatchId: "dispatch:proposal-1:implement:1"
    }]);
    expect(setupResult.store.dispatches.get("dispatch:proposal-1:implement:1"))
      .toMatchObject({
        orcaDispatchId: "orca-dispatch-1",
        fenceReceipt: {
          result: { dispatchId: "orca-dispatch-1", verdict: "stopped" }
        }
      });
  });

  it("persists immutable inputs, public receipts, and every lifecycle transition", async () => {
    // Break caught: receipt-free state cannot prove which public Orca mutation created a worker.
    const { service, store } = setup();

    await service.start(authorized());

    expect([...store.runs.values()][0]).toMatchObject({
      id: "run:proposal-1",
      state: "active",
      orcaRunId: "orca-run-1",
      receipt: { id: "run-receipt", ok: true }
    });
    expect([...store.tasks.values()][0]).toMatchObject({
      id: "task:proposal-1:implement",
      state: "running",
      orcaTaskId: "orca-task-1",
      receipt: { id: "task-receipt-1", ok: true }
    });
    expect([...store.dispatches.values()][0]).toMatchObject({
      id: "dispatch:proposal-1:implement:1",
      state: "running",
      orcaDispatchId: "orca-dispatch-1",
      receipt: { id: "dispatch-receipt-1", ok: true },
      providerId: "codex",
      providerStartReceipt: {
        kind: "provider_start",
        provider: "codex",
        assignmentDispatchId: "dispatch:proposal-1:implement:1",
        orcaDispatchId: "orca-dispatch-1",
        orcaReceipt: { id: "dispatch-receipt-1", ok: true }
      },
      providerInspectReceipts: [{
        kind: "provider_inspect",
        provider: "codex",
        dispatchId: "orca-dispatch-1",
        showReceipt: { id: "show-receipt-orca-dispatch-1", ok: true },
        readReceipt: { id: "read-receipt-orca-dispatch-1", ok: true }
      }]
    });
    expect(store.transitions.map(({ entity, to }) => `${entity}:${to}`)).toEqual([
      "run:creating",
      "run:active",
      "task:creating",
      "task:ready",
      "dispatch:launching",
      "dispatch:running",
      "task:running"
    ]);
  });
});

describe("Git worktree placement", () => {
  it("creates an independent L1 worktree beside, never inside, a sandbox repository", async () => {
    // Break caught: nesting a worktree inside its repository makes isolation depend on ignored paths.
    const sandbox = await createSandboxRepo();
    sandboxes.push(sandbox);
    const sandboxProject: ProjectRegistryEntry = {
      ...project,
      absolutePath: sandbox.repositoryPath
    };
    const orca = new RecordingOrca();
    const locks = new RecordingLocks();
    const store = new MemoryLifecycleStore();
    const service = new ExecutionService({
      orca,
      placements: new GitWorktreePlacementService(sandbox.git),
      locks,
      lifecycle: new ExecutionLifecycle({ store, messages: new RecordingMessageSink() }),
      assignmentArtifacts: new MemoryAssignmentArtifactStore(),
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

    const result = await service.start(authorized(proposal, sandboxProject));

    if (result.kind !== "started") {
      throw new Error(`sandbox placement did not start: ${JSON.stringify(result)}`);
    }
    expect(result).toMatchObject({ kind: "started" });
    const assignment = [...store.dispatches.values()][0]?.assignment;
    expect(assignment?.worktree.kind).toBe("isolated");
    expect(dirname(assignment?.worktree.path ?? "")).toBe(sandbox.rootPath);
    expect(assignment?.worktree.path.startsWith(`${sandbox.repositoryPath}/`)).toBe(false);
    await expect(sandbox.git.repositoryStatus(assignment?.worktree.path ?? ""))
      .resolves.toMatchObject({ dirty: false, head: sandbox.initialCommit });
  });
});

describe("worker lifecycle", () => {
  it("rejects an Orca Task receipt that is not bound to the created Run", async () => {
    // Break caught: Task creation must bind its public Run identity before any worker can start.
    const { service, orca, store } = setup();
    orca.createTaskRunId = "orca-run-other";

    await expect(service.start(authorized())).rejects.toMatchObject({
      code: "orca_task_run_mismatch"
    });

    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toEqual([]);
    expect(store.dispatches.get("dispatch:proposal-1:implement:1")?.state)
      .not.toBe("running");
  });

  it("fences a started Dispatch whose receipt is not bound to the created Run", async () => {
    // Break caught: a provider-start receipt for another Run cannot become this Task's running worker.
    const { service, orca, store, artifacts, locks } = setup();
    orca.dispatchRunId = "orca-run-other";

    await expect(service.start(authorized())).rejects.toMatchObject({
      code: "invalid_provider_receipt"
    });

    expect(orca.calls).toContainEqual({
      kind: "stop_worker",
      dispatchId: "orca-dispatch-1"
    });
    expect(store.dispatches.get("dispatch:proposal-1:implement:1")?.state)
      .toBe("intervention_required");
    expect(artifacts.cleaned).toEqual([artifacts.staged[0]]);
    expect(locks.released).toHaveLength(1);
  });

  it.each([
    {
      name: "Task identity",
      corrupt: (orca: RecordingOrca) => { orca.showTaskId = "orca-task-other"; }
    },
    {
      name: "Run identity",
      corrupt: (orca: RecordingOrca) => { orca.showRunId = "orca-run-other"; }
    },
    {
      name: "terminal ownership",
      corrupt: (orca: RecordingOrca) => { orca.showTerminalOwnershipState = "unowned"; }
    },
    {
      name: "show/read state coherence",
      corrupt: (orca: RecordingOrca) => { orca.readWorkerState = "running"; }
    }
  ])("fences initial inspection with mismatched $name before marking the Dispatch running", async ({ corrupt }) => {
    // Break caught: exact Dispatch alone is insufficient when Task/Run/terminal/state ownership differs.
    const { service, orca, store } = setup();
    corrupt(orca);

    await expect(service.start(authorized())).rejects.toMatchObject({
      code: "invalid_provider_receipt"
    });

    expect(orca.calls).toContainEqual({
      kind: "stop_worker",
      dispatchId: "orca-dispatch-1"
    });
    expect(store.dispatches.get("dispatch:proposal-1:implement:1")?.state)
      .toBe("intervention_required");
    expect(store.transitions).not.toContainEqual(expect.objectContaining({
      entity: "dispatch",
      entityId: "dispatch:proposal-1:implement:1",
      to: "running"
    }));
  });

  it("dispatches one opposite-family verifier for every implementation Task", async () => {
    // Break caught: verifying only the final worker_done leaves earlier implementation output unchecked.
    const harness = executionVerificationHarness();
    const { service, store } = setup(
      new MemoryGit(), undefined, undefined, undefined, harness.verification
    );
    const multiTaskProposal: ExecutionProposal = {
      ...proposal,
      tasks: [
        proposal.tasks[0]!,
        {
          localId: "implement-client",
          title: "Implement the client change",
          dependsOn: [],
          role: "implement",
          preferredAgent: "claude"
        }
      ]
    };
    await service.start(authorized(multiTaskProposal));
    await service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "multi-implementation-1",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "server implementation complete"
    });

    await expect(service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "multi-implementation-2",
      dispatchId: "orca-dispatch-2",
      outcome: "completed",
      summary: "client implementation complete"
    })).resolves.toMatchObject({
      dispatched: ["orca-dispatch-3", "orca-dispatch-4"]
    });

    expect(harness.store.tasks).toHaveLength(2);
    expect(harness.store.tasks.map((task) => ({
      implementationTaskId: task.implementationTaskId,
      implementationProvider: task.implementationProvider,
      verifierProvider: task.preferredAgent
    }))).toEqual([
      {
        implementationTaskId: "task:proposal-1:implement",
        implementationProvider: "codex",
        verifierProvider: "claude"
      },
      {
        implementationTaskId: "task:proposal-1:implement-client",
        implementationProvider: "claude",
        verifierProvider: "codex"
      }
    ]);
    expect([...store.dispatches.values()].slice(2).map(({ assignment }) => ({
      role: assignment.role,
      provider: assignment.preferredAgent,
      permissions: assignment.permissions
    }))).toEqual([
      { role: "verify", provider: "claude", permissions: "read-only" },
      { role: "verify", provider: "codex", permissions: "read-only" }
    ]);
  });

  it("dispatches a separate Fix Task and the next-cycle verifier after a failed report", async () => {
    // Break caught: persisting a Fix Task without public-Orca dispatch makes bounded cycles dead code.
    const harness = executionVerificationHarness();
    const { service, orca, store } = setup(
      new MemoryGit(), undefined, undefined, undefined, harness.verification
    );
    await service.start(authorized());
    await service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "fix-cycle-implementation",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    });
    await service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "fix-cycle-verifier",
      dispatchId: "orca-dispatch-2",
      outcome: "completed",
      summary: "verification found a defect"
    });
    const task = harness.store.tasks[0];
    if (task === undefined) throw new Error("verifier Task was not created");
    const failedReport: VerificationReport = {
      reportId: "report:fix-cycle:0",
      runId: task.runId,
      verificationTaskId: task.taskId,
      implementationTaskId: task.implementationTaskId,
      implementationDispatchId: task.implementationDispatchId,
      cycle: task.cycle,
      verdict: "fail",
      projectRoute: task.projectRoute,
      changedFiles: task.changedFiles,
      diffSha256: task.gitDiff.sha256,
      diffSummary: task.gitDiff.summary,
      commands: harness.verifierCommands,
      implementationProvider: task.implementationProvider,
      verifierProvider: task.preferredAgent,
      findings: ["acceptance behavior is incomplete"],
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

    await expect(service.recordVerificationReport(failedReport)).resolves.toEqual({
      kind: "create_fix_task",
      findings: ["acceptance behavior is incomplete"],
      nextCycle: 1
    });
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")[2]).toMatchObject({
      kind: "dispatch_worker",
      taskId: "orca-task-3",
      agent: "codex"
    });
    expect([...store.dispatches.values()][2]).toMatchObject({
      assignment: { role: "implement", permissions: "read-write" }
    });

    await expect(service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "fix-cycle-fix-done",
      dispatchId: "orca-dispatch-3",
      outcome: "completed",
      summary: "fix complete"
    })).resolves.toMatchObject({ dispatched: ["orca-dispatch-4"] });
    expect(harness.store.tasks[1]).toMatchObject({
      role: "verify",
      cycle: 1,
      preferredAgent: "claude"
    });
  });

  it("resumes verifier dispatch when worker_done redelivery follows a collector failure", async () => {
    // Break caught: durable worker_done dedupe must not strand later verification side effects.
    let attempts = 0;
    const harness = executionVerificationHarness(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("synthetic evidence collector failure");
      return {
        changedFiles: ["src/api.ts"],
        gitDiff: { sha256: "a".repeat(64), summary: "1 file changed" },
        testReceipts: [{
          command: "pnpm test",
          exitCode: 0,
          outcome: "passed",
          auditReference: "audit:implementation:test"
        }],
        auditReferences: ["audit:implementation:dispatch"]
      };
    });
    const { service, orca } = setup(
      new MemoryGit(), undefined, undefined, undefined, harness.verification
    );
    await service.start(authorized());
    const done: WorkerMessage = {
      kind: "worker_done",
      messageId: "resume-verification-after-collector",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    };

    await expect(service.recordWorkerMessage(done))
      .rejects.toThrow("synthetic evidence collector failure");
    await expect(service.recordWorkerMessage(done)).resolves.toMatchObject({
      kind: "recorded",
      dispatched: ["orca-dispatch-2"]
    });
    expect(orca.calls.filter(({ kind }) => kind === "release_worker")).toHaveLength(1);
    expect(harness.store.tasks).toHaveLength(1);
  });

  it("resumes the same verifier Task when worker_done redelivery follows create_task failure", async () => {
    // Break caught: durable worker_done must resume a partially-created verifier without duplicating its identity.
    const harness = executionVerificationHarness();
    const { service, orca } = setup(
      new MemoryGit(), undefined, undefined, undefined, harness.verification
    );
    await service.start(authorized());
    orca.createTaskErrorOnCall = 2;
    const done: WorkerMessage = {
      kind: "worker_done",
      messageId: "resume-verifier-create-task",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    };

    await expect(service.recordWorkerMessage(done)).rejects.toThrow("synthetic create_task failure");
    await expect(service.recordWorkerMessage(done)).resolves.toMatchObject({
      dispatched: ["orca-dispatch-2"]
    });
    expect(harness.store.tasks).toHaveLength(1);
    expect(orca.calls.filter(({ kind }) => kind === "create_task")).toHaveLength(3);
  });

  it("dispatches an opposite-family read-only verifier after the implementation finishes", async () => {
    // Break caught: stopping at awaiting_verification leaves VerificationService as dead production code.
    const verificationStore = new MemoryVerificationLifecycleStore();
    const verificationService = new VerificationService({
      store: verificationStore,
      completionTarget: {
        commandId: proposal.commandId,
        channel: "slack",
        destination: "C123",
        nextAttemptAt: "2026-09-02T00:00:00.000Z"
      }
    });
    const { service, orca, store } = setup(
      new MemoryGit(),
      undefined,
      undefined,
      undefined,
      {
        service: verificationService,
        evidence: {
          collectImplementation: () => ({
            changedFiles: ["src/api.ts"],
            gitDiff: {
              sha256: "a".repeat(64),
              summary: "1 file changed"
            },
            testReceipts: [{
              command: "pnpm test",
              exitCode: 0,
              outcome: "passed",
              auditReference: "audit:implementation:test:1"
            }],
            auditReferences: ["audit:implementation:dispatch:1"]
          }),
          captureRepositorySnapshot: ({ dispatch }: { dispatch: DispatchRecord }) =>
            hostRepositorySnapshotFor(dispatch)
        }
      }
    );
    await service.start(authorized());

    await expect(service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "done-before-verification-dispatch",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    })).resolves.toMatchObject({
      kind: "recorded",
      verificationRequired: true,
      dispatched: ["orca-dispatch-2"]
    });

    expect(verificationStore.tasks).toHaveLength(1);
    expect(verificationStore.tasks[0]).toMatchObject({
      role: "verify",
      preferredAgent: "claude",
      permissions: "read-only",
      nestedWorkers: "forbidden",
      implementationDispatchId: "dispatch:proposal-1:implement:1"
    });
    const verifierTaskCall = orca.calls.filter(({ kind }) => kind === "create_task")[1];
    expect(verifierTaskCall).toMatchObject({
      kind: "create_task",
      dependencies: ["orca-task-1"]
    });
    expect(JSON.parse(verifierTaskCall?.kind === "create_task" ? verifierTaskCall.spec : "{}"))
      .toMatchObject({
        task: {
          role: "verify",
          preferredAgent: "claude"
        },
        authorization: {
          permissions: "read-only",
          nestedWorkers: "forbidden"
        }
      });
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")[1]).toMatchObject({
      kind: "dispatch_worker",
      taskId: "orca-task-2",
      agent: "claude"
    });
    expect([...store.dispatches.values()][1]).toMatchObject({
      state: "running",
      providerId: "claude",
      assignment: {
        role: "verify",
        preferredAgent: "claude",
        permissions: "read-only"
      }
    });
  });

  it("uses durable trusted-host snapshots and command evidence to fail closed on verifier mutation", async () => {
    // Break caught: a verifier can mutate the shared worktree and self-declare no effects unless the host compares snapshots.
    const verificationStore = new MemoryVerificationLifecycleStore();
    const verificationService = new VerificationService({
      store: verificationStore,
      completionTarget: {
        commandId: proposal.commandId,
        channel: "slack",
        destination: "C123",
        nextAttemptAt: "2026-09-02T00:00:00.000Z"
      }
    });
    const hostCommands = [{
      command: "pnpm test",
      exitCode: 0,
      outcome: "passed" as const,
      auditReference: "audit:trusted-host:verifier:test"
    }];
    let snapshotCall = 0;
    let activeOrca: RecordingOrca | undefined;
    const observedDispatchCounts: number[] = [];
    const setupResult = setup(new MemoryGit(), undefined, undefined, undefined, {
      service: verificationService,
      evidence: {
        collectImplementation: () => ({
          changedFiles: ["src/api.ts"],
          gitDiff: { sha256: "a".repeat(64), summary: "1 file changed" },
          testReceipts: [{
            command: "pnpm test",
            exitCode: 0,
            outcome: "passed" as const,
            auditReference: "audit:trusted-host:implementation:test"
          }],
          auditReferences: ["audit:trusted-host:implementation"]
        }),
        captureRepositorySnapshot: (input: { dispatch: DispatchRecord }) => {
          snapshotCall += 1;
          observedDispatchCounts.push(
            activeOrca?.calls.filter(({ kind }) => kind === "dispatch_worker").length ?? 0
          );
          return hostRepositorySnapshot({
            repositoryPath: input.dispatch.assignment.repo.repositoryPath,
            worktreePath: input.dispatch.assignment.worktree.path,
            worktreeKind: input.dispatch.assignment.worktree.kind,
            head: input.dispatch.assignment.worktree.head,
            branch: input.dispatch.assignment.worktree.branch,
            statusSha256: (snapshotCall === 1 ? "b" : "c").repeat(64),
            auditReference: `audit:trusted-host:snapshot:${snapshotCall}`
          });
        },
        collectVerifierCommands: () => hostCommands
      }
    } as never);
    activeOrca = setupResult.orca;
    await setupResult.service.start(authorized());
    await setupResult.service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "snapshot-implementation-done",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    });
    const verifierTask = verificationStore.tasks[0];
    if (verifierTask === undefined) throw new Error("verifier Task missing");

    const completion = await setupResult.service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "snapshot-verifier-done",
      dispatchId: "orca-dispatch-2",
      outcome: "completed",
      summary: "all checks pass and no files changed"
    });

    await expect(setupResult.service.recordVerificationReport(
      reportForTask(verifierTask, hostCommands, "report:mutating-verifier")
    )).rejects.toMatchObject({ code: "verifier_repository_mutation" });
    expect(completion).toEqual({
      kind: "review_required",
      reason: "verifier_repository_mutation",
      dispatchId: "orca-dispatch-2"
    });
    expect(observedDispatchCounts).toEqual([1, 2]);
    expect(verificationStore.commits).toEqual([]);
    expect(setupResult.store.dispatches.get("dispatch:task:proposal-1:implement:verify:0:1"))
      .toMatchObject({
        repositorySnapshots: {
          mutated: true,
          before: { auditReference: "audit:trusted-host:snapshot:1" },
          after: { auditReference: "audit:trusted-host:snapshot:2" }
        }
      });
    expect(setupResult.store.runs.get("run:proposal-1")?.state)
      .toBe("intervention_required");
  });

  it("releases the exact verifier before the trusted post-snapshot and host commands", async () => {
    // Break caught: a verifier that is still live after the post-snapshot can mutate the shared worktree undetected.
    const verificationStore = new MemoryVerificationLifecycleStore();
    const verificationService = new VerificationService({
      store: verificationStore,
      completionTarget: {
        commandId: proposal.commandId,
        channel: "slack",
        destination: "C123",
        nextAttemptAt: "2026-09-02T00:00:00.000Z"
      }
    });
    const observedReleaseCounts: Array<Readonly<{ phase: string; count: number }>> = [];
    let activeOrca: RecordingOrca | undefined;
    const setupResult = setup(new MemoryGit(), undefined, undefined, undefined, {
      service: verificationService,
      evidence: {
        collectImplementation: () => ({
          changedFiles: ["src/api.ts"],
          gitDiff: { sha256: "a".repeat(64), summary: "1 file changed" },
          testReceipts: [{
            command: "pnpm test",
            exitCode: 0,
            outcome: "passed" as const,
            auditReference: "audit:release-order:implementation"
          }],
          auditReferences: ["audit:release-order:dispatch"]
        }),
        captureRepositorySnapshot: ({
          dispatch,
          phase
        }: {
          dispatch: DispatchRecord;
          phase: "before_verifier" | "after_verifier";
        }) => {
          observedReleaseCounts.push({
            phase,
            count: activeOrca?.calls.filter(({ kind }) => kind === "release_worker").length ?? 0
          });
          return hostRepositorySnapshotFor(dispatch);
        },
        collectVerifierCommands: () => {
          observedReleaseCounts.push({
            phase: "commands",
            count: activeOrca?.calls.filter(({ kind }) => kind === "release_worker").length ?? 0
          });
          return [{
            command: "pnpm test",
            exitCode: 0,
            outcome: "passed" as const,
            auditReference: "audit:release-order:verifier"
          }];
        }
      }
    } as never);
    activeOrca = setupResult.orca;
    await setupResult.service.start(authorized());
    await setupResult.service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "release-order-implementation",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    });

    await setupResult.service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "release-order-verifier",
      dispatchId: "orca-dispatch-2",
      outcome: "completed",
      summary: "verification complete"
    });

    expect(observedReleaseCounts).toEqual([
      { phase: "before_verifier", count: 1 },
      { phase: "after_verifier", count: 2 },
      { phase: "commands", count: 2 }
    ]);
  });

  it("binds verifier snapshots to the implementation diff while allowing a committed implementation HEAD", async () => {
    // Break caught: binding the verifier baseline to the original worktree HEAD rejects legitimate implementation commits.
    const harness = executionVerificationHarness();
    const committedHead = "f".repeat(40);
    const { service, store } = setup(
      new MemoryGit(),
      undefined,
      undefined,
      undefined,
      {
        ...harness.verification,
        evidence: {
          ...harness.verification.evidence,
          captureRepositorySnapshot: ({ dispatch }: { dispatch: DispatchRecord }) =>
            hostRepositorySnapshot({
              repositoryPath: dispatch.assignment.repo.repositoryPath,
              worktreePath: dispatch.assignment.worktree.path,
              worktreeKind: dispatch.assignment.worktree.kind,
              head: committedHead,
              branch: dispatch.assignment.worktree.branch,
              diffSha256: "a".repeat(64)
            })
        }
      }
    );
    await service.start(authorized());

    await expect(service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "committed-head-implementation",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation committed locally"
    })).resolves.toMatchObject({ dispatched: ["orca-dispatch-2"] });
    await service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "committed-head-verifier",
      dispatchId: "orca-dispatch-2",
      outcome: "completed",
      summary: "verification complete"
    });

    expect(store.dispatches.get("dispatch:task:proposal-1:implement:verify:0:1"))
      .toMatchObject({
        repositorySnapshots: {
          mutated: false,
          before: { head: committedHead, diffSha256: "a".repeat(64) },
          after: { head: committedHead, diffSha256: "a".repeat(64) }
        }
      });
  });

  it("rejects a verifier baseline whose trusted diff does not match implementation evidence", async () => {
    // Break caught: a verifier can otherwise be launched against repository content other than the reviewed implementation diff.
    const harness = executionVerificationHarness();
    const { service, orca } = setup(
      new MemoryGit(),
      undefined,
      undefined,
      undefined,
      {
        ...harness.verification,
        evidence: {
          ...harness.verification.evidence,
          captureRepositorySnapshot: ({ dispatch }: { dispatch: DispatchRecord }) =>
            hostRepositorySnapshot({
              repositoryPath: dispatch.assignment.repo.repositoryPath,
              worktreePath: dispatch.assignment.worktree.path,
              worktreeKind: dispatch.assignment.worktree.kind,
              head: "f".repeat(40),
              branch: dispatch.assignment.worktree.branch,
              diffSha256: "b".repeat(64)
            })
        }
      }
    );
    await service.start(authorized());

    await expect(service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "wrong-baseline-diff",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    })).rejects.toThrow("verification repository baseline diff does not match implementation evidence");
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
  });

  it("accepts a verification report only after its exact verifier Dispatch evidence is durable", async () => {
    // Break caught: a caller-shaped report must not complete a Run before the assigned verifier finishes.
    const verificationStore = new MemoryVerificationLifecycleStore();
    const verificationService = new VerificationService({
      store: verificationStore,
      completionTarget: {
        commandId: proposal.commandId,
        channel: "slack",
        destination: "C123",
        nextAttemptAt: "2026-09-02T00:00:00.000Z"
      }
    });
    const verifierCommands = [{
      command: "pnpm test",
      exitCode: 0,
      outcome: "passed" as const,
      auditReference: "audit:verifier:command:1"
    }];
    const { service, store } = setup(
      new MemoryGit(),
      undefined,
      undefined,
      undefined,
      {
        service: verificationService,
        evidence: {
          collectImplementation: () => ({
            changedFiles: ["src/api.ts"],
            gitDiff: {
              sha256: "a".repeat(64),
              summary: "1 file changed"
            },
            testReceipts: [{
              command: "pnpm test",
              exitCode: 0,
              outcome: "passed",
              auditReference: "audit:implementation:test:1"
            }],
            auditReferences: ["audit:implementation:dispatch:1"]
          }),
          captureRepositorySnapshot: ({ dispatch }: { dispatch: DispatchRecord }) =>
            hostRepositorySnapshotFor(dispatch),
          collectVerifierCommands: () => verifierCommands
        }
      }
    );
    await service.start(authorized());
    await service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "implementation-done-for-report",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    });
    const verificationTask = verificationStore.tasks[0];
    if (verificationTask === undefined) throw new Error("verifier Task was not created");
    const report: VerificationReport = {
      reportId: "report:execution-service:1",
      runId: verificationTask.runId,
      verificationTaskId: verificationTask.taskId,
      implementationTaskId: verificationTask.implementationTaskId,
      implementationDispatchId: verificationTask.implementationDispatchId,
      cycle: verificationTask.cycle,
      verdict: "pass",
      projectRoute: verificationTask.projectRoute,
      changedFiles: verificationTask.changedFiles,
      diffSha256: verificationTask.gitDiff.sha256,
      diffSummary: verificationTask.gitDiff.summary,
      commands: verifierCommands,
      implementationProvider: verificationTask.implementationProvider,
      verifierProvider: verificationTask.preferredAgent,
      findings: [],
      evidence: ["audit:verifier:command:1"],
      auditReferences: [
        ...verificationTask.auditReferences,
        "audit:verifier:command:1"
      ],
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
    const verificationExecution = service as unknown as {
      recordVerificationReport(value: VerificationReport): Promise<unknown>;
    };

    await expect(Promise.resolve().then(() => verificationExecution.recordVerificationReport(report)))
      .rejects.toThrow("worker_done");

    await service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "verifier-done-for-report",
      dispatchId: "orca-dispatch-2",
      outcome: "completed",
      summary: "verification complete"
    });
    await expect(verificationExecution.recordVerificationReport(report)).resolves.toEqual({
      kind: "verified_success",
      evidence: ["audit:verifier:command:1"]
    });
    const transitionCount = store.transitions.length;
    await expect(verificationExecution.recordVerificationReport(structuredClone(report)))
      .resolves.toEqual({
        kind: "verified_success",
        evidence: ["audit:verifier:command:1"]
      });
    expect([...store.dispatches.values()][1]).toMatchObject({
      state: "worker_done",
      verificationCommands: verifierCommands
    });
    expect(store.transitions).toHaveLength(transitionCount);
    expect(verificationStore.commits).toHaveLength(1);
  });

  it("completes the fake-Orca execution and verification chain through one durable ControlStore", async () => {
    // Break caught: separate in-memory lifecycle data leaves the SQLite completion gate unable to authenticate workers.
    const database = openDatabase(":memory:");
    try {
      const now = "2026-09-02T00:00:00.000Z";
      database.prepare(`
        INSERT INTO principals (id, payload_json, created_at, updated_at)
        VALUES ('owner', '{}', ?, ?)
      `).run(now, now);
      database.prepare(`
        INSERT INTO commands (
          id, idempotency_key, channel, external_message_id, principal_id,
          received_at, payload_json, created_at
        ) VALUES ('command-1', 'test:durable-chain', 'slack', '171.002', 'owner', ?, '{}', ?)
      `).run(now, now);
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const lifecycle = new ExecutionLifecycle({ store, messages: new RecordingMessageSink() });
      const verification = new VerificationService({
        store,
        completionTarget: {
          commandId: proposal.commandId,
          channel: "slack",
          destination: "C123",
          nextAttemptAt: now
        }
      });
      const verifierCommands = [{
        command: "pnpm test",
        exitCode: 0,
        outcome: "passed" as const,
        auditReference: "audit:durable:verifier:test"
      }];
      const service = new ExecutionService({
        orca,
        placements: new GitWorktreePlacementService(new MemoryGit()),
        locks: new RecordingLocks(),
        lifecycle,
        assignmentArtifacts: new MemoryAssignmentArtifactStore(),
        providerCapabilities: {
          codex: { worker: "available", hq: "available" },
          claude: { worker: "available", hq: "unavailable" },
          providerChildEnvironmentIsolation: {
            kind: "verified_effective_allowlist",
            effectiveEnvironmentKeys: ["HOME", "PATH"]
          },
          assignmentArtifactAccess: { kind: "same_host" }
        },
        verification: {
          service: verification,
          evidence: {
            collectImplementation: () => ({
              changedFiles: ["src/api.ts"],
              gitDiff: { sha256: "a".repeat(64), summary: "1 file changed" },
              testReceipts: [{
                command: "pnpm test",
                exitCode: 0,
                outcome: "passed",
                auditReference: "audit:durable:implementation:test"
              }],
              auditReferences: ["audit:durable:implementation:dispatch"]
            }),
            captureRepositorySnapshot: ({ dispatch }: { dispatch: DispatchRecord }) =>
              hostRepositorySnapshotFor(dispatch),
            collectVerifierCommands: () => verifierCommands
          }
        }
      });

      await service.start(authorized());
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "durable-implementation-done",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "implementation complete"
      });
      const verificationTask = store.listTasks().find(({ role }) => role === "verify")
        ?.payload as VerificationTask | undefined;
      if (verificationTask === undefined) throw new Error("durable verifier Task was not created");
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "durable-verifier-done",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "verification complete"
      });
      const report: VerificationReport = {
        reportId: "report:durable:1",
        runId: verificationTask.runId,
        verificationTaskId: verificationTask.taskId,
        implementationTaskId: verificationTask.implementationTaskId,
        implementationDispatchId: verificationTask.implementationDispatchId,
        cycle: verificationTask.cycle,
        verdict: "pass",
        projectRoute: verificationTask.projectRoute,
        changedFiles: verificationTask.changedFiles,
        diffSha256: verificationTask.gitDiff.sha256,
        diffSummary: verificationTask.gitDiff.summary,
        commands: verifierCommands,
        implementationProvider: verificationTask.implementationProvider,
        verifierProvider: verificationTask.preferredAgent,
        findings: [],
        evidence: ["audit:durable:verifier:test"],
        auditReferences: [
          ...verificationTask.auditReferences,
          "audit:durable:verifier:test"
        ],
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

      await expect(service.recordVerificationReport(report)).resolves.toEqual({
        kind: "verified_success",
        evidence: ["audit:durable:verifier:test"]
      });
      expect(database.prepare("SELECT state FROM runs WHERE id = ?").get(report.runId))
        .toEqual({ state: "verified_success" });
      expect(store.listOutbox()).toContainEqual(expect.objectContaining({ template: "success" }));
    } finally {
      database.close();
    }
  });

  it("persists every implementation obligation before verifier creation and withholds partial success", async () => {
    // Break caught: a verifier create failure must not erase the unlaunched implementation obligation.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-obligations");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const service = durableExecutionService(store, orca);
      const multiTaskProposal: ExecutionProposal = {
        ...proposal,
        tasks: [
          proposal.tasks[0]!,
          {
            localId: "implement-client",
            title: "Implement the client change",
            dependsOn: [],
            role: "implement",
            preferredAgent: "claude"
          }
        ]
      };
      await service.start(authorized(multiTaskProposal));
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "durable-obligation-server",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "server implementation complete"
      });
      orca.createTaskErrorOnCall = 4;
      const clientDone: WorkerMessage = {
        kind: "worker_done",
        messageId: "durable-obligation-client",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "client implementation complete"
      };
      await expect(service.recordWorkerMessage(clientDone))
        .rejects.toThrow("synthetic create_task failure 4");

      const runPayload = JSON.parse((database.prepare(`
        SELECT payload_json FROM runs WHERE id = 'run:proposal-1'
      `).get() as { payload_json: string }).payload_json) as {
        verificationObligations: Array<{ status: string }>;
      };
      expect(runPayload.verificationObligations).toHaveLength(2);
      expect(runPayload.verificationObligations.map(({ status }) => status))
        .toEqual(["verifier_running", "verifier_running"]);

      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "durable-obligation-first-verifier",
        dispatchId: "orca-dispatch-3",
        outcome: "completed",
        summary: "first verifier complete"
      });
      const firstVerifier = store.listTasks().find((task) =>
        task.role === "verify" && task.payload.implementationTaskId ===
          "task:proposal-1:implement"
      )?.payload as VerificationTask | undefined;
      if (firstVerifier === undefined) throw new Error("first verifier Task missing");
      await service.recordVerificationReport(
        durableReport(firstVerifier, "pass", "report:durable:partial-pass")
      );

      expect(database.prepare("SELECT state FROM runs WHERE id = 'run:proposal-1'").get())
        .toEqual({ state: "awaiting_verification" });
      expect(store.listOutbox()).toEqual([]);

      await expect(service.recordWorkerMessage(clientDone)).resolves.toMatchObject({
        dispatched: expect.arrayContaining(["orca-dispatch-4"])
      });
      expect(store.listTasks().filter(({ role }) => role === "verify")).toHaveLength(2);
      expect(orca.calls.filter(({ kind }) => kind === "create_task")).toHaveLength(5);
    } finally {
      database.close();
    }
  });

  it("cannot overwrite durable Run success after another verifier context fails to materialize", async () => {
    // Break caught: in-memory task counting must not override a durable missing-verifier obligation.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-context-failure");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      let collections = 0;
      const service = durableExecutionService(store, orca, () => {
        collections += 1;
        if (collections === 2) throw new Error("synthetic verifier context failure");
        return {
          changedFiles: ["src/api.ts"],
          gitDiff: { sha256: "a".repeat(64), summary: "1 file changed" },
          testReceipts: [{
            command: "pnpm test",
            exitCode: 0,
            outcome: "passed",
            auditReference: "audit:durable:implementation:test"
          }],
          auditReferences: ["audit:durable:implementation:dispatch"]
        };
      });
      const multiTaskProposal: ExecutionProposal = {
        ...proposal,
        tasks: [
          proposal.tasks[0]!,
          {
            localId: "implement-client",
            title: "Implement the client change",
            dependsOn: [],
            role: "implement",
            preferredAgent: "claude"
          }
        ]
      };
      await service.start(authorized(multiTaskProposal));
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "context-failure-server",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "server implementation complete"
      });
      await expect(service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "context-failure-client",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "client implementation complete"
      })).rejects.toThrow("synthetic verifier context failure");

      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "context-failure-first-verifier",
        dispatchId: "orca-dispatch-3",
        outcome: "completed",
        summary: "first verifier complete"
      });
      const firstVerifier = store.listTasks().find((task) =>
        task.role === "verify" && task.payload.implementationTaskId ===
          "task:proposal-1:implement"
      )?.payload as VerificationTask | undefined;
      if (firstVerifier === undefined) throw new Error("first verifier Task missing");
      await service.recordVerificationReport(
        durableReport(firstVerifier, "pass", "report:durable:context-partial-pass")
      );

      expect(database.prepare("SELECT state FROM runs WHERE id = 'run:proposal-1'").get())
        .toEqual({ state: "awaiting_verification" });
      expect(store.listOutbox()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("resumes one durably persisted Fix launch after a fresh service restart", async () => {
    // Break caught: failed-report replay must recover its existing Fix identity across process state loss.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-fix-restart");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const firstService = durableExecutionService(store, orca);
      await firstService.start(authorized());
      await firstService.recordWorkerMessage({
        kind: "worker_done",
        messageId: "durable-restart-implementation",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "implementation complete"
      });
      await firstService.recordWorkerMessage({
        kind: "worker_done",
        messageId: "durable-restart-verifier",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "verification found a defect"
      });
      const verificationTask = store.listTasks().find(({ role }) => role === "verify")
        ?.payload as VerificationTask | undefined;
      if (verificationTask === undefined) throw new Error("verifier Task missing");
      const failedReport = durableReport(
        verificationTask,
        "fail",
        "report:durable:fix-restart"
      );
      orca.createTaskErrorOnCall = 3;

      await expect(firstService.recordVerificationReport(failedReport))
        .rejects.toThrow("synthetic create_task failure 3");
      expect(store.listTasks().filter((task) => task.payload.sourceVerificationTaskId !== undefined))
        .toHaveLength(1);
      expect(store.listAuditEvents().filter(({ eventType }) => eventType === "verification.failed"))
        .toHaveLength(1);
      expect(store.listOutbox()).toEqual([]);

      const restartedService = durableExecutionService(store, orca);
      await expect(restartedService.recordVerificationReport(structuredClone(failedReport)))
        .resolves.toEqual({
          kind: "create_fix_task",
          findings: ["acceptance behavior is incomplete"],
          nextCycle: 1
        });

      const fixTasks = store.listTasks().filter((task) =>
        task.payload.sourceVerificationTaskId !== undefined
      );
      expect(fixTasks).toHaveLength(1);
      expect(fixTasks[0]).toMatchObject({
        taskId: "task:proposal-1:implement:fix:1",
        state: "running"
      });
      expect(orca.calls.filter(({ kind }) => kind === "create_task")).toHaveLength(4);
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(3);
      expect(store.listAuditEvents().filter(({ eventType }) => eventType === "verification.failed"))
        .toHaveLength(1);
      expect(store.listOutbox()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("resumes a durably planned verifier Dispatch after process loss before launch", async () => {
    // Break caught: returning undefined for a hydrated prelaunch verifier permanently strands its Run obligation.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-verifier-prelaunch-restart");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const firstService = durableExecutionService(store, orca);
      await firstService.start(authorized());
      const originalSaveDispatch = store.saveDispatch.bind(store);
      let crashOnVerifierDispatch = true;
      const saveDispatchSpy = vi.spyOn(store, "saveDispatch").mockImplementation((value) => {
        originalSaveDispatch(value);
        const record = value as {
          state?: unknown;
          assignment?: { role?: unknown };
        };
        if (
          crashOnVerifierDispatch
          && record.state === "planned"
          && record.assignment?.role === "verify"
        ) {
          crashOnVerifierDispatch = false;
          throw new Error("synthetic process loss after verifier Dispatch persistence");
        }
      });
      const done: WorkerMessage = {
        kind: "worker_done",
        messageId: "verifier-prelaunch-root-done",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "implementation complete"
      };
      try {
        await expect(firstService.recordWorkerMessage(done))
          .rejects.toThrow("synthetic process loss after verifier Dispatch persistence");
      } finally {
        saveDispatchSpy.mockRestore();
      }
      const plannedVerifierDispatch = store.loadDispatchesForTask(
        "task:proposal-1:implement:verify:0"
      );
      expect(plannedVerifierDispatch).toMatchObject([{ state: "planned" }]);
      expect(plannedVerifierDispatch[0]).not.toHaveProperty("orcaDispatchId");
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
      const persistedVerifier = plannedVerifierDispatch[0] as {
        id: string;
        assignment: WorkerAssignment;
      };
      const persistedVerifierRow = database.prepare(`
        SELECT payload_json FROM dispatches WHERE id = ?
      `).get(persistedVerifier.id) as { payload_json: string };
      const persistedVerifierPayload = JSON.parse(persistedVerifierRow.payload_json) as
        Record<string, unknown>;
      persistedVerifierPayload.repositorySnapshots = {
        before: hostRepositorySnapshot({
          repositoryPath: persistedVerifier.assignment.repo.repositoryPath,
          worktreePath: persistedVerifier.assignment.worktree.path,
          worktreeKind: persistedVerifier.assignment.worktree.kind,
          head: persistedVerifier.assignment.worktree.head,
          branch: persistedVerifier.assignment.worktree.branch,
          auditReference: "audit:verifier-baseline-before-process-loss"
        })
      };
      database.prepare(`
        UPDATE dispatches SET payload_json = ? WHERE id = ?
      `).run(JSON.stringify(persistedVerifierPayload), persistedVerifier.id);

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        ...done,
        messageId: "verifier-prelaunch-root-redelivery"
      })).resolves.toMatchObject({
        kind: "recorded",
        dispatched: ["orca-dispatch-2"]
      });
      expect(store.loadDispatchesForTask("task:proposal-1:implement:verify:0"))
        .toMatchObject([{ state: "running", orcaDispatchId: "orca-dispatch-2" }]);
    } finally {
      database.close();
    }
  });

  it("reuses a hydrated Fix Dispatch and active lease after process loss before launch", async () => {
    // Break caught: reconstructing a persisted Fix Dispatch reacquires authority already owned by that exact Dispatch.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-fix-prelaunch-lease-restart");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const collectImplementation = () => ({
        changedFiles: ["src/api.ts"],
        gitDiff: { sha256: "a".repeat(64), summary: "1 file changed" },
        testReceipts: [{
          command: "pnpm test",
          exitCode: 0,
          outcome: "passed" as const,
          auditReference: "audit:fix-prelaunch:implementation"
        }],
        auditReferences: ["audit:fix-prelaunch:dispatch"]
      });
      const firstService = durableExecutionService(
        store,
        orca,
        collectImplementation
      );
      await firstService.start(authorized());
      await firstService.recordWorkerMessage({
        kind: "worker_done",
        messageId: "fix-prelaunch-root-done",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "implementation complete"
      });
      await firstService.recordWorkerMessage({
        kind: "worker_done",
        messageId: "fix-prelaunch-verifier-done",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "verification found a defect"
      });
      const verifier = store.listTasks().find((task) =>
        task.role === "verify" && task.cycle === 0
      )?.payload as VerificationTask | undefined;
      if (verifier === undefined) throw new Error("cycle 0 verifier missing");
      const report = durableReport(verifier, "fail", "report:fix-prelaunch-crash");
      const originalSaveDispatch = store.saveDispatch.bind(store);
      let crashOnFixDispatch = true;
      const saveDispatchSpy = vi.spyOn(store, "saveDispatch").mockImplementation((value) => {
        originalSaveDispatch(value);
        const record = value as {
          state?: unknown;
          assignment?: { role?: unknown; taskId?: unknown };
        };
        if (
          crashOnFixDispatch
          && record.state === "planned"
          && record.assignment?.role === "implement"
          && record.assignment.taskId === "task:proposal-1:implement:fix:1"
        ) {
          crashOnFixDispatch = false;
          throw new Error("synthetic process loss after Fix Dispatch persistence");
        }
      });
      try {
        await expect(firstService.recordVerificationReport(report))
          .rejects.toThrow("synthetic process loss after Fix Dispatch persistence");
      } finally {
        saveDispatchSpy.mockRestore();
      }
      const persistedFixDispatch = store.loadDispatchesForTask(
        "task:proposal-1:implement:fix:1"
      )[0] as {
        id: string;
        assignment: {
          taskId: string;
          worktree: { path: string; branch: string | null };
        };
      } | undefined;
      if (persistedFixDispatch === undefined) throw new Error("persisted Fix Dispatch missing");
      expect(store.acquireWorktreeLock({
        lockKey: project.lockKey,
        commandId: proposal.commandId,
        taskId: persistedFixDispatch.assignment.taskId,
        projectKey: project.projectKey,
        worktreePath: persistedFixDispatch.assignment.worktree.path,
        branch: persistedFixDispatch.assignment.worktree.branch ?? "detached",
        dispatchId: persistedFixDispatch.id,
        acquiredAt: "2026-09-02T00:00:00.000Z",
        heartbeatAt: "2026-09-02T00:00:00.000Z",
        expiresAt: "2026-09-02T00:05:00.000Z"
      })).toMatchObject({ kind: "acquired" });
      expect(store.getWorktreeLock(project.lockKey)?.dispatchId)
        .toBe("dispatch:task:proposal-1:implement:fix:1:1");

      const restartedLocks = new RecordingLocks();
      await expect(durableExecutionService(
        store,
        orca,
        collectImplementation,
        restartedLocks
      ).recordVerificationReport(structuredClone(report))).resolves.toEqual({
        kind: "create_fix_task",
        findings: ["acceptance behavior is incomplete"],
        nextCycle: 1
      });

      expect(restartedLocks.acquired).toEqual([]);
      expect(store.loadDispatchesForTask("task:proposal-1:implement:fix:1"))
        .toMatchObject([{ state: "running", orcaDispatchId: "orca-dispatch-3" }]);
    } finally {
      database.close();
    }
  });

  it("hydrates a complete durable Run graph to resume implementation and verifier worker_done after restart", async () => {
    // Break caught: a fresh service must recover both local and Orca Dispatch lookup keys before completion delivery.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-worker-done-restart");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      await durableExecutionService(store, orca).start(authorized());

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "restart-implementation-done",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "implementation complete"
      })).resolves.toMatchObject({ dispatched: ["orca-dispatch-2"] });

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "restart-verifier-done",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "verification complete"
      })).resolves.toMatchObject({ kind: "recorded", verificationRequired: true });

      const verifier = store.listTasks().find((task) =>
        task.role === "verify" && task.cycle === 0
      )?.payload as VerificationTask | undefined;
      if (verifier === undefined) throw new Error("cycle 0 verifier missing");
      await expect(durableExecutionService(store, orca).recordVerificationReport(
        durableReport(verifier, "pass", "report:restart:cycle-0")
      )).resolves.toMatchObject({ kind: "verified_success" });
      expect(store.listOutbox()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("hydrates canonical completion evidence for every implementation before multi-task verification", async () => {
    // Break caught: losing a completed sibling's worker result strands its pending verification obligation after restart.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-multi-task-completion-hydration");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const multiTaskProposal: ExecutionProposal = {
        ...proposal,
        tasks: [
          proposal.tasks[0]!,
          {
            localId: "implement-client",
            title: "Implement the client change",
            dependsOn: [],
            role: "implement",
            preferredAgent: "claude"
          }
        ]
      };
      const firstService = durableExecutionService(store, orca);
      await firstService.start(authorized(multiTaskProposal));
      await expect(firstService.recordWorkerMessage({
        kind: "worker_done",
        messageId: "multi-hydration-server-done",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "server implementation complete"
      })).resolves.toMatchObject({ dispatched: ["orca-dispatch-2"] });

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "multi-hydration-client-done",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "client implementation complete"
      })).resolves.toMatchObject({
        dispatched: ["orca-dispatch-3", "orca-dispatch-4"]
      });

      database.prepare(`
        UPDATE tasks SET created_at = '2026-09-03T00:00:00.000Z'
        WHERE json_extract(payload_json, '$.role') = 'verify'
      `).run();
      const verifierTasks = store.listTasks().filter(({ role }) => role === "verify");
      expect(verifierTasks).toHaveLength(2);
      expect(verifierTasks.map(({ payload }) => payload.workerResult)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          summary: "server implementation complete",
          auditReference: "worker-message:multi-hydration-server-done"
        }),
        expect.objectContaining({
          summary: "client implementation complete",
          auditReference: "worker-message:multi-hydration-client-done"
        })
      ]));
    } finally {
      database.close();
    }
  });

  it("rejects durable verifier snapshots tampered away from the implementation diff", async () => {
    // Break caught: matching before/after snapshots are insufficient if both describe a different implementation diff.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-verifier-diff-tamper");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const service = durableExecutionService(store, orca);
      await service.start(authorized());
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "durable-diff-tamper-implementation",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "implementation complete"
      });
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "durable-diff-tamper-verifier",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "verification complete"
      });
      const verifier = store.listTasks().find((task) =>
        task.role === "verify" && task.cycle === 0
      )?.payload as VerificationTask | undefined;
      if (verifier === undefined) throw new Error("cycle 0 verifier missing");
      const dispatchRow = database.prepare(`
        SELECT id, payload_json
        FROM dispatches
        WHERE task_id = ?
      `).get(verifier.taskId) as { id: string; payload_json: string };
      const dispatchPayload = JSON.parse(dispatchRow.payload_json) as {
        repositorySnapshots: {
          before: { diffSha256: string };
          after: { diffSha256: string };
          mutated: boolean;
        };
      };
      dispatchPayload.repositorySnapshots.before.diffSha256 = "b".repeat(64);
      dispatchPayload.repositorySnapshots.after.diffSha256 = "b".repeat(64);
      dispatchPayload.repositorySnapshots.mutated = false;
      database.prepare(`
        UPDATE dispatches SET payload_json = ? WHERE id = ?
      `).run(JSON.stringify(dispatchPayload), dispatchRow.id);

      await expect(durableExecutionService(store, orca).recordVerificationReport(
        durableReport(verifier, "pass", "report:durable-diff-tamper")
      )).rejects.toThrow(
        "verification report is not bound to durable verifier Dispatch evidence"
      );
      expect(store.listOutbox()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("hydrates the latest read-write retry placement before launching post-restart verification", async () => {
    // Break caught: anchoring recovery to attempt one sends a verifier for attempt two into the stale worktree.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-latest-retry-placement");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const firstService = durableExecutionService(store, orca);
      await firstService.start(authorized());
      const retry = await firstService.recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "durable-latest-placement-retry",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      });
      expect(retry).toMatchObject({
        kind: "retried",
        dispatchId: "orca-dispatch-2",
        retryOf: "orca-dispatch-1"
      });
      const implementationDispatches = store.loadDispatchesForTask(
        "task:proposal-1:implement"
      ) as Array<{ assignment: { worktree: { path: string } } }>;
      const retryWorktree = implementationDispatches.at(-1)?.assignment.worktree.path;
      expect(retryWorktree).toBeTypeOf("string");

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "durable-latest-placement-done",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "retry implementation complete"
      })).resolves.toMatchObject({ dispatched: ["orca-dispatch-3"] });

      const verifierDispatches = store.loadDispatchesForTask(
        "task:proposal-1:implement:verify:0"
      ) as Array<{ assignment: { worktree: { path: string } } }>;
      expect(verifierDispatches).toHaveLength(1);
      expect(verifierDispatches[0]?.assignment.worktree.path).toBe(retryWorktree);
      expect(verifierDispatches[0]?.assignment.worktree.path)
        .not.toBe(implementationDispatches[0]?.assignment.worktree.path);
    } finally {
      database.close();
    }
  });

  it("hydrates Fix ancestry and exact Dispatch identities through fresh-service cycles one and two", async () => {
    // Break caught: recovering only a verifier report cannot resume worker_done for either persisted Fix generation.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-fix-worker-done-restart");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const initial = durableExecutionService(store, orca);
      await initial.start(authorized());
      await initial.recordWorkerMessage({
        kind: "worker_done",
        messageId: "restart-fix-root-done",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "root implementation complete"
      });
      await initial.recordWorkerMessage({
        kind: "worker_done",
        messageId: "restart-fix-verifier-0-done",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "cycle 0 verification failed"
      });
      const verifier0 = store.listTasks().find((task) =>
        task.role === "verify" && task.cycle === 0
      )?.payload as VerificationTask | undefined;
      if (verifier0 === undefined) throw new Error("cycle 0 verifier missing");
      await initial.recordVerificationReport(
        durableReport(verifier0, "fail", "report:restart:fix:0")
      );

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "restart-fix-1-done",
        dispatchId: "orca-dispatch-3",
        outcome: "completed",
        summary: "first Fix complete"
      })).resolves.toMatchObject({ dispatched: ["orca-dispatch-4"] });
      const cycleOneService = durableExecutionService(store, orca);
      await cycleOneService.recordWorkerMessage({
        kind: "worker_done",
        messageId: "restart-fix-verifier-1-done",
        dispatchId: "orca-dispatch-4",
        outcome: "completed",
        summary: "cycle 1 verification failed"
      });
      const verifier1 = store.listTasks().find((task) =>
        task.role === "verify" && task.cycle === 1
      )?.payload as VerificationTask | undefined;
      if (verifier1 === undefined) throw new Error("cycle 1 verifier missing");
      await cycleOneService.recordVerificationReport(
        durableReport(verifier1, "fail", "report:restart:fix:1")
      );

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "restart-fix-2-done",
        dispatchId: "orca-dispatch-5",
        outcome: "completed",
        summary: "second Fix complete"
      })).resolves.toMatchObject({ dispatched: ["orca-dispatch-6"] });
      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "restart-fix-verifier-2-done",
        dispatchId: "orca-dispatch-6",
        outcome: "completed",
        summary: "cycle 2 verification complete"
      })).resolves.toMatchObject({ kind: "recorded", verificationRequired: true });

      const runPayload = JSON.parse((database.prepare(`
        SELECT payload_json FROM runs WHERE id = 'run:proposal-1'
      `).get() as { payload_json: string }).payload_json) as {
        verificationObligations: Array<Record<string, unknown>>;
      };
      expect(runPayload.verificationObligations).toContainEqual(expect.objectContaining({
        rootImplementationTaskId: "task:proposal-1:implement",
        currentImplementationTaskId: "task:proposal-1:implement:fix:1:fix:2",
        cycle: 2,
        status: "verifier_running"
      }));
    } finally {
      database.close();
    }
  });

  it("keeps original worker_done replay idempotent after its obligation advances to a Fix", async () => {
    // Break caught: replaying cycle-0 worker_done must not revalidate it as the latest Fix lineage.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-original-replay-after-fix");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const service = durableExecutionService(store, orca);
      const originalDone: WorkerMessage = {
        kind: "worker_done",
        messageId: "original-implementation-before-fix",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "original implementation complete"
      };

      await service.start(authorized());
      await service.recordWorkerMessage(originalDone);
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "original-verifier-found-defect",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "cycle 0 verifier found a defect"
      });
      const verifier = store.listTasks().find((task) =>
        task.role === "verify" && task.cycle === 0
      )?.payload as VerificationTask | undefined;
      if (verifier === undefined) throw new Error("cycle 0 verifier missing");
      await service.recordVerificationReport(
        durableReport(verifier, "fail", "report:durable:original-replay-after-fix")
      );
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "first-fix-complete-before-original-replay",
        dispatchId: "orca-dispatch-3",
        outcome: "completed",
        summary: "first Fix complete"
      });

      const runPayloadBefore = JSON.parse((database.prepare(`
        SELECT payload_json FROM runs WHERE id = 'run:proposal-1'
      `).get() as { payload_json: string }).payload_json) as {
        verificationObligations: Array<Record<string, unknown>>;
      };
      expect(runPayloadBefore.verificationObligations).toEqual([expect.objectContaining({
        rootImplementationTaskId: "task:proposal-1:implement",
        currentImplementationTaskId: "task:proposal-1:implement:fix:1",
        cycle: 1,
        status: "verifier_running"
      })]);
      const tasksBefore = store.listTasks();
      const dispatchesBefore = database.prepare(`
        SELECT id, task_id, state, payload_json FROM dispatches ORDER BY id
      `).all();
      const auditBefore = store.listAuditEvents();
      const outboxBefore = store.listOutbox();
      const orcaCallsBefore = structuredClone(orca.calls);

      await expect(service.recordWorkerMessage(structuredClone(originalDone)))
        .resolves.toMatchObject({ kind: "recorded", verificationRequired: true });

      const runPayloadAfter = JSON.parse((database.prepare(`
        SELECT payload_json FROM runs WHERE id = 'run:proposal-1'
      `).get() as { payload_json: string }).payload_json) as {
        verificationObligations: Array<Record<string, unknown>>;
      };
      expect(runPayloadAfter.verificationObligations)
        .toEqual(runPayloadBefore.verificationObligations);
      expect(store.listTasks()).toEqual(tasksBefore);
      expect(store.listTasks().filter(({ role }) => role === "verify")).toHaveLength(2);
      expect(database.prepare(`
        SELECT id, task_id, state, payload_json FROM dispatches ORDER BY id
      `).all()).toEqual(dispatchesBefore);
      expect(store.listAuditEvents()).toEqual(auditBefore);
      expect(store.listOutbox()).toEqual(outboxBefore);
      expect(orca.calls).toEqual(orcaCallsBefore);

      const currentFixDispatchId = runPayloadBefore.verificationObligations[0]
        ?.implementationDispatchId;
      if (typeof currentFixDispatchId !== "string") {
        throw new Error("current Fix Dispatch identity missing");
      }
      expect(() => store.ensureVerificationObligations("run:proposal-1", [{
        rootImplementationTaskId: "task:proposal-1:implement",
        currentImplementationTaskId: "task:proposal-1:implement",
        implementationDispatchId: currentFixDispatchId,
        cycle: 0,
        status: "pending",
        verificationTaskId: "task:proposal-1:implement:verify:0"
      }])).toThrow("initial verification obligation");
      const runPayloadAfterConflict = JSON.parse((database.prepare(`
        SELECT payload_json FROM runs WHERE id = 'run:proposal-1'
      `).get() as { payload_json: string }).payload_json) as {
        verificationObligations: Array<Record<string, unknown>>;
      };
      expect(runPayloadAfterConflict.verificationObligations)
        .toEqual(runPayloadBefore.verificationObligations);
    } finally {
      database.close();
    }
  });

  it("keeps the original obligation root through the second Fix lineage", async () => {
    // Break caught: cycle-2 verifier creation must not treat the cycle-1 Fix as a new root.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:durable-second-fix-lineage");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const service = durableExecutionService(store, orca);
      await service.start(authorized());
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "second-fix-implementation",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "implementation complete"
      });
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "second-fix-verifier-0",
        dispatchId: "orca-dispatch-2",
        outcome: "completed",
        summary: "cycle 0 verifier found a defect"
      });
      const verifier0 = store.listTasks().find((task) =>
        task.role === "verify" && task.cycle === 0
      )?.payload as VerificationTask | undefined;
      if (verifier0 === undefined) throw new Error("cycle 0 verifier missing");
      await service.recordVerificationReport(
        durableReport(verifier0, "fail", "report:durable:second-fix:0")
      );
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "second-fix-implementation-1",
        dispatchId: "orca-dispatch-3",
        outcome: "completed",
        summary: "first Fix complete"
      });
      await service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "second-fix-verifier-1",
        dispatchId: "orca-dispatch-4",
        outcome: "completed",
        summary: "cycle 1 verifier found another defect"
      });
      const verifier1 = store.listTasks().find((task) =>
        task.role === "verify" && task.cycle === 1
      )?.payload as VerificationTask | undefined;
      if (verifier1 === undefined) throw new Error("cycle 1 verifier missing");
      await service.recordVerificationReport(
        durableReport(verifier1, "fail", "report:durable:second-fix:1")
      );

      await expect(service.recordWorkerMessage({
        kind: "worker_done",
        messageId: "second-fix-implementation-2",
        dispatchId: "orca-dispatch-5",
        outcome: "completed",
        summary: "second Fix complete"
      })).resolves.toMatchObject({ dispatched: ["orca-dispatch-6"] });
      const runPayload = JSON.parse((database.prepare(`
        SELECT payload_json FROM runs WHERE id = 'run:proposal-1'
      `).get() as { payload_json: string }).payload_json) as {
        verificationObligations: Array<Record<string, unknown>>;
      };
      expect(runPayload.verificationObligations).toContainEqual(expect.objectContaining({
        rootImplementationTaskId: "task:proposal-1:implement",
        currentImplementationTaskId: "task:proposal-1:implement:fix:1:fix:2",
        cycle: 2,
        status: "verifier_running"
      }));
    } finally {
      database.close();
    }
  });

  it("persists questions and escalations but never publishes worker_done as success", async () => {
    // Break caught: treating a worker completion report as accepted success bypasses verification.
    const { service, orca, store, messages, artifacts } = setup();
    await service.start(authorized());

    const question: WorkerMessage = {
      kind: "question",
      messageId: "message-question-1",
      dispatchId: "orca-dispatch-1",
      text: "Which API shape is authoritative?"
    };
    const escalation: WorkerMessage = {
      kind: "escalation",
      messageId: "message-escalation-1",
      dispatchId: "orca-dispatch-1",
      reason: "Scope is ambiguous"
    };
    const done: WorkerMessage = {
      kind: "worker_done",
      messageId: "message-done-1",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "Implementation process exited cleanly"
    };

    await expect(service.recordWorkerMessage(question)).resolves.toMatchObject({ kind: "recorded" });
    await expect(service.recordWorkerMessage(escalation)).resolves.toMatchObject({ kind: "recorded" });
    expect(orca.calls.filter(({ kind }) => kind === "release_worker")).toEqual([]);
    await expect(service.recordWorkerMessage(done)).resolves.toMatchObject({
      kind: "recorded",
      verificationRequired: true
    });

    expect(store.messages).toEqual([question, escalation, done]);
    expect(messages.messages).toEqual([question, escalation]);
    expect(messages.messages).not.toContainEqual(expect.objectContaining({ kind: "success" }));
    expect(orca.calls.at(-1)).toEqual({
      kind: "release_worker",
      dispatchId: "orca-dispatch-1"
    });
    expect(store.dispatches.get("dispatch:proposal-1:implement:1")).toMatchObject({
      state: "worker_done",
      releaseReceipt: {
        id: "release-receipt-orca-dispatch-1",
        result: { dispatchId: "orca-dispatch-1", verdict: "released" }
      },
      assignmentArtifactCleanup: { kind: "removed" }
    });
    expect(artifacts.cleaned).toEqual([artifacts.staged[0]]);
  });

  it("atomically rolls back worker_done dedupe and lifecycle transitions before redelivery", async () => {
    // Break caught: reserving the completion key before its state transitions loses a redelivered completion.
    const { service, orca, store } = setup();
    const withDependency: ExecutionProposal = {
      ...proposal,
      tasks: [
        proposal.tasks[0]!,
        {
          localId: "follow-up",
          title: "Continue after implementation",
          dependsOn: ["implement"],
          role: "implement",
          preferredAgent: "claude"
        }
      ]
    };
    await service.start(authorized(withDependency));
    const done: WorkerMessage = {
      kind: "worker_done",
      messageId: "done-transaction-1",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    };
    const transitionCount = store.transitions.length;
    store.failWorkerDoneCommitOnce = true;

    await expect(service.recordWorkerMessage(done))
      .rejects.toThrow("synthetic worker_done transaction failure");
    expect(store.messages).not.toContainEqual(done);
    expect(store.dispatches.get("dispatch:proposal-1:implement:1")?.state).toBe("running");
    expect(store.tasks.get("task:proposal-1:implement")?.state).toBe("running");
    expect(store.transitions).toHaveLength(transitionCount);
    expect(orca.calls.filter(({ kind }) => kind === "release_worker")).toEqual([]);

    await expect(service.recordWorkerMessage(done)).resolves.toMatchObject({
      kind: "recorded",
      dispatched: ["orca-dispatch-2"]
    });
    expect(store.messages.filter(({ kind }) => kind === "worker_done")).toEqual([done]);
    expect(orca.calls.filter(({ kind }) => kind === "release_worker")).toHaveLength(1);
  });

  it("durably completes an L0 investigation without implementation verification obligations", async () => {
    // Break caught: routing an investigation-only completion through implementation verification throws on an empty obligation set.
    const { service, store } = setup();
    const readOnlyProposal: ExecutionProposal = {
      ...proposal,
      riskLevel: "L0",
      tasks: [{
        ...proposal.tasks[0]!,
        localId: "investigate",
        title: "Inspect current status",
        role: "investigate"
      }]
    };
    await service.start(authorized(readOnlyProposal));

    await expect(service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "investigation-complete",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "investigation findings recorded"
    })).resolves.toEqual({ kind: "recorded", investigationComplete: true });

    expect(store.runs.get("run:proposal-1")?.state).toBe("investigation_complete");
    expect(store.verificationObligations.has("run:proposal-1")).toBe(false);
  });

  it("retains worker and lease fences when release does not authoritatively report released", async () => {
    // Break caught: a matching Dispatch ID with active/retained state is not proof that Orca released the worker.
    const { service, orca, locks, artifacts, store } = setup();
    orca.releaseResult = { state: "active", verdict: "retained" };
    await service.start(authorized());

    await expect(service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "done-nonreleased-receipt",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    })).resolves.toEqual({
      kind: "review_required",
      reason: "worker_release_failed",
      dispatchId: "orca-dispatch-1"
    });

    expect(artifacts.cleaned).toEqual([]);
    expect(locks.released).toEqual([]);
    expect(store.runs.get("run:proposal-1")?.state).toBe("intervention_required");
  });

  it("recovers a launching Dispatch with only a bound start receipt by inspecting before completion", async () => {
    // Break caught: a crash after provider start but before inspection strands a live worker in launching forever.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-recovery-start-receipt-only");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      await durableExecutionService(store, orca).start(authorized());
      rewriteDurableLaunchCheckpoint(database, {
        dispatchState: "launching",
        keepInspections: false
      });
      const callsBefore = orca.calls.length;

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "done-after-start-only-recovery",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "completed after launch recovery"
      })).resolves.toMatchObject({ kind: "recorded" });

      expect(orca.calls.slice(callsBefore, callsBefore + 2)).toEqual([
        { kind: "show_worker", dispatchId: "orca-dispatch-1" },
        { kind: "read_worker", dispatchId: "orca-dispatch-1", limit: 100 }
      ]);
      expect(store.listAuditEvents()).toContainEqual(expect.objectContaining({
        eventType: "lifecycle.transition",
        data: expect.objectContaining({
          entity: "dispatch",
          from: "launching",
          to: "running"
        })
      }));
      expect(store.listAuditEvents().filter(({ eventType }) => eventType === "worker.worker_done"))
        .toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("promotes a launching Dispatch from its already durable bound show/read receipts", async () => {
    // Break caught: replaying provider inspection after it is durable is unnecessary and launching still blocks completion.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-recovery-durable-inspection");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      await durableExecutionService(store, orca).start(authorized());
      rewriteDurableLaunchCheckpoint(database, {
        dispatchState: "launching",
        keepInspections: true
      });
      const inspectionsBefore = orca.calls.filter((operation) =>
        operation.kind === "show_worker" || operation.kind === "read_worker"
      ).length;

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "done-after-durable-inspection-recovery",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "completed after durable inspection recovery"
      })).resolves.toMatchObject({ kind: "recorded" });

      const originalInspections = orca.calls.filter((operation) =>
        (operation.kind === "show_worker" || operation.kind === "read_worker")
        && operation.dispatchId === "orca-dispatch-1"
      );
      expect(originalInspections).toHaveLength(inspectionsBefore);
      expect(store.listAuditEvents()).toContainEqual(expect.objectContaining({
        eventType: "lifecycle.transition",
        data: expect.objectContaining({ entity: "task", from: "ready", to: "running" })
      }));
    } finally {
      database.close();
    }
  });

  it("repairs a durable Dispatch-running Task-ready split before accepting worker_done", async () => {
    // Break caught: a crash between separate running writes leaves completion permanently blocked by an incoherent graph.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-recovery-running-ready-split");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      await durableExecutionService(store, orca).start(authorized());
      rewriteDurableLaunchCheckpoint(database, {
        dispatchState: "running",
        keepInspections: true
      });

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "done-after-running-ready-recovery",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "completed after split recovery"
      })).resolves.toMatchObject({ kind: "recorded" });

      expect(store.loadTaskRecord("task:proposal-1:implement")).toMatchObject({
        state: "worker_done"
      });
      expect(store.listAuditEvents()).toContainEqual(expect.objectContaining({
        eventType: "lifecycle.transition",
        data: expect.objectContaining({ entity: "task", from: "ready", to: "running" })
      }));
      expect(store.listAuditEvents().filter(({ eventType }) => eventType === "worker.worker_done"))
        .toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("fences and intervenes on a mismatched transitional inspection without accepting completion", async () => {
    // Break caught: tampered transitional ownership must never be promoted or allowed to complete under the local identity.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-recovery-mismatched-inspection");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      await durableExecutionService(store, orca).start(authorized());
      rewriteDurableLaunchCheckpoint(database, {
        dispatchState: "launching",
        keepInspections: true,
        mutateDispatch: (payload) => {
          payload.providerInspectReceipts[0].showReceipt.result.dispatch.task_id =
            "orca-task-mismatched";
        }
      });
      const restarted = durableExecutionService(store, orca);

      await expect(restarted.recordWorkerMessage({
        kind: "worker_done",
        messageId: "done-against-mismatched-launch",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "must not be accepted"
      })).resolves.toEqual({
        kind: "review_required",
        reason: "launch_terminal_unproven",
        dispatchId: "orca-dispatch-1"
      });
      await expect(restarted.recordWorkerMessage({
        kind: "worker_done",
        messageId: "done-against-mismatched-launch-redelivery",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "must not be accepted"
      })).resolves.toEqual({
        kind: "review_required",
        reason: "launch_terminal_unproven",
        dispatchId: "orca-dispatch-1"
      });

      expect(orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([{
        kind: "stop_worker",
        dispatchId: "orca-dispatch-1"
      }]);
      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "intervention_required", fenceReceipt: { ok: true } }]);
      expect(store.loadTaskRecord("task:proposal-1:implement"))
        .toMatchObject({ state: "intervention_required" });
      expect(store.listAuditEvents().filter(({ eventType }) => eventType === "worker.worker_done"))
        .toEqual([]);
    } finally {
      database.close();
    }
  });

  it("retains fences and intervenes without stopping when a transitional identity is uncertain", async () => {
    // Break caught: an unbound local launching record must not guess an external Dispatch identity or remain completable.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-recovery-uncertain-identity");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      await durableExecutionService(store, orca).start(authorized());
      rewriteDurableLaunchCheckpoint(database, {
        dispatchState: "launching",
        keepInspections: false,
        mutateDispatch: (payload) => {
          delete payload.orcaDispatchId;
          delete payload.providerStartReceipt;
          delete payload.receipt;
        }
      });

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "done-against-uncertain-launch",
        dispatchId: "dispatch:proposal-1:implement:1",
        outcome: "completed",
        summary: "must not be accepted"
      })).resolves.toEqual({
        kind: "review_required",
        reason: "launch_terminal_unproven",
        dispatchId: "dispatch:proposal-1:implement:1"
      });

      expect(orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([]);
      const [intervened] = store.loadDispatchesForTask("task:proposal-1:implement");
      expect(intervened).toMatchObject({
        state: "intervention_required",
        fenceFailure: { code: "launch_identity_unproven", retryable: false }
      });
      expect(intervened).not.toHaveProperty("assignmentArtifactCleanup");
      expect(store.listAuditEvents().filter(({ eventType }) => eventType === "worker.worker_done"))
        .toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects launch-intervention transitions that do not match the durable graph", async () => {
    // Break caught: caller-shaped transition audits must not describe a different pre-intervention state.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-intervention-transition-tamper");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      await durableExecutionService(store, orca).start(authorized());
      rewriteDurableLaunchCheckpoint(database, {
        dispatchState: "launching",
        keepInspections: true,
        mutateDispatch: (payload) => {
          payload.providerInspectReceipts[0].showReceipt.result.dispatch.task_id =
            "orca-task-mismatched";
        }
      });
      const durableCommit = store.commitLaunchIntervention.bind(store);
      const commitSpy = vi.spyOn(store, "commitLaunchIntervention").mockImplementation((value) => {
        const commit = value as LaunchInterventionCommit;
        return durableCommit({
          ...commit,
          transitions: commit.transitions.map((transition, index) => index === 0
            ? { ...transition, from: "running" }
            : transition)
        });
      });
      try {
        await expect(durableExecutionService(store, orca).recordWorkerMessage({
          kind: "worker_done",
          messageId: "done-during-launch-intervention-transition-tamper",
          dispatchId: "orca-dispatch-1",
          outcome: "completed",
          summary: "must not be accepted"
        })).rejects.toThrow("launch intervention transitions do not match durable states");
      } finally {
        commitSpy.mockRestore();
      }
      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "launching" }]);
      expect(store.loadTaskRecord("task:proposal-1:implement")).toMatchObject({ state: "ready" });
      expect(store.loadRunRecord("run:proposal-1")).toMatchObject({ state: "active" });
    } finally {
      database.close();
    }
  });

  it("rejects launch intervention payloads that rewrite durable Dispatch, Task, or Run identity", async () => {
    // Break caught: the atomic intervention caller may add only its fence outcome and terminal states.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-intervention-identity-tamper");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      await durableExecutionService(store, orca).start(authorized());
      rewriteDurableLaunchCheckpoint(database, {
        dispatchState: "launching",
        keepInspections: true,
        mutateDispatch: (payload) => {
          payload.providerInspectReceipts[0].showReceipt.result.dispatch.task_id =
            "orca-task-mismatched";
        }
      });
      const durableCommit = store.commitLaunchIntervention.bind(store);
      const commitSpy = vi.spyOn(store, "commitLaunchIntervention").mockImplementation((value) => {
        const commit = value as LaunchInterventionCommit;
        return durableCommit({
          ...commit,
          dispatch: {
            ...commit.dispatch,
            assignment: { ...commit.dispatch.assignment, dispatchId: "dispatch:tampered" }
          },
          task: { ...commit.task, orcaTaskId: "orca-task-tampered" },
          run: { ...commit.run, orcaRunId: "orca-run-tampered" }
        });
      });
      try {
        await expect(durableExecutionService(store, orca).recordWorkerMessage({
          kind: "worker_done",
          messageId: "done-during-launch-intervention-identity-tamper",
          dispatchId: "orca-dispatch-1",
          outcome: "completed",
          summary: "must not be accepted"
        })).rejects.toThrow("launch intervention payloads do not match durable identity");
      } finally {
        commitSpy.mockRestore();
      }
      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "launching" }]);
      expect(store.loadTaskRecord("task:proposal-1:implement")).toMatchObject({
        state: "ready",
        orcaTaskId: "orca-task-1"
      });
      expect(store.loadRunRecord("run:proposal-1")).toMatchObject({
        state: "active",
        orcaRunId: "orca-run-1"
      });
    } finally {
      database.close();
    }
  });

  it("rolls back both launch promotion states when its Task transition audit fails", async () => {
    // Break caught: Dispatch running must not commit alone when the Task half or its audit cannot be committed.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-recovery-atomic-promotion");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      await durableExecutionService(store, orca).start(authorized());
      rewriteDurableLaunchCheckpoint(database, {
        dispatchState: "launching",
        keepInspections: true
      });
      database.exec(`
        CREATE TRIGGER fail_recovered_task_running_transition
        BEFORE INSERT ON audit_events
        WHEN NEW.event_type = 'lifecycle.transition'
          AND json_extract(NEW.data_json, '$.entity') = 'task'
          AND json_extract(NEW.data_json, '$.to') = 'running'
        BEGIN
          SELECT RAISE(ABORT, 'forced recovered Task transition failure');
        END;
      `);

      await expect(durableExecutionService(store, orca).recordWorkerMessage({
        kind: "worker_done",
        messageId: "done-during-atomic-promotion-failure",
        dispatchId: "orca-dispatch-1",
        outcome: "completed",
        summary: "must wait for atomic promotion"
      })).rejects.toThrow("forced recovered Task transition failure");
      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "launching" }]);
      expect(store.loadTaskRecord("task:proposal-1:implement"))
        .toMatchObject({ state: "ready" });
      expect(store.listAuditEvents().filter(({ eventType }) => eventType === "worker.worker_done"))
        .toEqual([]);
    } finally {
      database.close();
    }
  });

  it("authoritatively inspects and stops the exact possibly-live Dispatch before launch retry cleanup", async () => {
    // Break caught: caller-shaped launch_failed evidence alone can free attempt-one resources while its worker remains live.
    const { service, orca, artifacts, locks } = setup();
    await service.start(authorized());
    const callsBeforeFailure = orca.calls.length;

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "launch-failure-authoritative-terminal",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    })).resolves.toMatchObject({ kind: "retried", retryOf: "orca-dispatch-1" });

    expect(orca.calls.slice(callsBeforeFailure, callsBeforeFailure + 3)).toEqual([
      { kind: "show_worker", dispatchId: "orca-dispatch-1" },
      { kind: "read_worker", dispatchId: "orca-dispatch-1", limit: 100 },
      { kind: "stop_worker", dispatchId: "orca-dispatch-1" }
    ]);
    expect(artifacts.cleaned[0]).toEqual(artifacts.staged[0]);
    expect(locks.released[0]).toEqual({
      lockKey: project.lockKey,
      dispatchId: "dispatch:proposal-1:implement:1"
    });
  });

  it("accepts coherent authoritative launch-failed state evolution before stopping the exact Dispatch", async () => {
    // Break caught: retry fencing must not require the worker to remain in its initial ready state after launch failure.
    const { service, orca } = setup();
    await service.start(authorized());
    orca.showWorkerStateByDispatch.set("orca-dispatch-1", "launch_failed");
    orca.readWorkerStateByDispatch.set("orca-dispatch-1", "launch_failed");

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "launch-failure-state-evolved",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    })).resolves.toMatchObject({
      kind: "retried",
      dispatchId: "orca-dispatch-2",
      retryOf: "orca-dispatch-1"
    });
    expect(orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([{
      kind: "stop_worker",
      dispatchId: "orca-dispatch-1"
    }]);
  });

  it("atomically persists authoritative terminal proof with the launch_failed transition", async () => {
    // Break caught: a transition-audit failure must not leave caller evidence or launch_failed state committed by itself.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-failure-atomic-proof");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const service = durableExecutionService(store, orca);
      await service.start(authorized());
      database.exec(`
        CREATE TRIGGER fail_launch_failure_transition
        BEFORE INSERT ON audit_events
        WHEN NEW.event_type = 'lifecycle.transition'
          AND json_extract(NEW.data_json, '$.to') = 'launch_failed'
        BEGIN
          SELECT RAISE(ABORT, 'forced launch failure transition audit failure');
        END;
      `);

      await expect(service.recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "launch-failure-atomic-proof",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).rejects.toThrow("forced launch failure transition audit failure");

      expect(database.prepare(`
        SELECT state FROM dispatches WHERE id = 'dispatch:proposal-1:implement:1'
      `).get()).toEqual({ state: "launch_failure_reserved" });
      expect(store.listAuditEvents().filter(({ eventType }) => eventType === "worker.launch_failure"))
        .toEqual([]);
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("reserves launch failure before stop proof so a racing worker_done cannot win", async () => {
    // Break caught: worker_done delivered after exact stop can terminalize a still-running durable Dispatch before launch_failed is committed.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-failure-worker-done-race");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const service = durableExecutionService(store, orca);
      await service.start(authorized());
      let completionError: unknown;
      orca.afterStop = async () => {
        try {
          await durableExecutionService(store, orca).recordWorkerMessage({
            kind: "worker_done",
            messageId: "worker-done-after-stop-proof",
            dispatchId: "orca-dispatch-1",
            outcome: "completed",
            summary: "completion raced launch failure"
          });
        } catch (error) {
          completionError = error;
        }
      };

      await expect(service.recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "launch-failure-race-winner",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).resolves.toMatchObject({
        kind: "retried",
        retryOf: "orca-dispatch-1"
      });

      expect(completionError).toMatchObject({ code: "worker_completion_conflict" });
      expect(store.listAuditEvents().filter(({ eventType }) => eventType === "worker.worker_done"))
        .toEqual([]);
      expect(store.loadDispatchesForTask("task:proposal-1:implement")).toMatchObject([
        { state: "launch_failed", launchFailureId: "launch-failure-race-winner" },
        { state: "running", retryOf: "orca-dispatch-1" }
      ]);
    } finally {
      database.close();
    }
  });

  it("resumes the same launch failure after a crash immediately after its durable reservation", async () => {
    // Break caught: a durable reservation without stop proof must be resumed, not treated as a completed duplicate.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-failure-reservation-crash");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const artifacts = new MemoryAssignmentArtifactStore();
      const git = new MemoryGit();
      const locks = new DurableLocks(store);
      const firstService = durableExecutionService(store, orca, undefined, locks, artifacts, git);
      await firstService.start(authorized());
      locks.persistLatestAcquire();
      const reserve = store.reserveLaunchFailure.bind(store);
      const reserveSpy = vi.spyOn(store, "reserveLaunchFailure").mockImplementation((value) => {
        reserve(value);
        throw new Error("synthetic process loss after durable launch-failure reservation");
      });
      try {
        await expect(firstService.recordLaunchFailure({
          dispatchId: "orca-dispatch-1",
          failureId: "reservation-crash",
          evidence: { kind: "orca_worker_state", state: "launch_failed" }
        })).rejects.toThrow("synthetic process loss after durable launch-failure reservation");
      } finally {
        reserveSpy.mockRestore();
      }
      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "launch_failure_reserved" }]);
      expect(orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([]);

      const resumed = await durableExecutionService(
        store,
        orca,
        undefined,
        new DurableLocks(store),
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "reservation-crash",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      });
      expect(resumed).toEqual({
        kind: "retried",
        dispatchId: "orca-dispatch-2",
        retryOf: "orca-dispatch-1"
      });

      const resumedLocks = new DurableLocks(store);
      await expect(durableExecutionService(
        store,
        orca,
        undefined,
        resumedLocks,
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "reservation-crash",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).resolves.toEqual(resumed);
      expect(orca.calls.filter(({ kind }) => kind === "stop_worker")).toHaveLength(1);
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("reconciles an idempotent stop after a crash between exact stop proof and launch_failed", async () => {
    // Break caught: an externally stopped worker with only a durable reservation must be stopped idempotently and resumed after restart.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-failure-stop-proof-crash");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const artifacts = new MemoryAssignmentArtifactStore();
      const git = new MemoryGit();
      const firstLocks = new DurableLocks(store);
      const firstService = durableExecutionService(
        store,
        orca,
        undefined,
        firstLocks,
        artifacts,
        git
      );
      await firstService.start(authorized());
      firstLocks.persistLatestAcquire();
      const commitSpy = vi.spyOn(store, "commitLaunchFailure").mockImplementation(() => {
        throw new Error("synthetic process loss after exact stop proof");
      });
      try {
        await expect(firstService.recordLaunchFailure({
          dispatchId: "orca-dispatch-1",
          failureId: "stop-proof-crash",
          evidence: { kind: "orca_worker_state", state: "process_failed" }
        })).rejects.toThrow("synthetic process loss after exact stop proof");
      } finally {
        commitSpy.mockRestore();
      }
      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "launch_failure_reserved" }]);
      expect(orca.calls.filter(({ kind }) => kind === "stop_worker")).toHaveLength(1);

      await expect(durableExecutionService(
        store,
        orca,
        undefined,
        new DurableLocks(store),
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "stop-proof-crash",
        evidence: { kind: "orca_worker_state", state: "process_failed" }
      })).resolves.toEqual({
        kind: "retried",
        dispatchId: "orca-dispatch-2",
        retryOf: "orca-dispatch-1"
      });
      expect(orca.calls.filter(({ kind }) => kind === "stop_worker")).toHaveLength(2);
      expect(store.listAuditEvents().filter(({ eventType }) => eventType === "worker.launch_failure"))
        .toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("resumes cleanup and one retry after a crash immediately after durable launch_failed", async () => {
    // Break caught: durable launch_failed without cleanup must resume instead of returning duplicate and retaining its lease forever.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-failed-before-cleanup-crash");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const artifacts = new MemoryAssignmentArtifactStore();
      const git = new MemoryGit();
      const firstLocks = new DurableLocks(store);
      const firstService = durableExecutionService(store, orca, undefined, firstLocks, artifacts, git);
      await firstService.start(authorized());
      firstLocks.persistLatestAcquire();
      const commit = store.commitLaunchFailure.bind(store);
      const commitSpy = vi.spyOn(store, "commitLaunchFailure").mockImplementation((value) => {
        commit(value);
        throw new Error("synthetic process loss after durable launch_failed");
      });
      try {
        await expect(firstService.recordLaunchFailure({
          dispatchId: "orca-dispatch-1",
          failureId: "launch-failed-before-cleanup",
          evidence: { kind: "orca_worker_state", state: "launch_failed" }
        })).rejects.toThrow("synthetic process loss after durable launch_failed");
      } finally {
        commitSpy.mockRestore();
      }
      const [launchFailed] = store.loadDispatchesForTask("task:proposal-1:implement");
      expect(launchFailed).toMatchObject({ state: "launch_failed" });
      expect(launchFailed).not.toHaveProperty("assignmentArtifactCleanup");
      expect(store.getWorktreeLock(project.lockKey)?.dispatchId)
        .toBe("dispatch:proposal-1:implement:1");

      const resumedLocks = new DurableLocks(store);
      await expect(durableExecutionService(
        store,
        orca,
        undefined,
        resumedLocks,
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "launch-failed-before-cleanup",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).resolves.toEqual({
        kind: "retried",
        dispatchId: "orca-dispatch-2",
        retryOf: "orca-dispatch-1"
      });
      expect(artifacts.cleaned).toHaveLength(1);
      expect(store.getWorktreeLock(project.lockKey)).toBeUndefined();
      expect(resumedLocks.acquired.at(-1)?.dispatchId)
        .toBe("dispatch:proposal-1:implement:2");
    } finally {
      database.close();
    }
  });

  it("resumes one retry after cleanup and durable lease release crash", async () => {
    // Break caught: replay after cleanup/release must skip both completed effects and create exactly one replacement identity.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-failed-after-cleanup-crash");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const artifacts = new MemoryAssignmentArtifactStore();
      const git = new MemoryGit();
      const crashingLocks = new DurableLocks(store);
      const firstService = durableExecutionService(
        store,
        orca,
        undefined,
        crashingLocks,
        artifacts,
        git
      );
      await firstService.start(authorized());
      crashingLocks.persistLatestAcquire();
      crashingLocks.crashAfterReleaseOnce = true;
      await expect(firstService.recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "cleanup-release-crash",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).rejects.toThrow("synthetic process loss after durable lease release");
      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "launch_failed", assignmentArtifactCleanup: { kind: "removed" } }]);
      expect(store.getWorktreeLock(project.lockKey)).toBeUndefined();

      const resumed = await durableExecutionService(
        store,
        orca,
        undefined,
        new DurableLocks(store),
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "cleanup-release-crash",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      });
      expect(resumed).toEqual({
        kind: "retried",
        dispatchId: "orca-dispatch-2",
        retryOf: "orca-dispatch-1"
      });
      await expect(durableExecutionService(
        store,
        orca,
        undefined,
        new DurableLocks(store),
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "cleanup-release-crash",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).resolves.toEqual(resumed);
      expect(artifacts.cleaned).toHaveLength(1);
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("materializes the existing retry worktree after a crash immediately after retry persistence", async () => {
    // Break caught: replay of a durable planned retry must create its isolated worktree before starting that same identity.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-failed-after-retry-persistence-crash");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const artifacts = new MemoryAssignmentArtifactStore();
      const git = new MemoryGit();
      const firstLocks = new DurableLocks(store);
      const firstService = durableExecutionService(
        store,
        orca,
        undefined,
        firstLocks,
        artifacts,
        git
      );
      await firstService.start(authorized());
      firstLocks.persistLatestAcquire();
      const durableSaveDispatch = store.saveDispatch.bind(store);
      const saveSpy = vi.spyOn(store, "saveDispatch").mockImplementation((value) => {
        durableSaveDispatch(value);
        const record = value as { id?: unknown; state?: unknown };
        if (
          record.id === "dispatch:proposal-1:implement:2"
          && record.state === "planned"
        ) {
          throw new Error("synthetic process loss after durable retry persistence");
        }
      });
      try {
        await expect(firstService.recordLaunchFailure({
          dispatchId: "orca-dispatch-1",
          failureId: "retry-persistence-crash",
          evidence: { kind: "orca_worker_state", state: "launch_failed" }
        })).rejects.toThrow("synthetic process loss after durable retry persistence");
      } finally {
        saveSpy.mockRestore();
      }
      expect(store.loadDispatchesForTask("task:proposal-1:implement")).toMatchObject([
        { state: "launch_failed", assignmentArtifactCleanup: { kind: "removed" } },
        { id: "dispatch:proposal-1:implement:2", state: "planned", attempt: 2 }
      ]);
      expect(git.created).toHaveLength(1);

      await expect(durableExecutionService(
        store,
        orca,
        undefined,
        new DurableLocks(store),
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "retry-persistence-crash",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).resolves.toEqual({
        kind: "retried",
        dispatchId: "orca-dispatch-2",
        retryOf: "orca-dispatch-1"
      });
      const retry = store.loadDispatchesForTask("task:proposal-1:implement")[1] as DispatchRecord;
      expect(git.created).toHaveLength(2);
      expect(git.created[1]).toMatchObject({
        repositoryPath: retry.assignment.repo.repositoryPath,
        worktreePath: retry.assignment.worktree.path,
        branch: retry.assignment.worktree.branch,
        baseCommit: retry.assignment.base.commit
      });
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("reuses the exact retry worktree after a crash between materialization and launch", async () => {
    // Break caught: an exact durable retry worktree is replay success, not a branch conflict or a second Git create.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-failed-after-retry-worktree-crash");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const artifacts = new MemoryAssignmentArtifactStore();
      const git = new MemoryGit();
      const firstLocks = new DurableLocks(store);
      const firstService = durableExecutionService(
        store,
        orca,
        undefined,
        firstLocks,
        artifacts,
        git
      );
      await firstService.start(authorized());
      firstLocks.persistLatestAcquire();
      const durableSaveDispatch = store.saveDispatch.bind(store);
      const saveSpy = vi.spyOn(store, "saveDispatch").mockImplementation((value) => {
        durableSaveDispatch(value);
        const record = value as { id?: unknown; state?: unknown };
        if (
          record.id === "dispatch:proposal-1:implement:2"
          && record.state === "planned"
        ) {
          throw new Error("synthetic process loss after durable retry persistence");
        }
      });
      try {
        await expect(firstService.recordLaunchFailure({
          dispatchId: "orca-dispatch-1",
          failureId: "retry-worktree-crash",
          evidence: { kind: "orca_worker_state", state: "launch_failed" }
        })).rejects.toThrow("synthetic process loss after durable retry persistence");
      } finally {
        saveSpy.mockRestore();
      }
      const retry = store.loadDispatchesForTask("task:proposal-1:implement")[1] as DispatchRecord;
      if (retry?.assignment.worktree.branch === null) {
        throw new Error("expected an isolated retry worktree branch");
      }
      await git.createWorktree({
        repositoryPath: retry.assignment.repo.repositoryPath,
        worktreePath: retry.assignment.worktree.path,
        branch: retry.assignment.worktree.branch,
        baseCommit: retry.assignment.base.commit
      });
      expect(git.created).toHaveLength(2);

      await expect(durableExecutionService(
        store,
        orca,
        undefined,
        new DurableLocks(store),
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "retry-worktree-crash",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).resolves.toEqual({
        kind: "retried",
        dispatchId: "orca-dispatch-2",
        retryOf: "orca-dispatch-1"
      });
      expect(git.created).toHaveLength(2);
      expect(store.loadDispatchesForTask("task:proposal-1:implement")[1])
        .toMatchObject({ state: "running", retryOf: "orca-dispatch-1" });
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("finishes graph intervention after a crash following durable launch-failure cleanup failure", async () => {
    // Break caught: replay must not report intervention while leaving a launch_failed Dispatch on an active Run.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:launch-failed-cleanup-failure-intervention-crash");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const artifacts = new MemoryAssignmentArtifactStore();
      const git = new MemoryGit();
      const firstLocks = new DurableLocks(store);
      const firstService = durableExecutionService(
        store,
        orca,
        undefined,
        firstLocks,
        artifacts,
        git
      );
      await firstService.start(authorized());
      firstLocks.persistLatestAcquire();
      artifacts.cleanupError = Object.assign(new Error("synthetic terminal cleanup failure"), {
        code: "assignment_artifact_cleanup_failed",
        retryable: false
      });
      let crashBeforeIntervention = true;
      const interventionSpy = vi.spyOn(store, "commitLaunchIntervention")
        .mockImplementation(() => {
          if (!crashBeforeIntervention) {
            throw new Error("unexpected duplicate cleanup-failure intervention");
          }
          crashBeforeIntervention = false;
          throw new Error("synthetic process loss before cleanup-failure intervention");
        });
      try {
        await expect(firstService.recordLaunchFailure({
          dispatchId: "orca-dispatch-1",
          failureId: "cleanup-failure-intervention-crash",
          evidence: { kind: "orca_worker_state", state: "launch_failed" }
        })).rejects.toThrow("synthetic process loss before cleanup-failure intervention");
      } finally {
        interventionSpy.mockRestore();
      }
      expect(store.loadDispatchesForTask("task:proposal-1:implement")).toMatchObject([{
        state: "launch_failed",
        assignmentArtifactCleanupFailure: {
          code: "assignment_artifact_cleanup_failed",
          retryable: false
        }
      }]);
      expect(store.loadTaskRecord("task:proposal-1:implement")).toMatchObject({ state: "running" });
      expect(store.loadRunRecord("run:proposal-1")).toMatchObject({ state: "active" });

      await expect(durableExecutionService(
        store,
        orca,
        undefined,
        new DurableLocks(store),
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "cleanup-failure-intervention-crash",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).resolves.toEqual({
        kind: "intervention_required",
        reason: "assignment_artifact_cleanup_failed",
        dispatchId: "orca-dispatch-1"
      });
      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "intervention_required" }]);
      expect(store.loadTaskRecord("task:proposal-1:implement"))
        .toMatchObject({ state: "intervention_required" });
      expect(store.loadRunRecord("run:proposal-1"))
        .toMatchObject({ state: "intervention_required" });
      expect(store.getWorktreeLock(project.lockKey)?.dispatchId)
        .toBe("dispatch:proposal-1:implement:1");
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("recovery-round atomically rolls back reserved stop failure and clears stale fence failure on exact-stop replay", async () => {
    // Break caught: a crash inside stop-failure intervention must not strand a partial graph, and later exact stop proof must replace stale failure evidence.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:recovery-round-reserved-stop-failure");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const artifacts = new MemoryAssignmentArtifactStore();
      const git = new MemoryGit();
      const initialLocks = new DurableLocks(store);
      await durableExecutionService(
        store,
        orca,
        undefined,
        initialLocks,
        artifacts,
        git
      ).start(authorized());
      initialLocks.persistLatestAcquire();
      rewriteDurableLaunchGraph(database, {
        dispatchState: "launch_failure_reserved",
        mutateDispatch: (payload) => {
          payload.launchFailureId = "recovery-round-reserved-stop-failure";
          payload.fenceFailure = {
            code: "legacy_stop_ambiguous",
            retryable: true
          };
          delete payload.fenceReceipt;
        }
      });
      database.exec(`
        CREATE TRIGGER fail_reserved_stop_intervention
        BEFORE INSERT ON audit_events
        WHEN NEW.event_type = 'lifecycle.transition'
          AND json_extract(NEW.data_json, '$.entity') = 'task'
          AND json_extract(NEW.data_json, '$.to') = 'intervention_required'
        BEGIN
          SELECT RAISE(ABORT, 'forced reserved stop intervention failure');
        END;
      `);
      orca.stopError = Object.assign(new Error("synthetic stop ambiguity"), {
        code: "orca_stop_unavailable",
        retryable: true
      });

      await expect(durableExecutionService(
        store,
        orca,
        undefined,
        new DurableLocks(store),
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "recovery-round-reserved-stop-failure",
        evidence: { kind: "orca_worker_state", state: "process_failed" }
      })).rejects.toThrow("forced reserved stop intervention failure");

      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "launch_failure_reserved" }]);
      expect(store.loadTaskRecord("task:proposal-1:implement"))
        .toMatchObject({ state: "running" });
      expect(store.loadRunRecord("run:proposal-1")).toMatchObject({ state: "active" });

      database.exec("DROP TRIGGER fail_reserved_stop_intervention");
      orca.stopError = undefined;
      const resumed = await durableExecutionService(
        store,
        orca,
        undefined,
        new DurableLocks(store),
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "recovery-round-reserved-stop-failure",
        evidence: { kind: "orca_worker_state", state: "process_failed" }
      });

      expect(resumed).toEqual({
        kind: "retried",
        dispatchId: "orca-dispatch-2",
        retryOf: "orca-dispatch-1"
      });
      const dispatches = store.loadDispatchesForTask("task:proposal-1:implement") as Array<
        Record<string, any>
      >;
      expect(dispatches[0]).toMatchObject({
        state: "launch_failed",
        fenceReceipt: {
          ok: true,
          result: {
            dispatchId: "orca-dispatch-1",
            state: "stopped",
            verdict: "stopped"
          }
        },
        assignmentArtifactCleanup: { kind: "removed" }
      });
      expect(dispatches[0]).not.toHaveProperty("fenceFailure");
      expect(dispatches[1]).toMatchObject({
        state: "running",
        retryOf: "orca-dispatch-1",
        attempt: 2
      });
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(2);
      expect(orca.calls.filter(({ kind }) => kind === "stop_worker")).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("recovery-round atomically rolls back and retries pre-reservation inspection intervention", async () => {
    // Break caught: inspection failure before reservation must atomically fence and intervene, never persist a Dispatch-only or Task-only terminal graph.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:recovery-round-pre-reservation-inspection");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      await durableExecutionService(store, orca).start(authorized());
      orca.showTaskId = "orca-task-mismatched";
      database.exec(`
        CREATE TRIGGER fail_pre_reservation_intervention
        BEFORE INSERT ON audit_events
        WHEN NEW.event_type = 'lifecycle.transition'
          AND json_extract(NEW.data_json, '$.entity') = 'task'
          AND json_extract(NEW.data_json, '$.to') = 'intervention_required'
        BEGIN
          SELECT RAISE(ABORT, 'forced pre-reservation intervention failure');
        END;
      `);

      await expect(durableExecutionService(store, orca).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "recovery-round-pre-reservation-inspection",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).rejects.toThrow("forced pre-reservation intervention failure");

      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "running" }]);
      expect(store.loadTaskRecord("task:proposal-1:implement"))
        .toMatchObject({ state: "running" });
      expect(store.loadRunRecord("run:proposal-1")).toMatchObject({ state: "active" });

      database.exec("DROP TRIGGER fail_pre_reservation_intervention");
      await expect(durableExecutionService(store, orca).recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "recovery-round-pre-reservation-inspection",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).resolves.toEqual({
        kind: "intervention_required",
        reason: "launch_terminal_unproven",
        dispatchId: "orca-dispatch-1"
      });

      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "intervention_required", fenceReceipt: { ok: true } }]);
      expect(store.loadTaskRecord("task:proposal-1:implement"))
        .toMatchObject({ state: "intervention_required" });
      expect(store.loadRunRecord("run:proposal-1"))
        .toMatchObject({ state: "intervention_required" });
      expect(orca.calls.filter(({ kind }) => kind === "stop_worker")).toEqual([
        { kind: "stop_worker", dispatchId: "orca-dispatch-1" },
        { kind: "stop_worker", dispatchId: "orca-dispatch-1" }
      ]);
    } finally {
      database.close();
    }
  });

  it("recovery-round atomically rolls back and resumes attempt-two exhaustion intervention", async () => {
    // Break caught: the exhausted retry must remain launch_failed on transaction failure and replay into one coherent intervention without a third launch.
    const database = openDatabase(":memory:");
    try {
      seedDurableCommand(database, "test:recovery-round-attempt-two-exhaustion");
      const store = new ControlStore(database);
      const orca = new RecordingOrca();
      const artifacts = new MemoryAssignmentArtifactStore();
      const git = new MemoryGit();
      const locks = new DurableLocks(store);
      const service = durableExecutionService(store, orca, undefined, locks, artifacts, git);
      await service.start(authorized());
      locks.persistLatestAcquire();
      await expect(service.recordLaunchFailure({
        dispatchId: "orca-dispatch-1",
        failureId: "recovery-round-attempt-one",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).resolves.toEqual({
        kind: "retried",
        dispatchId: "orca-dispatch-2",
        retryOf: "orca-dispatch-1"
      });
      database.exec(`
        CREATE TRIGGER fail_attempt_two_intervention
        BEFORE INSERT ON audit_events
        WHEN NEW.event_type = 'lifecycle.transition'
          AND json_extract(NEW.data_json, '$.entity') = 'task'
          AND json_extract(NEW.data_json, '$.to') = 'intervention_required'
        BEGIN
          SELECT RAISE(ABORT, 'forced attempt-two intervention failure');
        END;
      `);

      await expect(service.recordLaunchFailure({
        dispatchId: "orca-dispatch-2",
        failureId: "recovery-round-attempt-two",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).rejects.toThrow("forced attempt-two intervention failure");

      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "launch_failed" }, { state: "launch_failed" }]);
      expect(store.loadTaskRecord("task:proposal-1:implement"))
        .toMatchObject({ state: "running" });
      expect(store.loadRunRecord("run:proposal-1")).toMatchObject({ state: "active" });

      database.exec("DROP TRIGGER fail_attempt_two_intervention");
      await expect(durableExecutionService(
        store,
        orca,
        undefined,
        new DurableLocks(store),
        artifacts,
        git
      ).recordLaunchFailure({
        dispatchId: "orca-dispatch-2",
        failureId: "recovery-round-attempt-two",
        evidence: { kind: "orca_worker_state", state: "launch_failed" }
      })).resolves.toEqual({
        kind: "intervention_required",
        reason: "launch_retry_exhausted",
        dispatchId: "orca-dispatch-2"
      });

      expect(store.loadDispatchesForTask("task:proposal-1:implement"))
        .toMatchObject([{ state: "launch_failed" }, { state: "intervention_required" }]);
      expect(store.loadTaskRecord("task:proposal-1:implement"))
        .toMatchObject({ state: "intervention_required" });
      expect(store.loadRunRecord("run:proposal-1"))
        .toMatchObject({ state: "intervention_required" });
      expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("recovery-round repairs legacy partial intervention graphs with durable or derived fence outcomes", async () => {
    // Break caught: hydration must complete legacy Dispatch-only and Dispatch+Task intervention graphs instead of returning early or accepting completion.
    const observations: Array<Record<string, unknown>> = [];
    const variants = [
      {
        id: "durable-failure",
        taskState: "running" as const,
        durableFenceFailure: true
      },
      {
        id: "missing-fence",
        taskState: "intervention_required" as const,
        durableFenceFailure: false
      }
    ];
    for (const variant of variants) {
      const database = openDatabase(":memory:");
      try {
        seedDurableCommand(database, `test:recovery-round-legacy-${variant.id}`);
        const store = new ControlStore(database);
        const orca = new RecordingOrca();
        await durableExecutionService(store, orca).start(authorized());
        rewriteDurableLaunchGraph(database, {
          dispatchState: "intervention_required",
          taskState: variant.taskState,
          mutateDispatch: (payload) => {
            delete payload.fenceReceipt;
            delete payload.fenceFailure;
            if (variant.durableFenceFailure) {
              payload.fenceFailure = {
                code: "legacy_stop_ambiguous",
                retryable: true
              };
            }
          }
        });
        let result: unknown;
        try {
          result = await durableExecutionService(store, orca).recordWorkerMessage({
            kind: "worker_done",
            messageId: `done-against-legacy-${variant.id}`,
            dispatchId: "orca-dispatch-1",
            outcome: "completed",
            summary: "must not be accepted"
          });
        } catch {
          result = { kind: "threw" };
        }
        const [dispatch] = store.loadDispatchesForTask(
          "task:proposal-1:implement"
        ) as Array<Record<string, any>>;
        observations.push({
          variant: variant.id,
          result,
          dispatchState: dispatch?.state,
          taskState: (store.loadTaskRecord("task:proposal-1:implement") as any)?.state,
          runState: (store.loadRunRecord("run:proposal-1") as any)?.state,
          fenceKind: dispatch?.fenceReceipt !== undefined
            ? "receipt"
            : dispatch?.fenceFailure !== undefined
              ? "failure"
              : "none",
          stopCalls: orca.calls.filter(({ kind }) => kind === "stop_worker").length
        });
      } finally {
        database.close();
      }
    }

    expect(observations).toEqual([
      {
        variant: "durable-failure",
        result: {
          kind: "review_required",
          reason: "launch_terminal_unproven",
          dispatchId: "orca-dispatch-1"
        },
        dispatchState: "intervention_required",
        taskState: "intervention_required",
        runState: "intervention_required",
        fenceKind: "failure",
        stopCalls: 0
      },
      {
        variant: "missing-fence",
        result: {
          kind: "review_required",
          reason: "launch_terminal_unproven",
          dispatchId: "orca-dispatch-1"
        },
        dispatchState: "intervention_required",
        taskState: "intervention_required",
        runState: "intervention_required",
        fenceKind: "receipt",
        stopCalls: 1
      }
    ]);
  });

  it("keeps attempt-one fences and intervenes when authoritative launch terminal proof is ambiguous", async () => {
    // Break caught: failure to stop the exact Dispatch must prohibit artifact cleanup, lease release, and attempt two.
    const { service, orca, artifacts, locks, store } = setup();
    await service.start(authorized());
    orca.stopError = Object.assign(new Error("synthetic stop ambiguity"), {
      code: "orca_stop_unavailable",
      retryable: true
    });

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "launch-failure-ambiguous-terminal",
      evidence: { kind: "orca_worker_state", state: "process_failed" }
    })).resolves.toEqual({
      kind: "intervention_required",
      reason: "launch_terminal_unproven",
      dispatchId: "orca-dispatch-1"
    });

    expect(artifacts.cleaned).toEqual([]);
    expect(locks.released).toEqual([]);
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
    expect(store.runs.get("run:proposal-1")?.state).toBe("intervention_required");
  });

  it("retains resources when stop verdict does not also report the exact stopped state", async () => {
    // Break caught: a stopped-looking verdict with an active state is not terminal proof and cannot authorize cleanup.
    const { service, orca, artifacts, locks } = setup();
    await service.start(authorized());
    orca.stopResult = { state: "active", verdict: "stopped" };

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "launch-failure-stop-state-ambiguous",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    })).resolves.toEqual({
      kind: "intervention_required",
      reason: "launch_terminal_unproven",
      dispatchId: "orca-dispatch-1"
    });
    expect(artifacts.cleaned).toEqual([]);
    expect(locks.released).toEqual([]);
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
  });

  it("persists an exact worker release failure and requires review without releasing its edit lease", async () => {
    // Break caught: losing a worker-release failure can free the project while its terminal ownership is uncertain.
    const { service, orca, locks, store } = setup();
    orca.releaseError = Object.assign(new Error("synthetic Orca release failure"), {
      code: "orca_release_unavailable",
      retryable: true
    });
    await service.start(authorized());
    const done: WorkerMessage = {
      kind: "worker_done",
      messageId: "done-release-failure",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    };

    await expect(service.recordWorkerMessage(done)).resolves.toEqual({
      kind: "review_required",
      reason: "worker_release_failed",
      dispatchId: "orca-dispatch-1"
    });
    expect(orca.calls.at(-1)).toEqual({
      kind: "release_worker",
      dispatchId: "orca-dispatch-1"
    });
    expect(store.dispatches.get("dispatch:proposal-1:implement:1")).toMatchObject({
      state: "worker_done",
      releaseFailure: {
        code: "orca_release_unavailable",
        retryable: true
      }
    });
    expect(store.runs.get("run:proposal-1")?.state).toBe("intervention_required");
    expect(locks.released).toEqual([]);

    await expect(service.recordWorkerMessage(done)).resolves.toEqual({ kind: "duplicate" });
    expect(orca.calls.filter(({ kind }) => kind === "release_worker")).toHaveLength(1);
  });

  it("persists terminal artifact cleanup failure and moves the Run to intervention", async () => {
    // Break caught: worker_done must not leave an active-looking Run when artifact ownership is unresolved.
    const { service, locks, store, artifacts } = setup();
    await service.start(authorized());
    artifacts.cleanupError = Object.assign(new Error("synthetic terminal cleanup failure"), {
      code: "assignment_artifact_cleanup_failed",
      retryable: true
    });

    await expect(service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "done-cleanup-failure",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    })).resolves.toEqual({
      kind: "review_required",
      reason: "assignment_artifact_cleanup_failed",
      dispatchId: "orca-dispatch-1"
    });

    expect(store.runs.get("run:proposal-1")?.state).toBe("intervention_required");
    expect(store.dispatches.get("dispatch:proposal-1:implement:1"))
      .toMatchObject({
        assignmentArtifactCleanupFailure: {
          code: "assignment_artifact_cleanup_failed",
          retryable: true
        }
      });
    expect(locks.released).toEqual([]);
  });

  it("persists worker_done once and dispatches each newly unblocked dependency once", async () => {
    // Break caught: duplicate completion delivery can launch duplicate dependent workers.
    const { service, orca, store } = setup();
    const withDependency: ExecutionProposal = {
      ...proposal,
      tasks: [
        proposal.tasks[0]!,
        {
          localId: "follow-up",
          title: "Continue after implementation",
          dependsOn: ["implement"],
          role: "implement",
          preferredAgent: "claude"
        }
      ]
    };
    await service.start(authorized(withDependency));
    const firstDone: WorkerMessage = {
      kind: "worker_done",
      messageId: "done-delivery-1",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "first delivery"
    };
    const duplicateDone: WorkerMessage = {
      ...firstDone,
      messageId: "done-delivery-2",
      summary: "duplicate delivery"
    };

    await expect(service.recordWorkerMessage(firstDone)).resolves.toMatchObject({
      kind: "recorded",
      dispatched: ["orca-dispatch-2"]
    });
    await expect(service.recordWorkerMessage(duplicateDone)).resolves.toEqual({ kind: "duplicate" });

    expect(orca.calls.map(({ kind }) => kind)).toEqual([
      "create_run",
      "create_task",
      "create_task",
      "dispatch_worker",
      "show_worker",
      "read_worker",
      "release_worker",
      "dispatch_worker",
      "show_worker",
      "read_worker"
    ]);
    expect(store.messages.filter(({ kind }) => kind === "worker_done")).toHaveLength(1);
  });

  it("releases the exact dependency lease and persists intervention when worker-start fails", async () => {
    // Break caught: a newly unblocked Task owns a new lease that must not leak on start rejection.
    const { service, orca, locks, store } = setup();
    const withDependency: ExecutionProposal = {
      ...proposal,
      tasks: [
        proposal.tasks[0]!,
        {
          localId: "follow-up",
          title: "Continue after implementation",
          dependsOn: ["implement"],
          role: "implement",
          preferredAgent: "claude"
        }
      ]
    };
    await service.start(authorized(withDependency));
    orca.dispatchErrorOnCall = 2;

    await expect(service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "done-before-dependent-start-failure",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    })).rejects.toMatchObject({
      code: "provider_process_failed",
      provider: "claude",
      phase: "start"
    });

    expect(locks.released).toEqual([
      {
        lockKey: project.lockKey,
        dispatchId: "dispatch:proposal-1:implement:1"
      },
      {
        lockKey: project.lockKey,
        dispatchId: "dispatch:proposal-1:follow-up:1"
      }
    ]);
    expect(store.dispatches.get("dispatch:proposal-1:follow-up:1")?.state)
      .toBe("intervention_required");
    expect(store.tasks.get("task:proposal-1:follow-up")?.state)
      .toBe("intervention_required");
    expect(store.runs.get("run:proposal-1")?.state)
      .toBe("intervention_required");
  });

  it("does not persist a dependency Dispatch before its editing lease is acquired", async () => {
    // Break caught: a denied dependency lease must not leave a phantom planned attempt.
    const { service, orca, locks, store } = setup();
    const withDependency: ExecutionProposal = {
      ...proposal,
      tasks: [
        proposal.tasks[0]!,
        {
          localId: "follow-up",
          title: "Continue after implementation",
          dependsOn: ["implement"],
          role: "implement",
          preferredAgent: "claude"
        }
      ]
    };
    await service.start(authorized(withDependency));
    locks.acquireResult = { kind: "conflict", lease: { dispatchId: "dispatch-other" } };

    await expect(service.recordWorkerMessage({
      kind: "worker_done",
      messageId: "done-before-dependent-lock-conflict",
      dispatchId: "orca-dispatch-1",
      outcome: "completed",
      summary: "implementation complete"
    })).resolves.toEqual({
      kind: "review_required",
      reason: "editing_lock_conflict",
      dispatchId: "dispatch-other"
    });

    expect(store.dispatches.has("dispatch:proposal-1:follow-up:1")).toBe(false);
    expect(store.tasks.get("task:proposal-1:follow-up")?.state).toBe("intervention_required");
    expect(store.runs.get("run:proposal-1")?.state).toBe("intervention_required");
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
  });

  it("permits one conflict-free replacement launch and requires intervention after its failure", async () => {
    // Break caught: an unbounded launch loop can duplicate workers and edits after partial startup.
    const { service, orca, git, store, artifacts } = setup();
    await service.start(authorized());
    const authorizedBaseCommit = git.baseCommit;
    git.baseCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "launch-failure-1",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    })).resolves.toEqual({
      kind: "retried",
      dispatchId: "orca-dispatch-2",
      retryOf: "orca-dispatch-1"
    });

    const dispatchCalls = orca.calls.filter(({ kind }) => kind === "dispatch_worker");
    expect(dispatchCalls).toHaveLength(2);
    expect(dispatchCalls[1]).toMatchObject({
      taskId: "orca-task-1",
      retryOf: "orca-dispatch-1"
    });
    expect(git.created).toHaveLength(2);
    expect(git.created[1]?.worktreePath).not.toBe(git.created[0]?.worktreePath);
    expect(git.created.map(({ baseCommit }) => baseCommit)).toEqual([
      authorizedBaseCommit,
      authorizedBaseCommit
    ]);
    const persistedDispatches = [...store.dispatches.values()];
    expect(persistedDispatches).toHaveLength(2);
    expect(persistedDispatches[0]).toMatchObject({
      id: "dispatch:proposal-1:implement:1",
      orcaDispatchId: "orca-dispatch-1",
      assignment: {
        worktree: { path: git.created[0]?.worktreePath },
        dispatchId: "dispatch:proposal-1:implement:1"
      }
    });
    expect(persistedDispatches[1]).toMatchObject({
      id: "dispatch:proposal-1:implement:2",
      retryOf: "orca-dispatch-1",
      orcaDispatchId: "orca-dispatch-2",
      assignment: {
        worktree: { path: git.created[1]?.worktreePath },
        base: { ref: "main", commit: authorizedBaseCommit },
        dispatchId: "dispatch:proposal-1:implement:2"
      }
    });

    const createTask = orca.calls.find(({ kind }) => kind === "create_task");
    if (createTask?.kind !== "create_task") throw new Error("expected one Orca Task");
    expect(orca.calls.filter(({ kind }) => kind === "create_task")).toHaveLength(1);
    expect(JSON.parse(createTask.spec)).toEqual({
      protocol: 1,
      task: {
        taskId: "task:proposal-1:implement",
        localId: "implement",
        title: "Implement the requested API change",
        role: "implement",
        preferredAgent: "codex",
        dependsOn: []
      },
      authorization: {
        project: {
          projectKey: project.projectKey,
          orcaProjectId: project.orcaProjectId
        },
        repo: {
          repoId: project.repoId,
          repositoryPath: project.absolutePath
        },
        base: { ref: "main", commit: authorizedBaseCommit },
        fileScope: proposal.allowedScope,
        acceptanceCommands: proposal.acceptanceCommands,
        prohibitedEffects: proposal.prohibitedEffects,
        permissions: "read-write",
        nestedWorkers: "forbidden"
      },
      dispatchLinkage: {
        kind: "hq_receipt_linked_dispatch",
        taskId: "task:proposal-1:implement"
      },
      assignmentArtifact: {
        protocol: 1,
        artifactId: artifacts.staged[0]?.artifactId,
        path: artifacts.staged[0]?.path,
        format: "orca_hq_assignment_artifact_v1",
        requiredBeforeWork: true,
        integrity: "sha256_content",
        workerConsumption: "read_content_as_authoritative_assignment_before_work"
      }
    });
    expect(artifacts.staged).toHaveLength(2);
    expect(artifacts.cleaned).toEqual([artifacts.staged[0]]);
    expect(persistedDispatches[0]).toMatchObject({
      assignmentArtifactCleanup: { kind: "removed" }
    });
    expect(artifacts.staged.map(({ artifactId, path, version, ownerDispatchId }) => ({
      artifactId,
      path,
      version,
      ownerDispatchId
    }))).toEqual([
      {
        artifactId: artifacts.staged[0]?.artifactId,
        path: artifacts.staged[0]?.path,
        version: 1,
        ownerDispatchId: "dispatch:proposal-1:implement:1"
      },
      {
        artifactId: artifacts.staged[0]?.artifactId,
        path: artifacts.staged[0]?.path,
        version: 2,
        ownerDispatchId: "dispatch:proposal-1:implement:2"
      }
    ]);
    expect(JSON.parse(artifacts.staged[1]!.content)).toMatchObject({
      assignment: {
        worktree: { path: git.created[1]?.worktreePath },
        dispatchId: "dispatch:proposal-1:implement:2"
      }
    });

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "launch-failure-redelivery",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    })).resolves.toEqual({ kind: "duplicate" });

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-2",
      failureId: "launch-failure-2",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    })).resolves.toEqual({
      kind: "intervention_required",
      reason: "launch_retry_exhausted",
      dispatchId: "orca-dispatch-2"
    });
    expect(artifacts.cleaned).toEqual(artifacts.staged);
    expect(store.dispatches.get("dispatch:proposal-1:implement:2"))
      .toMatchObject({ assignmentArtifactCleanup: { kind: "removed" } });
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(2);
  });

  it("retains the launch-failed lease when its assignment artifact cannot be cleaned", async () => {
    // Break caught: terminal launch evidence does not permit release while artifact ownership is unresolved.
    const { service, orca, locks, store, artifacts } = setup();
    await service.start(authorized());
    artifacts.cleanupError = Object.assign(
      new Error("synthetic launch-failure artifact cleanup failure"),
      { code: "assignment_artifact_cleanup_failed", retryable: false }
    );

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "launch-failure-cleanup-failed",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    })).resolves.toEqual({
      kind: "intervention_required",
      reason: "assignment_artifact_cleanup_failed",
      dispatchId: "orca-dispatch-1"
    });

    expect(locks.released).toEqual([]);
    expect(artifacts.cleaned).toEqual([]);
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
    expect(store.dispatches.get("dispatch:proposal-1:implement:1"))
      .toMatchObject({
        state: "intervention_required",
        assignmentArtifactCleanupFailure: {
          code: "assignment_artifact_cleanup_failed",
          retryable: false
        }
      });
  });

  it("releases the replacement lease when retry worktree creation fails", async () => {
    // Break caught: retry placement failure must not strand the lease owned by attempt two.
    const git = new MemoryGit();
    git.createError = new Error("synthetic replacement Git failure");
    git.createErrorOnCall = 2;
    const { service, locks, orca } = setup(git);
    await service.start(authorized());

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "launch-failure-replacement",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    })).rejects.toThrow("synthetic replacement Git failure");

    expect(locks.released.at(-1)).toEqual({
      lockKey: project.lockKey,
      dispatchId: "dispatch:proposal-1:implement:2"
    });
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
  });

  it("does not persist a retry Dispatch before its editing lease is acquired", async () => {
    // Break caught: a denied replacement lease must not become the current attempt for Task 4.
    const { service, orca, git, locks, store } = setup();
    await service.start(authorized());
    locks.acquireResult = { kind: "conflict", lease: { dispatchId: "dispatch-other" } };

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "launch-failure-before-retry-lock-conflict",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    })).resolves.toEqual({
      kind: "intervention_required",
      reason: "replacement_not_conflict_free",
      dispatchId: "orca-dispatch-1"
    });

    expect(store.dispatches.has("dispatch:proposal-1:implement:2")).toBe(false);
    expect(store.tasks.get("task:proposal-1:implement")?.state).toBe("intervention_required");
    expect(store.runs.get("run:proposal-1")?.state).toBe("intervention_required");
    expect(git.created).toHaveLength(1);
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(1);
  });

  it("releases the exact retry lease and persists intervention when replacement worker-start fails", async () => {
    // Break caught: attempt two must own its cleanup and cannot leave the Run active after start rejection.
    const { service, orca, locks, store } = setup();
    await service.start(authorized());
    orca.dispatchErrorOnCall = 2;

    await expect(service.recordLaunchFailure({
      dispatchId: "orca-dispatch-1",
      failureId: "launch-failure-before-retry-start",
      evidence: { kind: "orca_worker_state", state: "launch_failed" }
    })).rejects.toMatchObject({
      code: "provider_process_failed",
      provider: "codex",
      phase: "start"
    });

    expect(locks.released.at(-1)).toEqual({
      lockKey: project.lockKey,
      dispatchId: "dispatch:proposal-1:implement:2"
    });
    expect(store.dispatches.get("dispatch:proposal-1:implement:2")?.state)
      .toBe("intervention_required");
    expect(store.tasks.get("task:proposal-1:implement")?.state)
      .toBe("intervention_required");
    expect(store.runs.get("run:proposal-1")?.state)
      .toBe("intervention_required");
  });
});
