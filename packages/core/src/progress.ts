import { z } from "zod";

import { ChannelMessageJsonSchema } from "./channel-message.js";

const ProgressIdSchema = z.string().trim().min(1).max(100);
const ProgressEventKeySchema = z.string().trim().min(1).max(512);

export const ContextHintSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new") }).strict(),
  z.object({ mode: z.literal("continue"), contextId: ProgressIdSchema }).strict()
]);

export const SubmitProgressRequestSchema = z.object({
  requestId: ProgressIdSchema,
  sessionId: ProgressIdSchema,
  text: z.string().min(1).max(64 * 1024),
  contextHint: ContextHintSchema.optional()
}).strict();

export const ContextChoiceSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("new"),
    title: z.string().trim().min(1).max(256),
    objective: z.string().trim().min(1).max(8 * 1024),
    projectIds: z.array(ProgressIdSchema).max(64),
    sourceContextId: ProgressIdSchema.optional()
  }).strict(),
  z.object({
    action: z.literal("continue"),
    contextId: ProgressIdSchema
  }).strict(),
  z.object({
    action: z.literal("clarify"),
    question: z.string().trim().min(1).max(8 * 1024),
    candidateIds: z.array(ProgressIdSchema).max(20)
  }).strict()
]);

export const ProgressRequestStateSchema = z.enum([
  "queued",
  "classifying",
  "awaiting_input",
  "executing",
  "completed",
  "failed",
  "recovery_required"
]);

export const ProgressRequestResultSchema = z.object({
  text: z.string().max(64 * 1024),
  jobId: ProgressIdSchema.optional()
}).strict();

export const ProgressRequestSnapshotSchema = z.object({
  requestId: ProgressIdSchema,
  sessionId: ProgressIdSchema,
  state: ProgressRequestStateSchema,
  contextIds: z.array(ProgressIdSchema),
  result: ProgressRequestResultSchema.optional()
}).strict();

export const ProgressEventKindSchema = z.enum([
  "request.accepted",
  "request.queued",
  "context.assigned",
  "agent.started",
  "agent.resumed",
  "agent.waiting",
  "worker.launching",
  "worker.ready",
  "worker.retained",
  "worker.recovery_required",
  "clarification.required",
  "hq.progress",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "job.linked",
  "job.state",
  "request.completed",
  "request.failed",
  "recovery.required",
  "history.compacted"
]);

export const ProgressEventSourceSchema = z.enum(["hq", "tool", "orca", "system"]);

export const ProgressEventPayloadSchema = z.record(z.string(), ChannelMessageJsonSchema);

const NativeLaunchProfilePayloadSchema = z.object({
  agent: z.enum(["codex", "claude"]),
  model: z.string().trim().min(1).max(256),
  effort: z.string().trim().min(1).max(64).optional(),
  reason: z.string().trim().min(1).max(2 * 1024)
});

const NativeEventIdSchema = z.string().trim().min(1).max(512);

const NativeLaunchingPayloadSchema = z.object({
  attemptId: NativeEventIdSchema,
  worktreeId: NativeEventIdSchema,
  requested: NativeLaunchProfilePayloadSchema
});

const NativeEffectivePayloadSchema = z.object({
  agent: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256).optional(),
  effort: z.string().trim().min(1).max(64).optional()
});

const NativeReceiptPayloadSchema = NativeLaunchingPayloadSchema.extend({
  runId: NativeEventIdSchema,
  taskId: NativeEventIdSchema,
  dispatchId: NativeEventIdSchema,
  terminalHandle: NativeEventIdSchema,
  effective: NativeEffectivePayloadSchema
});

const NativeObservedPayloadSchema = NativeLaunchingPayloadSchema.extend({
  runId: NativeEventIdSchema.optional(),
  taskId: NativeEventIdSchema.optional(),
  dispatchId: NativeEventIdSchema.optional(),
  terminalHandle: NativeEventIdSchema.optional(),
  effective: NativeEffectivePayloadSchema.optional()
});

const ProgressEventBaseSchema = z.object({
  seq: z.number().int().positive(),
  eventKey: ProgressEventKeySchema,
  requestId: ProgressIdSchema,
  contextId: ProgressIdSchema.nullable(),
  kind: ProgressEventKindSchema,
  source: ProgressEventSourceSchema,
  occurredAt: z.string().datetime(),
  payload: ProgressEventPayloadSchema,
  agentId: ProgressIdSchema.optional(),
  generation: z.number().int().positive().optional()
}).strict();

function validateNativeWorkerEvent(
  event: Pick<z.infer<typeof ProgressEventBaseSchema>,
    "contextId" | "generation" | "kind" | "payload">,
  ctx: z.RefinementCtx
): void {
  if (!event.kind.startsWith("worker.")) return;
  let valid = event.contextId !== null && event.generation !== undefined;
  if (event.kind === "worker.ready" || event.kind === "worker.retained") {
    valid = valid && NativeReceiptPayloadSchema.safeParse(event.payload).success;
  } else {
    valid = valid && NativeObservedPayloadSchema.safeParse(event.payload).success;
  }
  if (!valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "native_worker_identity_required",
      path: ["payload"]
    });
  }
}

export const ProgressEventInputSchema = ProgressEventBaseSchema
  .omit({ seq: true })
  .superRefine(validateNativeWorkerEvent);

export const ProgressEventSchema = ProgressEventBaseSchema
  .superRefine(validateNativeWorkerEvent);

export const ContextSnapshotSchema = z.object({
  contextId: ProgressIdSchema,
  title: z.string().min(1).max(256),
  state: z.string().min(1).max(64),
  summary: z.string().max(64 * 1024),
  projectIds: z.array(ProgressIdSchema),
  jobIds: z.array(ProgressIdSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastSeq: z.number().int().nonnegative()
}).strict();

export const ResourceAccessSchema = z.object({
  resourceKey: z.string().trim().min(1).max(4 * 1024),
  mode: z.enum(["read", "write"])
}).strict();

export const ContextExecutionSchema = z.object({
  contextId: ProgressIdSchema,
  requestId: ProgressIdSchema,
  agentId: ProgressIdSchema,
  generation: z.number().int().positive(),
  resources: z.array(ResourceAccessSchema).min(1).max(128)
}).strict();

export const ViewerLeaseRequestSchema = z.object({
  viewerInstanceId: ProgressIdSchema
}).strict();

export const ViewerLeaseMutationSchema = ViewerLeaseRequestSchema.extend({
  leaseToken: z.string().min(32).max(1024)
}).strict();

export type ContextHint = z.infer<typeof ContextHintSchema>;
export type SubmitProgressRequest = z.infer<typeof SubmitProgressRequestSchema>;
export type ContextChoice = z.infer<typeof ContextChoiceSchema>;
export type ProgressRequestState = z.infer<typeof ProgressRequestStateSchema>;
export type ProgressRequestResult = z.infer<typeof ProgressRequestResultSchema>;
export type ProgressRequestSnapshot = z.infer<typeof ProgressRequestSnapshotSchema>;
export type ProgressEventKind = z.infer<typeof ProgressEventKindSchema>;
export type ProgressEventSource = z.infer<typeof ProgressEventSourceSchema>;
export type ProgressEventPayload = z.infer<typeof ProgressEventPayloadSchema>;
export type ProgressEventInput = z.infer<typeof ProgressEventInputSchema>;
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export type ResourceAccess = z.infer<typeof ResourceAccessSchema>;
export type ContextExecution = z.infer<typeof ContextExecutionSchema>;
export type ViewerLeaseRequest = z.infer<typeof ViewerLeaseRequestSchema>;
export type ViewerLeaseMutation = z.infer<typeof ViewerLeaseMutationSchema>;
