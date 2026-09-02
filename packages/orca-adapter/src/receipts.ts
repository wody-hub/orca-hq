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
