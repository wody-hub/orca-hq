import { isAbsolute } from "node:path";

import {
  PreferredAgentSchema,
  TaskRoleSchema,
  type PreferredAgent,
  type TaskRole
} from "@orca-hq/core";
import type { OrcaReceipt } from "@orca-hq/orca-adapter";
import { z } from "zod";

import type {
  AssignmentArtifact,
  AssignmentArtifactCleanupResult
} from "./assignment-artifacts.js";
import type {
  ProviderInspectReceipt,
  ProviderStartReceipt,
  WorkerProviderId
} from "./providers.js";
import type { VerificationCommandReceipt } from "./verifier.js";

const NonBlankStringSchema = z.string().trim().min(1);
const AbsolutePathSchema = NonBlankStringSchema.refine(isAbsolute, "must be an absolute path");
const StringListSchema = z.array(NonBlankStringSchema);

const AssignmentWorktreeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("existing-read-only"),
    path: AbsolutePathSchema,
    branch: NonBlankStringSchema.nullable(),
    head: NonBlankStringSchema
  }).strict(),
  z.object({
    kind: z.literal("approved-current"),
    path: AbsolutePathSchema,
    branch: NonBlankStringSchema.nullable(),
    head: NonBlankStringSchema,
    approvalId: NonBlankStringSchema
  }).strict(),
  z.object({
    kind: z.literal("isolated"),
    path: AbsolutePathSchema,
    branch: NonBlankStringSchema,
    head: NonBlankStringSchema
  }).strict()
]);

export const WorkerAssignmentSchema = z.object({
  protocol: z.literal(1),
  project: z.object({
    projectKey: NonBlankStringSchema,
    orcaProjectId: NonBlankStringSchema
  }).strict(),
  repo: z.object({
    repoId: NonBlankStringSchema,
    repositoryPath: AbsolutePathSchema
  }).strict(),
  worktree: AssignmentWorktreeSchema,
  base: z.object({
    ref: NonBlankStringSchema,
    commit: NonBlankStringSchema
  }).strict(),
  title: NonBlankStringSchema,
  role: TaskRoleSchema,
  preferredAgent: PreferredAgentSchema,
  fileScope: StringListSchema,
  acceptanceCommands: StringListSchema,
  prohibitedEffects: StringListSchema,
  taskId: NonBlankStringSchema,
  dispatchId: NonBlankStringSchema,
  permissions: z.enum(["read-only", "read-write"]),
  nestedWorkers: z.literal("forbidden")
}).strict();

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type WorkerAssignment = DeepReadonly<z.infer<typeof WorkerAssignmentSchema>>;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as DeepReadonly<T>;
}

export function parseWorkerAssignment(value: unknown): WorkerAssignment {
  return deepFreeze(WorkerAssignmentSchema.parse(value));
}

export type RunState =
  | "planned"
  | "creating"
  | "active"
  | "awaiting_verification"
  | "investigation_complete"
  | "verified_success"
  | "intervention_required";

export type TaskState =
  | "planned"
  | "creating"
  | "ready"
  | "running"
  | "worker_done"
  | "verification_failed"
  | "verified_success"
  | "intervention_required";

export type DispatchState =
  | "planned"
  | "launching"
  | "running"
  | "worker_done"
  | "launch_failed"
  | "intervention_required";

export type RunRecord = Readonly<{
  id: string;
  proposalId: string;
  commandId: string;
  objective: string;
  state: RunState;
  orcaRunId?: string | undefined;
  receipt?: OrcaReceipt | undefined;
  recoveryContext?: unknown;
}>;

export type VerificationObligationStatus =
  | "pending"
  | "verifier_running"
  | "fix_required"
  | "passed"
  | "intervention_required";

export type VerificationObligation = Readonly<{
  rootImplementationTaskId: string;
  currentImplementationTaskId: string;
  implementationDispatchId: string;
  cycle: number;
  status: VerificationObligationStatus;
  verificationTaskId?: string | undefined;
}>;

export type TaskRecord = Readonly<{
  id: string;
  runId: string;
  localId: string;
  title: string;
  role: TaskRole;
  preferredAgent: PreferredAgent;
  dependsOn: readonly string[];
  state: TaskState;
  orcaTaskId?: string | undefined;
  receipt?: OrcaReceipt | undefined;
}>;

export type DispatchRecord = Readonly<{
  id: string;
  taskId: string;
  attempt: number;
  state: DispatchState;
  assignment: WorkerAssignment;
  assignmentArtifact?: AssignmentArtifact | undefined;
  assignmentArtifactCleanup?: Readonly<{
    kind: AssignmentArtifactCleanupResult;
  }> | undefined;
  assignmentArtifactCleanupFailure?: WorkerReleaseFailure | undefined;
  retryOf?: string | undefined;
  orcaDispatchId?: string | undefined;
  receipt?: OrcaReceipt | undefined;
  providerId?: WorkerProviderId | undefined;
  providerStartReceipt?: ProviderStartReceipt | undefined;
  providerInspectReceipts?: readonly ProviderInspectReceipt[] | undefined;
  fenceReceipt?: OrcaReceipt | undefined;
  fenceFailure?: WorkerReleaseFailure | undefined;
  launchFailureId?: string | undefined;
  releaseReceipt?: OrcaReceipt | undefined;
  releaseFailure?: WorkerReleaseFailure | undefined;
  verificationCommands?: readonly VerificationCommandReceipt[] | undefined;
  workerCompletion?: WorkerCompletionIdentity | undefined;
  workerCompletionAuditReference?: string | undefined;
  repositorySnapshots?: VerifierRepositorySnapshots | undefined;
}>;

export const TrustedRepositorySnapshotSchema = z.object({
  repositoryPath: AbsolutePathSchema,
  worktreePath: AbsolutePathSchema,
  worktreeKind: z.enum(["existing-read-only", "approved-current", "isolated"]),
  head: NonBlankStringSchema,
  branch: NonBlankStringSchema.nullable(),
  statusSha256: z.string().regex(/^[a-f0-9]{64}$/),
  diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
  auditReference: NonBlankStringSchema.max(256)
}).strict();

export type TrustedRepositorySnapshot = Readonly<
  z.infer<typeof TrustedRepositorySnapshotSchema>
>;

export type VerifierRepositorySnapshots = Readonly<{
  before: TrustedRepositorySnapshot;
  after?: TrustedRepositorySnapshot | undefined;
  mutated?: boolean | undefined;
}>;

export type WorkerCompletionIdentity = Readonly<{
  dispatchId: string;
  outcome: "completed" | "failed";
  summary: string;
}>;

export type WorkerReleaseFailure = Readonly<{
  code: string;
  retryable: boolean;
}>;

export type LifecycleTransition = Readonly<{
  entity: "run" | "task" | "dispatch";
  entityId: string;
  from: RunState | TaskState | DispatchState;
  to: RunState | TaskState | DispatchState;
  at: string;
  receiptId?: string | undefined;
}>;

export type WorkerQuestion = Readonly<{
  kind: "question";
  messageId: string;
  dispatchId: string;
  text: string;
}>;

export type WorkerEscalation = Readonly<{
  kind: "escalation";
  messageId: string;
  dispatchId: string;
  reason: string;
}>;

export type WorkerDone = Readonly<{
  kind: "worker_done";
  messageId: string;
  dispatchId: string;
  outcome: "completed" | "failed";
  summary: string;
}>;

export type WorkerMessage = WorkerQuestion | WorkerEscalation | WorkerDone;

export type LaunchFailureMessage = Readonly<{
  kind: "launch_failure";
  messageId: string;
  dispatchId: string;
  evidence: Readonly<{
    kind: "orca_worker_state";
    state: "launch_failed" | "process_failed";
  }>;
}>;

export type LifecycleMessage = WorkerMessage | LaunchFailureMessage;
export type UserVisibleLifecycleMessage = WorkerQuestion | WorkerEscalation;

export type WorkerDoneCommit = Readonly<{
  message: WorkerDone;
  dispatch: DispatchRecord;
  task: TaskRecord;
  transitions: readonly [LifecycleTransition, LifecycleTransition];
}>;

export type LaunchFailureCommit = Readonly<{
  message: LaunchFailureMessage;
  dispatch: DispatchRecord;
  transition: LifecycleTransition;
}>;

export type DurableRunGraph = Readonly<{
  run: RunRecord;
  tasks: readonly TaskRecord[];
  dispatches: readonly DispatchRecord[];
  activeLeaseDispatchIds: readonly string[];
}>;

type MaybePromise<T> = T | Promise<T>;

export interface LifecycleStore {
  saveRun(record: RunRecord): MaybePromise<void>;
  saveTask(record: TaskRecord): MaybePromise<void>;
  saveDispatch(record: DispatchRecord): MaybePromise<void>;
  appendTransition(transition: LifecycleTransition): MaybePromise<void>;
  appendMessageOnce(message: LifecycleMessage): MaybePromise<"inserted" | "duplicate">;
  commitWorkerDone(input: WorkerDoneCommit): MaybePromise<"inserted" | "duplicate">;
  commitLaunchFailure(input: LaunchFailureCommit): MaybePromise<"inserted" | "duplicate">;
  ensureVerificationObligations(
    runId: string,
    obligations: readonly VerificationObligation[]
  ): MaybePromise<void>;
  setVerificationObligationVerifier(input: Readonly<{
    runId: string;
    rootImplementationTaskId: string;
    currentImplementationTaskId: string;
    implementationDispatchId: string;
    cycle: number;
    verificationTaskId: string;
  }>): MaybePromise<void>;
  loadRunRecord?(id: string): MaybePromise<unknown | undefined>;
  loadTaskRecord?(id: string): MaybePromise<unknown | undefined>;
  loadDispatchesForTask?(taskId: string): MaybePromise<readonly unknown[]>;
  loadRunGraphForDispatch?(dispatchId: string): MaybePromise<unknown | undefined>;
}

export interface LifecycleMessageSink {
  publish(message: UserVisibleLifecycleMessage): MaybePromise<void>;
}

export interface LifecycleClock {
  now(): Date;
}

const noMessages: LifecycleMessageSink = Object.freeze({
  publish: () => undefined
});

const systemClock: LifecycleClock = Object.freeze({
  now: () => new Date()
});

export class ExecutionLifecycle {
  readonly #runs = new Map<string, RunRecord>();
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #dispatches = new Map<string, DispatchRecord>();
  readonly #store: LifecycleStore;
  readonly #messages: LifecycleMessageSink;
  readonly #clock: LifecycleClock;

  constructor(options: Readonly<{
    store: LifecycleStore;
    messages?: LifecycleMessageSink | undefined;
    clock?: LifecycleClock | undefined;
  }>) {
    this.#store = options.store;
    this.#messages = options.messages ?? noMessages;
    this.#clock = options.clock ?? systemClock;
  }

  async planRun(record: RunRecord): Promise<void> {
    if (this.#runs.has(record.id)) throw new Error(`Run ${record.id} is already planned`);
    const planned = Object.freeze({ ...record, state: "planned" as const });
    this.#runs.set(planned.id, planned);
    await this.#store.saveRun(planned);
  }

  async planTask(record: TaskRecord): Promise<void> {
    if (this.#tasks.has(record.id)) throw new Error(`Task ${record.id} is already planned`);
    const planned = Object.freeze({ ...record, dependsOn: Object.freeze([...record.dependsOn]), state: "planned" as const });
    this.#tasks.set(planned.id, planned);
    await this.#store.saveTask(planned);
  }

  async planDispatch(record: DispatchRecord): Promise<void> {
    if (this.#dispatches.has(record.id)) throw new Error(`Dispatch ${record.id} is already planned`);
    const planned = Object.freeze({ ...record, state: "planned" as const });
    this.#dispatches.set(planned.id, planned);
    await this.#store.saveDispatch(planned);
  }

  async transitionRun(
    id: string,
    state: RunState,
    patch: Readonly<Partial<Pick<RunRecord, "orcaRunId" | "receipt">>> = {}
  ): Promise<RunRecord> {
    const current = this.#required(this.#runs, "Run", id);
    const updated = Object.freeze({ ...current, ...patch, state });
    this.#runs.set(id, updated);
    await this.#store.saveRun(updated);
    await this.#transition("run", id, current.state, state, patch.receipt?.id);
    return updated;
  }

  async transitionTask(
    id: string,
    state: TaskState,
    patch: Readonly<Partial<Pick<TaskRecord, "orcaTaskId" | "receipt">>> = {}
  ): Promise<TaskRecord> {
    const current = this.#required(this.#tasks, "Task", id);
    const updated = Object.freeze({ ...current, ...patch, state });
    this.#tasks.set(id, updated);
    await this.#store.saveTask(updated);
    await this.#transition("task", id, current.state, state, patch.receipt?.id);
    return updated;
  }

  async transitionDispatch(
    id: string,
    state: DispatchState,
    patch: Readonly<Partial<Pick<
      DispatchRecord,
      | "orcaDispatchId"
      | "receipt"
      | "providerId"
      | "providerStartReceipt"
      | "assignmentArtifact"
      | "assignmentArtifactCleanup"
      | "assignmentArtifactCleanupFailure"
      | "fenceReceipt"
      | "fenceFailure"
      | "launchFailureId"
      | "releaseReceipt"
      | "releaseFailure"
    >>> = {}
  ): Promise<DispatchRecord> {
    const current = this.#required(this.#dispatches, "Dispatch", id);
    const updated = Object.freeze({ ...current, ...patch, state });
    this.#dispatches.set(id, updated);
    await this.#store.saveDispatch(updated);
    await this.#transition("dispatch", id, current.state, state, patch.receipt?.id);
    return updated;
  }

  async recordWorkerMessage(
    message: WorkerMessage,
    localDispatchId: string
  ): Promise<Readonly<
    | { kind: "recorded"; verificationRequired?: true | undefined }
    | { kind: "duplicate" }
  >> {
    if (message.kind === "worker_done") {
      const currentDispatch = this.#required(this.#dispatches, "Dispatch", localDispatchId);
      const currentTask = this.#required(this.#tasks, "Task", currentDispatch.taskId);
      const workerCompletion = Object.freeze({
        dispatchId: message.dispatchId,
        outcome: message.outcome,
        summary: message.summary
      });
      const workerCompletionAuditReference = currentDispatch.workerCompletionAuditReference
        ?? `worker-message:${message.messageId}`;
      const dispatch = Object.freeze({
        ...currentDispatch,
        state: "worker_done" as const,
        workerCompletion,
        workerCompletionAuditReference
      });
      const task = Object.freeze({ ...currentTask, state: "worker_done" as const });
      const transitions = Object.freeze([
        this.#newTransition("dispatch", dispatch.id, currentDispatch.state, dispatch.state),
        this.#newTransition("task", task.id, currentTask.state, task.state)
      ] as const);
      const result = await this.#store.commitWorkerDone(Object.freeze({
        message,
        dispatch,
        task,
        transitions
      }));
      if (result === "duplicate") return Object.freeze({ kind: "duplicate" });
      this.#dispatches.set(dispatch.id, dispatch);
      this.#tasks.set(task.id, task);
      return Object.freeze({ kind: "recorded", verificationRequired: true });
    }

    const result = await this.#store.appendMessageOnce(message);
    if (result === "duplicate") return Object.freeze({ kind: "duplicate" });
    await this.#messages.publish(message);
    return Object.freeze({ kind: "recorded" });
  }

  async recordLaunchFailure(
    message: LaunchFailureMessage,
    localDispatchId: string
  ): Promise<"recorded" | "duplicate"> {
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    if (current.fenceReceipt === undefined || current.orcaDispatchId === undefined) {
      throw new Error(`Dispatch ${localDispatchId} has no authoritative terminal proof`);
    }
    const updated = Object.freeze({
      ...current,
      state: "launch_failed" as const,
      launchFailureId: message.messageId
    });
    const transition = this.#newTransition(
      "dispatch",
      localDispatchId,
      current.state,
      "launch_failed",
      current.fenceReceipt.id
    );
    const result = await this.#store.commitLaunchFailure(Object.freeze({
      message,
      dispatch: updated,
      transition
    }));
    if (result === "duplicate") return "duplicate";
    this.#dispatches.set(localDispatchId, updated);
    return "recorded";
  }

  async recordWorkerRelease(
    localDispatchId: string,
    outcome: Readonly<
      | { releaseReceipt: OrcaReceipt }
      | { releaseFailure: WorkerReleaseFailure }
    >
  ): Promise<DispatchRecord> {
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    const updated = Object.freeze({ ...current, ...outcome });
    await this.#store.saveDispatch(updated);
    this.#dispatches.set(localDispatchId, updated);
    return updated;
  }

  async recordWorkerFence(
    localDispatchId: string,
    orcaDispatchId: string,
    outcome: Readonly<
      | { fenceReceipt: OrcaReceipt }
      | { fenceFailure: WorkerReleaseFailure }
    >
  ): Promise<DispatchRecord> {
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    const updated = Object.freeze({ ...current, ...outcome, orcaDispatchId });
    await this.#store.saveDispatch(updated);
    this.#dispatches.set(localDispatchId, updated);
    return updated;
  }

  async recordVerificationCommands(
    localDispatchId: string,
    commands: readonly VerificationCommandReceipt[]
  ): Promise<DispatchRecord> {
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    if (current.state !== "worker_done" || current.assignment.role !== "verify") {
      throw new Error(`verification Dispatch ${localDispatchId} is not worker_done`);
    }
    if (
      JSON.stringify(commands.map(({ command }) => command))
      !== JSON.stringify(current.assignment.acceptanceCommands)
    ) {
      throw new TypeError("verifier command evidence does not match its assigned acceptance commands");
    }
    const updated = Object.freeze({
      ...current,
      verificationCommands: Object.freeze(commands.map((command) => Object.freeze({ ...command })))
    });
    await this.#store.saveDispatch(updated);
    this.#dispatches.set(localDispatchId, updated);
    return updated;
  }

  async recordVerifierRepositorySnapshotBefore(
    localDispatchId: string,
    snapshotInput: TrustedRepositorySnapshot,
    implementationDiffSha256: string
  ): Promise<DispatchRecord> {
    const snapshot = Object.freeze(TrustedRepositorySnapshotSchema.parse(snapshotInput));
    const expectedDiffSha256 = z.string().regex(/^[a-f0-9]{64}$/).parse(
      implementationDiffSha256
    );
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    if (current.assignment.role !== "verify" || current.state !== "planned") {
      throw new Error(`verification Dispatch ${localDispatchId} is not awaiting launch`);
    }
    if (
      snapshot.repositoryPath !== current.assignment.repo.repositoryPath
      || snapshot.worktreePath !== current.assignment.worktree.path
      || snapshot.worktreeKind !== current.assignment.worktree.kind
      || snapshot.branch !== current.assignment.worktree.branch
    ) {
      throw new TypeError("verification repository baseline is not bound to its assignment");
    }
    if (snapshot.diffSha256 !== expectedDiffSha256) {
      throw new TypeError(
        "verification repository baseline diff does not match implementation evidence"
      );
    }
    if (current.repositorySnapshots !== undefined) {
      const { auditReference: _currentAudit, ...currentIdentity } =
        current.repositorySnapshots.before;
      const { auditReference: _snapshotAudit, ...snapshotIdentity } = snapshot;
      if (JSON.stringify(currentIdentity) !== JSON.stringify(snapshotIdentity)) {
        throw new TypeError("verification repository baseline changed");
      }
      return current;
    }
    const updated = Object.freeze({
      ...current,
      repositorySnapshots: Object.freeze({ before: snapshot })
    });
    await this.#store.saveDispatch(updated);
    this.#dispatches.set(localDispatchId, updated);
    return updated;
  }

  async recordVerifierRepositorySnapshotAfter(
    localDispatchId: string,
    snapshotInput: TrustedRepositorySnapshot
  ): Promise<DispatchRecord> {
    const after = Object.freeze(TrustedRepositorySnapshotSchema.parse(snapshotInput));
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    const before = current.repositorySnapshots?.before;
    if (current.assignment.role !== "verify" || current.state !== "worker_done" || before === undefined) {
      throw new Error(`verification Dispatch ${localDispatchId} has no durable baseline`);
    }
    const { auditReference: _beforeAudit, ...beforeIdentity } = before;
    const { auditReference: _afterAudit, ...afterIdentity } = after;
    const mutated = JSON.stringify(beforeIdentity) !== JSON.stringify(afterIdentity);
    const updated = Object.freeze({
      ...current,
      repositorySnapshots: Object.freeze({ before, after, mutated })
    });
    await this.#store.saveDispatch(updated);
    this.#dispatches.set(localDispatchId, updated);
    return updated;
  }

  async recordAssignmentArtifact(
    localDispatchId: string,
    artifact: AssignmentArtifact
  ): Promise<DispatchRecord> {
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    if (artifact.ownerDispatchId !== localDispatchId) {
      throw new TypeError("assignment artifact owner does not match the Dispatch");
    }
    const updated = Object.freeze({ ...current, assignmentArtifact: artifact });
    await this.#store.saveDispatch(updated);
    this.#dispatches.set(localDispatchId, updated);
    return updated;
  }

  async recordAssignmentArtifactCleanup(
    localDispatchId: string,
    artifact: AssignmentArtifact,
    kind: AssignmentArtifactCleanupResult
  ): Promise<DispatchRecord> {
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    if (artifact.ownerDispatchId !== localDispatchId) {
      throw new TypeError("assignment artifact owner does not match the Dispatch");
    }
    const updated = Object.freeze({
      ...current,
      assignmentArtifact: artifact,
      assignmentArtifactCleanup: Object.freeze({ kind })
    });
    await this.#store.saveDispatch(updated);
    this.#dispatches.set(localDispatchId, updated);
    return updated;
  }

  async recordAssignmentArtifactCleanupFailure(
    localDispatchId: string,
    artifact: AssignmentArtifact,
    failure: WorkerReleaseFailure
  ): Promise<DispatchRecord> {
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    if (artifact.ownerDispatchId !== localDispatchId) {
      throw new TypeError("assignment artifact owner does not match the Dispatch");
    }
    const updated = Object.freeze({
      ...current,
      assignmentArtifact: artifact,
      assignmentArtifactCleanupFailure: failure
    });
    await this.#store.saveDispatch(updated);
    this.#dispatches.set(localDispatchId, updated);
    return updated;
  }

  async recordProviderInspection(
    localDispatchId: string,
    receipt: ProviderInspectReceipt
  ): Promise<DispatchRecord> {
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    if (current.providerId === undefined || receipt.provider !== current.providerId) {
      throw new TypeError("provider inspection does not match the persisted provider");
    }
    if (current.orcaDispatchId === undefined || receipt.dispatchId !== current.orcaDispatchId) {
      throw new TypeError("provider inspection does not match the persisted Orca Dispatch");
    }
    const providerInspectReceipts = Object.freeze([
      ...(current.providerInspectReceipts ?? []),
      receipt
    ]);
    const updated = Object.freeze({ ...current, providerInspectReceipts });
    await this.#store.saveDispatch(updated);
    this.#dispatches.set(localDispatchId, updated);
    return updated;
  }

  async recordProviderStart(
    localDispatchId: string,
    input: Readonly<{
      orcaDispatchId: string;
      receipt: OrcaReceipt;
      providerId: WorkerProviderId;
      providerStartReceipt: ProviderStartReceipt;
    }>
  ): Promise<DispatchRecord> {
    const current = this.#required(this.#dispatches, "Dispatch", localDispatchId);
    if (current.state !== "launching") {
      throw new Error(`Dispatch ${localDispatchId} is not launching`);
    }
    const updated = Object.freeze({ ...current, ...input });
    await this.#store.saveDispatch(updated);
    this.#dispatches.set(localDispatchId, updated);
    return updated;
  }

  async ensureVerificationObligations(
    runId: string,
    obligations: readonly VerificationObligation[]
  ): Promise<void> {
    if (obligations.length === 0) {
      throw new TypeError("verification obligations must not be empty");
    }
    await this.#store.ensureVerificationObligations(runId, obligations);
  }

  async setVerificationObligationVerifier(input: Readonly<{
    runId: string;
    rootImplementationTaskId: string;
    currentImplementationTaskId: string;
    implementationDispatchId: string;
    cycle: number;
    verificationTaskId: string;
  }>): Promise<void> {
    await this.#store.setVerificationObligationVerifier(input);
  }

  async recoverRun(id: string): Promise<RunRecord | undefined> {
    const existing = this.#runs.get(id);
    const value = await this.#store.loadRunRecord?.(id);
    if (value === undefined) return existing;
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as RunRecord;
    if (record.id !== id) throw new TypeError("recovered Run identity mismatch");
    this.#runs.set(id, Object.freeze(record));
    return this.#runs.get(id);
  }

  async recoverTask(id: string): Promise<TaskRecord | undefined> {
    const existing = this.#tasks.get(id);
    const value = await this.#store.loadTaskRecord?.(id);
    if (value === undefined) return existing;
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as TaskRecord;
    if (record.id !== id) throw new TypeError("recovered Task identity mismatch");
    this.#tasks.set(id, Object.freeze(record));
    return this.#tasks.get(id);
  }

  async recoverDispatchesForTask(taskId: string): Promise<readonly DispatchRecord[]> {
    const values = await this.#store.loadDispatchesForTask?.(taskId) ?? [];
    const records = values.map((value) => {
      if (typeof value !== "object" || value === null) {
        throw new TypeError("recovered Dispatch is not an object");
      }
      const record = value as DispatchRecord;
      if (record.taskId !== taskId) throw new TypeError("recovered Dispatch ownership mismatch");
      this.#dispatches.set(record.id, Object.freeze(record));
      return this.#dispatches.get(record.id) as DispatchRecord;
    });
    return Object.freeze(records);
  }

  async recoverRunGraphForDispatch(dispatchId: string): Promise<DurableRunGraph | undefined> {
    const value = await this.#store.loadRunGraphForDispatch?.(dispatchId);
    if (value === undefined || typeof value !== "object" || value === null) return undefined;
    const graph = value as {
      run?: unknown;
      tasks?: unknown;
      dispatches?: unknown;
      activeLeaseDispatchIds?: unknown;
    };
    if (
      typeof graph.run !== "object"
      || graph.run === null
      || !Array.isArray(graph.tasks)
      || !Array.isArray(graph.dispatches)
      || !Array.isArray(graph.activeLeaseDispatchIds)
      || graph.activeLeaseDispatchIds.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      throw new TypeError("recovered Run graph is invalid");
    }
    const run = Object.freeze(graph.run as RunRecord);
    const tasks = graph.tasks.map((record) => {
      if (typeof record !== "object" || record === null) {
        throw new TypeError("recovered Task graph is invalid");
      }
      const task = Object.freeze(record as TaskRecord);
      if (task.runId !== run.id) throw new TypeError("recovered Task Run ownership mismatch");
      this.#tasks.set(task.id, task);
      return task;
    });
    const taskIds = new Set(tasks.map(({ id }) => id));
    const dispatches = graph.dispatches.map((record) => {
      if (typeof record !== "object" || record === null) {
        throw new TypeError("recovered Dispatch graph is invalid");
      }
      const dispatch = Object.freeze(record as DispatchRecord);
      if (!taskIds.has(dispatch.taskId)) {
        throw new TypeError("recovered Dispatch Task ownership mismatch");
      }
      this.#dispatches.set(dispatch.id, dispatch);
      return dispatch;
    });
    this.#runs.set(run.id, run);
    return Object.freeze({
      run,
      tasks: Object.freeze(tasks),
      dispatches: Object.freeze(dispatches),
      activeLeaseDispatchIds: Object.freeze([...graph.activeLeaseDispatchIds] as string[])
    });
  }

  run(id: string): RunRecord {
    return this.#required(this.#runs, "Run", id);
  }

  task(id: string): TaskRecord {
    return this.#required(this.#tasks, "Task", id);
  }

  dispatch(id: string): DispatchRecord {
    return this.#required(this.#dispatches, "Dispatch", id);
  }

  async #transition(
    entity: LifecycleTransition["entity"],
    entityId: string,
    from: LifecycleTransition["from"],
    to: LifecycleTransition["to"],
    receiptId?: string
  ): Promise<void> {
    await this.#store.appendTransition(this.#newTransition(
      entity,
      entityId,
      from,
      to,
      receiptId
    ));
  }

  #newTransition(
    entity: LifecycleTransition["entity"],
    entityId: string,
    from: LifecycleTransition["from"],
    to: LifecycleTransition["to"],
    receiptId?: string
  ): LifecycleTransition {
    const now = this.#clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError("lifecycle clock must return a valid Date");
    }
    return Object.freeze({
      entity,
      entityId,
      from,
      to,
      at: now.toISOString(),
      ...(receiptId === undefined ? {} : { receiptId })
    });
  }

  #required<RecordType>(
    records: ReadonlyMap<string, RecordType>,
    label: string,
    id: string
  ): RecordType {
    const record = records.get(id);
    if (record === undefined) throw new Error(`${label} ${id} is not known`);
    return record;
  }
}
