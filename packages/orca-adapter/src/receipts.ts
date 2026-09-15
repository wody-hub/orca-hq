import { z } from "zod";

const OrcaMetaSchema = z.record(z.unknown());
const OrcaIdSchema = z.string().min(1);
const OrcaStateSchema = z.string().min(1);

const OrcaSuccessReceiptSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown(),
  _meta: OrcaMetaSchema.optional()
}).strict();

const OrcaFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1)
}).passthrough();

const OrcaFailureReceiptSchema = z.union([
  z.object({
    id: z.string().min(1),
    ok: z.literal(false),
    error: OrcaFailureSchema,
    _meta: OrcaMetaSchema.optional()
  }).strict(),
  z.object({
    id: z.string().min(1),
    ok: z.literal(false),
    result: OrcaFailureSchema,
    _meta: OrcaMetaSchema.optional()
  }).strict()
]);

export const OrcaReceiptSchema = z.union([
  OrcaSuccessReceiptSchema,
  OrcaFailureReceiptSchema
]);

export const OrcaStatusReceiptSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    runtime: z.object({
      state: z.string().min(1),
      reachable: z.boolean(),
      appVersion: z.string().min(1),
      capabilities: z.array(z.string().min(1))
    }).passthrough()
  }).passthrough(),
  _meta: OrcaMetaSchema.optional()
}).strict();

export const OrcaSkillResponseSchema = z.object({
  name: z.enum(["orca-cli", "orchestration"]),
  full: z.boolean(),
  markdown: z.string().min(1)
}).passthrough();

const OrcaProjectSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  displayName: z.string().min(1),
  kind: z.string().min(1)
}).passthrough();

const OrcaProjectListReceiptSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    repos: z.array(OrcaProjectSchema)
  }).passthrough(),
  _meta: OrcaMetaSchema.optional()
}).strict();

const OrcaRunResultSchema = z.union([
  z.object({
    runId: OrcaIdSchema
  }).passthrough(),
  z.object({
    run: z.object({ id: OrcaIdSchema }).passthrough()
  }).passthrough()
]);

const OrcaTaskResultSchema = z.union([
  z.object({
    taskId: OrcaIdSchema,
    runId: OrcaIdSchema,
    status: OrcaStateSchema
  }).passthrough(),
  z.object({
    task: z.object({
      id: OrcaIdSchema,
      run_id: OrcaIdSchema,
      status: OrcaStateSchema
    }).passthrough()
  }).passthrough()
]);

const OrcaWorkerStartResultSchema = z.object({
  dispatchId: OrcaIdSchema,
  taskId: OrcaIdSchema,
  runId: OrcaIdSchema,
  state: OrcaStateSchema,
  stage: OrcaStateSchema,
  setup: z.object({ state: OrcaStateSchema }).passthrough(),
  effects: z.array(z.object({}).passthrough())
}).passthrough();

const OrcaDispatchSchema = z.object({
  id: OrcaIdSchema,
  task_id: OrcaIdSchema,
  run_id: OrcaIdSchema,
  status: OrcaStateSchema
}).passthrough();

const OrcaWorkerSchema = z.object({
  dispatch_id: OrcaIdSchema,
  state: OrcaStateSchema,
  stage: OrcaStateSchema,
  agent_terminal_handle: OrcaIdSchema.nullable()
}).passthrough();

const OrcaWorkerShowResultSchema = z.object({
  dispatch: OrcaDispatchSchema,
  worker: OrcaWorkerSchema,
  terminal: z.object({}).passthrough().nullable(),
  observation: z.object({
    status: OrcaStateSchema,
    exactWorker: z.boolean()
  }).passthrough(),
  terminalResource: z.object({
    id: OrcaIdSchema,
    ownershipState: OrcaStateSchema,
    releaseState: OrcaStateSchema
  }).passthrough()
}).passthrough();

const OrcaTranscriptMessageSchema = z.object({
  id: OrcaIdSchema,
  role: OrcaStateSchema,
  blocks: z.array(z.object({}).passthrough()),
  timestamp: z.number().finite(),
  source: OrcaStateSchema
}).passthrough();

const OrcaReadStatusSchema = z.object({
  worker: OrcaStateSchema,
  terminal: OrcaStateSchema
}).passthrough();

const OrcaWorkerReadBaseSchema = z.object({
  dispatchId: OrcaIdSchema,
  source: z.enum(["transcript", "terminal"]),
  cursor: OrcaIdSchema,
  status: OrcaReadStatusSchema,
  warnings: z.array(z.string()),
  archived: z.boolean()
}).passthrough();

const OrcaWorkerReadResultSchema = z.union([
  OrcaWorkerReadBaseSchema.extend({
    transcript: z.object({
      messages: z.array(OrcaTranscriptMessageSchema),
      limited: z.boolean(),
      nextCursor: OrcaIdSchema,
      returnedMessageCount: z.number().int().nonnegative()
    }).passthrough()
  }),
  OrcaWorkerReadBaseSchema.extend({
    terminal: z.object({
      lines: z.array(z.string()),
      limited: z.boolean(),
      nextCursor: OrcaIdSchema
    }).passthrough()
  })
]);

const OrcaWorkerStopResultSchema = z.object({
  dispatchId: OrcaIdSchema,
  state: OrcaStateSchema,
  verdict: OrcaStateSchema
}).passthrough();

const OrcaWorkerReleaseResultSchema = z.object({
  dispatchId: OrcaIdSchema,
  state: OrcaStateSchema,
  verdict: OrcaStateSchema
}).passthrough();

function successReceiptSchema<Result extends z.ZodTypeAny>(result: Result) {
  return z.object({
    id: OrcaIdSchema,
    ok: z.literal(true),
    result,
    _meta: OrcaMetaSchema.optional()
  }).strict();
}

const BoundedIdSchema = z.string().trim().min(1).max(512);
const BoundedTextSchema = z.string().max(64 * 1024);
const CursorSchema = z.string().trim().min(1).max(2048);
const NullableCursorSchema = CursorSchema.nullable().optional();
const MutationSchema = z.object({ requestId: BoundedIdSchema, replayed: z.boolean() }).passthrough();
const RunSchema = z.object({ id: BoundedIdSchema, objective: BoundedTextSchema }).passthrough();
const TaskSchema = z.object({ id: BoundedIdSchema, status: OrcaStateSchema }).passthrough();
const ProjectionSchema = z.object({
  dispatchId: BoundedIdSchema,
  taskId: BoundedIdSchema,
  runId: BoundedIdSchema,
  liveness: z.object({ verdict: OrcaStateSchema }).passthrough()
}).passthrough();
const WorkerListSchema = z.object({ dispatchId: BoundedIdSchema, projection: ProjectionSchema }).passthrough();
const InboxMessageSchema = z.object({
  id: BoundedIdSchema,
  type: OrcaStateSchema,
  subject: BoundedTextSchema,
  body: BoundedTextSchema
}).passthrough();
const ProjectSchema = z.object({ id: BoundedIdSchema, displayName: BoundedTextSchema, kind: OrcaStateSchema }).passthrough();
const SetupSchema = z.object({
  id: BoundedIdSchema,
  projectId: BoundedIdSchema,
  hostId: BoundedIdSchema,
  repoId: BoundedIdSchema,
  path: BoundedTextSchema
}).passthrough();
const WorktreeSchema = z.object({
  id: BoundedIdSchema,
  repoId: BoundedIdSchema,
  projectId: BoundedIdSchema,
  hostId: BoundedIdSchema,
  projectHostSetupId: BoundedIdSchema,
  path: BoundedTextSchema
}).passthrough();
const TerminalSchema = z.object({
  handle: BoundedIdSchema,
  incarnationId: BoundedIdSchema,
  worktreeId: BoundedIdSchema,
  connected: z.boolean(),
  writable: z.boolean(),
  executionHostId: BoundedIdSchema
}).passthrough();
const HostScopeSchema = z.object({
  hostIds: z.array(BoundedIdSchema).max(100),
  omittedHostIds: z.array(BoundedIdSchema).max(100)
}).passthrough();
const DispatchResultSchema = z.object({
  dispatchId: BoundedIdSchema,
  taskId: BoundedIdSchema,
  runId: BoundedIdSchema,
  mutation: MutationSchema.optional()
}).passthrough();
// Public Orca 1.4.203 reply receipt: message.thread_id identifies the replied-to message.
const OperationsMessageSchema = InboxMessageSchema.extend({
  type: BoundedIdSchema,
  run_id: BoundedIdSchema,
  from_handle: BoundedIdSchema,
  to_handle: BoundedIdSchema,
  thread_id: BoundedIdSchema.nullable(),
  created_at: z.string().datetime()
});
const MessageMutationResultSchema = z.object({
  message: OperationsMessageSchema,
  mutation: MutationSchema
}).passthrough();
const ReplyQuestionSchema = z.object({
  message_id: BoundedIdSchema,
  run_id: BoundedIdSchema,
  dispatch_id: BoundedIdSchema,
  asker_handle: BoundedIdSchema,
  status: z.literal("answered"),
  answer_message_id: BoundedIdSchema,
  answer_body: BoundedTextSchema,
  answered_by_generation: z.number().int().positive(),
  created_at: z.string().datetime(),
  answered_at: z.string().datetime(),
  closed_at: z.string().datetime().nullable()
}).passthrough();
const ReplyMutationResultSchema = z.object({
  message: OperationsMessageSchema.extend({ thread_id: BoundedIdSchema }),
  question: ReplyQuestionSchema.nullish(),
  duplicate: z.boolean(),
  mutation: MutationSchema
}).passthrough();
const OperationsStateSchema = z.string().trim().min(1).max(512);
const OperationsWorkerReadBaseSchema = z.object({
  dispatchId: BoundedIdSchema,
  cursor: CursorSchema,
  status: z.object({ worker: OperationsStateSchema, terminal: OperationsStateSchema }).passthrough(),
  warnings: z.array(BoundedTextSchema).max(100),
  archived: z.boolean()
}).passthrough();
const OperationsWorkerReadResultSchema = z.discriminatedUnion("source", [
  OperationsWorkerReadBaseSchema.extend({
    source: z.literal("transcript"),
    terminal: z.never().optional(),
    transcript: z.object({
      messages: z.array(z.object({
        id: BoundedIdSchema,
        role: OperationsStateSchema,
        blocks: z.array(z.object({}).passthrough().refine(
          (block) => JSON.stringify(block).length <= 64 * 1024,
          "transcript block exceeds public text bound"
        )).max(500),
        timestamp: z.number().finite(),
        source: OperationsStateSchema
      }).passthrough()).max(500),
      limited: z.boolean(),
      nextCursor: CursorSchema,
      returnedMessageCount: z.number().int().nonnegative().max(500)
    }).passthrough()
  }),
  OperationsWorkerReadBaseSchema.extend({
    source: z.literal("terminal"),
    transcript: z.never().optional(),
    terminal: z.object({
      lines: z.array(BoundedTextSchema).max(500),
      limited: z.boolean(),
      nextCursor: CursorSchema
    }).passthrough()
  })
]);
const WorkerMutationResultSchema = z.object({
  dispatchId: BoundedIdSchema,
  state: OperationsStateSchema,
  verdict: OperationsStateSchema,
  mutation: MutationSchema.optional()
}).passthrough();

const operationsReceiptSchemas = {
  operations_show_worker: successReceiptSchema(z.object({
    dispatch: z.object({ id: BoundedIdSchema, runId: BoundedIdSchema, taskId: BoundedIdSchema, status: OperationsStateSchema, processIncarnation: BoundedIdSchema.nullable().optional() }).passthrough(),
    worker: z.object({ dispatchId: BoundedIdSchema, state: OperationsStateSchema, stage: OperationsStateSchema, agentTerminalHandle: BoundedIdSchema.nullable() }).passthrough(),
    projection: ProjectionSchema,
    observation: z.object({ status: OperationsStateSchema, exactWorker: z.boolean() }).passthrough(),
    terminal: TerminalSchema.nullable(),
    terminalResource: z.object({ id: BoundedIdSchema, ownershipState: OperationsStateSchema, releaseState: OperationsStateSchema }).passthrough()
  }).passthrough()),
  operations_status: OrcaStatusReceiptSchema,
  list_runs: successReceiptSchema(z.object({ runs: z.array(RunSchema).max(100), nextCursor: NullableCursorSchema }).passthrough()),
  show_run: successReceiptSchema(z.object({ run: RunSchema }).passthrough()),
  list_tasks: successReceiptSchema(z.object({ tasks: z.array(TaskSchema).max(100) }).passthrough()),
  list_workers: successReceiptSchema(z.object({
    workers: z.array(WorkerListSchema).max(100),
    page: z.object({ limit: z.number().int().positive().max(100), hasMore: z.boolean(), nextCursor: NullableCursorSchema }).passthrough(),
    scope: z.object({ source: OrcaStateSchema }).passthrough()
  }).passthrough()),
  operations_worker_read: successReceiptSchema(OperationsWorkerReadResultSchema),
  operations_inbox: successReceiptSchema(z.object({ messages: z.array(InboxMessageSchema).max(100), count: z.number().int().nonnegative() }).passthrough()),
  operations_list_projects: successReceiptSchema(z.object({ projects: z.array(ProjectSchema).max(100) }).passthrough()),
  list_project_setups: successReceiptSchema(z.object({ setups: z.array(SetupSchema).max(100) }).passthrough()),
  list_worktrees: successReceiptSchema(z.object({ worktrees: z.array(WorktreeSchema).max(100), hostScope: HostScopeSchema, totalCount: z.number().int().nonnegative(), truncated: z.boolean() }).passthrough()),
  show_worktree: successReceiptSchema(z.object({ worktree: WorktreeSchema }).passthrough()),
  list_terminals: successReceiptSchema(z.object({ terminals: z.array(TerminalSchema).max(100), hostScope: HostScopeSchema, totalCount: z.number().int().nonnegative(), truncated: z.boolean() }).passthrough()),
  show_terminal: successReceiptSchema(z.object({ terminal: TerminalSchema }).passthrough()),
  read_terminal: successReceiptSchema(z.object({ terminal: z.object({
    handle: BoundedIdSchema,
    status: OrcaStateSchema,
    tail: z.array(BoundedTextSchema).max(500),
    truncated: z.boolean(),
    limited: z.boolean(),
    nextCursor: CursorSchema,
    source: OrcaStateSchema
  }).passthrough() }).passthrough()),
  operations_dispatch: successReceiptSchema(DispatchResultSchema),
  operations_reply: successReceiptSchema(ReplyMutationResultSchema),
  operations_send: successReceiptSchema(MessageMutationResultSchema),
  operations_stop: successReceiptSchema(WorkerMutationResultSchema),
  operations_retain: successReceiptSchema(WorkerMutationResultSchema),
  operations_release: successReceiptSchema(WorkerMutationResultSchema)
} as const;

export type OrcaOperationsReceiptKind = keyof typeof operationsReceiptSchemas;
export const OrcaOperationsReceiptSchema = z.union([
  operationsReceiptSchemas.operations_show_worker,
  operationsReceiptSchemas.operations_status,
  operationsReceiptSchemas.list_runs,
  operationsReceiptSchemas.show_run,
  operationsReceiptSchemas.list_tasks,
  operationsReceiptSchemas.list_workers,
  operationsReceiptSchemas.operations_worker_read,
  operationsReceiptSchemas.operations_inbox,
  operationsReceiptSchemas.operations_list_projects,
  operationsReceiptSchemas.list_project_setups,
  operationsReceiptSchemas.list_worktrees,
  operationsReceiptSchemas.show_worktree,
  operationsReceiptSchemas.list_terminals,
  operationsReceiptSchemas.show_terminal,
  operationsReceiptSchemas.read_terminal,
  operationsReceiptSchemas.operations_dispatch,
  operationsReceiptSchemas.operations_reply,
  operationsReceiptSchemas.operations_send,
  operationsReceiptSchemas.operations_stop,
  operationsReceiptSchemas.operations_retain,
  operationsReceiptSchemas.operations_release
]);
export type OrcaOperationsReceipt = z.infer<typeof OrcaOperationsReceiptSchema>;

export const OrcaCreateRunReceiptSchema = successReceiptSchema(OrcaRunResultSchema);
export const OrcaCreateTaskReceiptSchema = successReceiptSchema(OrcaTaskResultSchema);
export const OrcaStartWorkerReceiptSchema = successReceiptSchema(OrcaWorkerStartResultSchema);
export const OrcaShowWorkerReceiptSchema = successReceiptSchema(OrcaWorkerShowResultSchema);
export const OrcaReadWorkerReceiptSchema = successReceiptSchema(OrcaWorkerReadResultSchema);
export const OrcaStopWorkerReceiptSchema = successReceiptSchema(OrcaWorkerStopResultSchema);
export const OrcaReleaseWorkerReceiptSchema = successReceiptSchema(OrcaWorkerReleaseResultSchema);

const operationReceiptSchemas = {
  list_projects: OrcaProjectListReceiptSchema,
  create_run: OrcaCreateRunReceiptSchema,
  create_task: OrcaCreateTaskReceiptSchema,
  dispatch_worker: OrcaStartWorkerReceiptSchema,
  show_worker: OrcaShowWorkerReceiptSchema,
  read_worker: OrcaReadWorkerReceiptSchema,
  stop_worker: OrcaStopWorkerReceiptSchema,
  release_worker: OrcaReleaseWorkerReceiptSchema
} as const;

export type OrcaReceiptOperationKind = keyof typeof operationReceiptSchemas;

export type OrcaReceipt = z.infer<typeof OrcaSuccessReceiptSchema>;
export type OrcaReceiptEnvelope = z.infer<typeof OrcaReceiptSchema>;
export type OrcaStatusReceipt = z.infer<typeof OrcaStatusReceiptSchema>;
export type OrcaSkillResponse = z.infer<typeof OrcaSkillResponseSchema>;
export type OrcaProject = Readonly<Pick<
  z.infer<typeof OrcaProjectSchema>,
  "id" | "path" | "displayName" | "kind"
>>;

export class OrcaInvalidReceiptError extends Error {
  readonly code = "invalid_orca_receipt";
  readonly retryable = false;

  constructor() {
    super("Orca returned an invalid JSON receipt");
    this.name = "OrcaInvalidReceiptError";
  }
}

export class OrcaCommandError extends Error {
  readonly code = "orca_command_failed";
  readonly retryable = false;
  readonly orcaCode?: string | undefined;

  constructor(orcaCode?: string) {
    super("Orca rejected the command");
    this.name = "OrcaCommandError";
    if (orcaCode !== undefined && /^[a-z0-9_]{1,80}$/.test(orcaCode)) {
      this.orcaCode = orcaCode;
    }
  }
}

export class OrcaStaleHandleError extends Error {
  readonly code = "orca_stale_handle";
  readonly retryable = false;

  constructor() {
    super("Orca rejected a stale runtime handle");
    this.name = "OrcaStaleHandleError";
  }
}

function invalidReceipt(): never {
  throw new OrcaInvalidReceiptError();
}

export function parseOrcaReceipt(value: unknown): OrcaReceiptEnvelope {
  const parsed = OrcaReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidReceipt();
}

export function parseOrcaOperationsReceipt(
  kind: OrcaOperationsReceiptKind,
  value: unknown
): OrcaOperationsReceipt {
  const parsed = operationsReceiptSchemas[kind].safeParse(value);
  return parsed.success ? parsed.data : invalidReceipt();
}

export function parseOrcaStatusReceipt(value: unknown): OrcaStatusReceipt {
  const parsed = OrcaStatusReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidReceipt();
}

export function parseOrcaSkillResponse(value: unknown): OrcaSkillResponse {
  const parsed = OrcaSkillResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidReceipt();
}

export function parseOrcaProjects(receipt: OrcaReceipt): readonly OrcaProject[] {
  const parsed = OrcaProjectListReceiptSchema.safeParse(receipt);
  if (!parsed.success) return invalidReceipt();
  return parsed.data.result.repos.map(({ id, path, displayName, kind }) => Object.freeze({
    id,
    path,
    displayName,
    kind
  }));
}

export function parseOrcaOperationReceipt(
  kind: OrcaReceiptOperationKind,
  receipt: OrcaReceipt
): OrcaReceipt {
  const parsed = operationReceiptSchemas[kind].safeParse(receipt);
  if (!parsed.success) return invalidReceipt();
  return parsed.data;
}

export function assertSuccessfulReceipt(
  receipt: OrcaReceiptEnvelope
): asserts receipt is OrcaReceipt {
  if (receipt.ok) return;
  const failure = "error" in receipt ? receipt.error : receipt.result;
  const orcaCode = failure.code;
  if (orcaCode === "terminal_handle_stale") throw new OrcaStaleHandleError();
  throw new OrcaCommandError(typeof orcaCode === "string" ? orcaCode : undefined);
}
