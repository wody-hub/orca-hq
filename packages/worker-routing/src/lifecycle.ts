import { isAbsolute } from "node:path";

import {
  PreferredAgentSchema,
  TaskRoleSchema,
  type PreferredAgent,
  type TaskRole
} from "@orca-hq/core";
import type { OrcaReceipt } from "@orca-hq/orca-adapter";
import { z } from "zod";

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
  | "intervention_required";

export type TaskState =
  | "planned"
  | "creating"
  | "ready"
  | "running"
  | "worker_done"
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
  retryOf?: string | undefined;
  orcaDispatchId?: string | undefined;
  receipt?: OrcaReceipt | undefined;
  launchFailureId?: string | undefined;
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

type MaybePromise<T> = T | Promise<T>;

export interface LifecycleStore {
  saveRun(record: RunRecord): MaybePromise<void>;
  saveTask(record: TaskRecord): MaybePromise<void>;
  saveDispatch(record: DispatchRecord): MaybePromise<void>;
  appendTransition(transition: LifecycleTransition): MaybePromise<void>;
  appendMessageOnce(message: LifecycleMessage): MaybePromise<"inserted" | "duplicate">;
  recordWorkerDoneOnce(message: WorkerDone): MaybePromise<"inserted" | "duplicate">;
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
      "orcaDispatchId" | "receipt" | "launchFailureId"
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
      const result = await this.#store.recordWorkerDoneOnce(message);
      if (result === "duplicate") return Object.freeze({ kind: "duplicate" });
      const dispatch = await this.transitionDispatch(localDispatchId, "worker_done");
      await this.transitionTask(dispatch.taskId, "worker_done");
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
    const result = await this.#store.appendMessageOnce(message);
    if (result === "duplicate") return "duplicate";
    await this.transitionDispatch(localDispatchId, "launch_failed", {
      launchFailureId: message.messageId
    });
    return "recorded";
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
    const now = this.#clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError("lifecycle clock must return a valid Date");
    }
    await this.#store.appendTransition(Object.freeze({
      entity,
      entityId,
      from,
      to,
      at: now.toISOString(),
      ...(receiptId === undefined ? {} : { receiptId })
    }));
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
