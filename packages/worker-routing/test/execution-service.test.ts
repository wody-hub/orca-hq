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
  ExecutionLifecycle,
  ExecutionService,
  GitWorktreePlacementService,
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
  type RunRecord,
  type TaskRecord,
  type UserVisibleLifecycleMessage,
  type WorkerMessage
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
  #task = 0;
  #dispatch = 0;

  async execute(operation: OrcaOperation): Promise<OrcaReceipt> {
    this.calls.push(structuredClone(operation));
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
        return receipt(`dispatch-receipt-${this.#dispatch}`, {
          dispatchId: `orca-dispatch-${this.#dispatch}`,
          taskId: operation.taskId,
          runId: "orca-run-1",
          state: "ready",
          stage: "ready",
          setup: { state: "running" },
          effects: []
        });
      }
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

  async saveRun(record: RunRecord): Promise<void> {
    this.runs.set(record.id, structuredClone(record));
  }

  async saveTask(record: TaskRecord): Promise<void> {
    this.tasks.set(record.id, structuredClone(record));
  }

  async saveDispatch(record: DispatchRecord): Promise<void> {
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

  async recordWorkerDoneOnce(message: LifecycleMessage & { kind: "worker_done" }): Promise<
    "inserted" | "duplicate"
  > {
    if (this.#doneDispatches.has(message.dispatchId)) return "duplicate";
    this.#doneDispatches.add(message.dispatchId);
    this.messages.push(structuredClone(message));
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

  async resolveRevision(_repositoryPath: string, _ref: string): Promise<string> {
    return this.baseCommit;
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

function setup(git = new MemoryGit()): {
  service: ExecutionService;
  orca: RecordingOrca;
  git: MemoryGit;
  locks: RecordingLocks;
  store: MemoryLifecycleStore;
  messages: RecordingMessageSink;
} {
  const orca = new RecordingOrca();
  const locks = new RecordingLocks();
  const store = new MemoryLifecycleStore();
  const messages = new RecordingMessageSink();
  const lifecycle = new ExecutionLifecycle({ store, messages });
  return {
    service: new ExecutionService({
      orca,
      placements: new GitWorktreePlacementService(git),
      locks,
      lifecycle
    }),
    orca,
    git,
    locks,
    store,
    messages
  };
}

const sandboxes: SandboxRepo[] = [];

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.cleanup()));
});

describe("ExecutionService preflight and dispatch", () => {
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
      "dispatch_worker"
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
    expect(orca.calls.at(-1)).toMatchObject({
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
      receipt: { id: "dispatch-receipt-1", ok: true }
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
      lifecycle: new ExecutionLifecycle({ store, messages: new RecordingMessageSink() })
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
    const { service, store, messages } = setup();
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
    await expect(service.recordWorkerMessage(done)).resolves.toMatchObject({
      kind: "recorded",
      verificationRequired: true
    });

    expect(store.messages).toEqual([question, escalation, done]);
    expect(messages.messages).toEqual([question, escalation]);
    expect(messages.messages).not.toContainEqual(expect.objectContaining({ kind: "success" }));
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
      "dispatch_worker"
    ]);
    expect(store.messages.filter(({ kind }) => kind === "worker_done")).toHaveLength(1);
  });

  it("permits one conflict-free replacement launch and requires intervention after its failure", async () => {
    // Break caught: an unbounded launch loop can duplicate workers and edits after partial startup.
    const { service, orca, git, store } = setup();
    await service.start(authorized());

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
    expect(dispatchCalls[1]).toMatchObject({ retryOf: "orca-dispatch-1" });
    expect(git.created).toHaveLength(2);
    expect(git.created[1]?.worktreePath).not.toBe(git.created[0]?.worktreePath);
    expect([...store.dispatches.values()]).toHaveLength(2);

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
    expect(orca.calls.filter(({ kind }) => kind === "dispatch_worker")).toHaveLength(2);
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
});
