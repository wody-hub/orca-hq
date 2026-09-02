import { createHash } from "node:crypto";
import { dirname } from "node:path";

import type { ExecutionProposal } from "@orca-hq/core";
import type { OrcaOperation, OrcaReceipt } from "../../orca-adapter/src/index.js";
import type { ProjectRegistryEntry } from "../../project-registry/src/index.js";
import {
  createSandboxRepo,
  type SandboxRepo
} from "../../test-support/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexWorkerProvider,
  ExecutionLifecycle,
  ExecutionService,
  GitWorktreePlacementService,
  WorkerProviderError,
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
  type ProviderCapabilities,
  type ProviderStartReceipt,
  type RunRecord,
  type TaskRecord,
  type UserVisibleLifecycleMessage,
  type WorkerDoneCommit,
  type WorkerMessage,
  type WorkerProvider,
  type WorkerProviderRegistryPort
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
  dispatchErrorOnCall: number | undefined;
  malformedDispatchId: string | undefined;
  dispatchTaskId: string | undefined;
  effectiveEnvironmentKeys: string[] = ["HOME", "PATH"];
  #task = 0;
  #dispatch = 0;

  constructor(readonly events: string[] = []) {}

  async execute(operation: OrcaOperation): Promise<OrcaReceipt> {
    this.calls.push(structuredClone(operation));
    this.events.push(`orca:${operation.kind}`);
    switch (operation.kind) {
      case "create_run":
        return receipt("run-receipt", { runId: "orca-run-1" });
      case "create_task": {
        this.#task += 1;
        return receipt(`task-receipt-${this.#task}`, {
          taskId: `orca-task-${this.#task}`,
          runId: "orca-run-1",
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
        return receipt(`dispatch-receipt-${this.#dispatch}`, {
          dispatchId: `orca-dispatch-${this.#dispatch}`,
          taskId: this.dispatchTaskId ?? operation.taskId,
          runId: "orca-run-1",
          state: "ready",
          stage: "ready",
          setup: { state: "running" },
          effects: [],
          launch: {
            providerEnvironment: {
              kind: "verified_effective_allowlist",
              effectiveEnvironmentKeys: this.effectiveEnvironmentKeys
            }
          }
        });
      }
      case "show_worker":
        return receipt(`show-receipt-${operation.dispatchId}`, {
          dispatch: {
            id: operation.dispatchId,
            task_id: "orca-task-1",
            run_id: "orca-run-1",
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
            id: `resource-${operation.dispatchId}`,
            ownershipState: "owned",
            releaseState: "active"
          }
        });
      case "read_worker":
        return receipt(`read-receipt-${operation.dispatchId}`, {
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
        return receipt(`stop-receipt-${operation.dispatchId}`, {
          dispatchId: operation.dispatchId,
          state: "stopped",
          verdict: "stopped"
        });
      case "release_worker":
        if (this.releaseError !== undefined) throw this.releaseError;
        return receipt(`release-receipt-${operation.dispatchId}`, {
          dispatchId: operation.dispatchId,
          state: "released",
          verdict: "released"
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
  providerFactory?: (orca: RecordingOrca) => WorkerProviderRegistryPort
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
      ...(providerFactory === undefined ? {} : { providers: providerFactory(orca) })
    }),
    orca,
    git,
    locks,
    store,
    messages,
    artifacts,
    events
  };
}

const sandboxes: SandboxRepo[] = [];

afterEach(async () => {
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
