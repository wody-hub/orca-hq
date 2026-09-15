import { z } from "zod";

import {
  ContextSnapshotSchema,
  ProgressEventKindSchema,
  ProgressEventPayloadSchema,
  ProgressEventSourceSchema
} from "./progress.js";
import { redactPublicText, sanitizeDisplayText } from "./public-output.js";

const Id = z.string().trim().min(1).max(512);
const DisplayText = z.string().max(64 * 1024).transform(sanitizeDisplayText);
const PublicText = z.string().max(64 * 1024).transform(redactPublicText);
const IsoDate = z.string().datetime();
const Cursor = z.string().trim().min(1).max(2048);
const ReceiptLinkSchema = z.object({
  runId: Id,
  taskId: Id,
  dispatchId: Id,
  terminalHandle: Id
}).strict();

export const EvidenceSchema = z.object({
  source: z.enum(["hq_api", "hq_store", "orca_cli"]),
  command: PublicText.pipe(z.string().max(512)).optional(),
  observedAt: IsoDate,
  verification: z.enum(["authoritative", "observed", "unverifiable"])
}).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const SupportSchema = z.discriminatedUnion("supported", [
  z.object({ supported: z.literal(true) }).strict(),
  z.object({ supported: z.literal(false), reason: DisplayText.pipe(z.string().min(1).max(256)) }).strict()
]);
export type Support = z.infer<typeof SupportSchema>;

export const OperationsStatusSchema = z.object({
  collectedAt: IsoDate,
  hq: z.object({
    state: z.string().min(1),
    capacity: z.object({
      limit: z.union([z.number().int().positive(), z.literal("unlimited")]),
      source: z.enum(["config", "environment", "default"]),
      active: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative(),
      byState: z.record(z.number().int().nonnegative()),
      updateSupported: z.literal(false),
      reason: DisplayText.pipe(z.string().min(1))
    }).strict()
  }).strict(),
  orca: z.object({
    state: z.string().min(1),
    reachable: z.boolean(),
    connectionState: z.string().min(1).optional(),
    version: z.string().min(1),
    runtimeId: Id.optional(),
    features: z.record(z.unknown())
  }).strict(),
  metrics: z.object({
    tokens: z.object({ available: z.literal(false), reason: z.literal("not_collected") }).strict(),
    cost: z.object({ available: z.literal(false), reason: z.literal("not_collected") }).strict()
  }).strict()
}).strict();
export type OperationsStatus = z.infer<typeof OperationsStatusSchema>;

const HqEventSchema = z.object({
  source: z.literal("hq"),
  eventSource: ProgressEventSourceSchema,
  seq: z.number().int().positive(),
  eventKey: Id,
  requestId: Id,
  contextId: Id.nullable(),
  kind: ProgressEventKindSchema,
  occurredAt: IsoDate,
  payload: ProgressEventPayloadSchema,
  agentId: Id.optional(),
  generation: z.number().int().positive().optional(),
  receiptLink: ReceiptLinkSchema.optional()
}).strict().superRefine((event, context) => {
  if (event.receiptLink !== undefined && event.kind !== "worker.ready" && event.kind !== "worker.retained") {
    context.addIssue({ code: "custom", path: ["receiptLink"], message: "receipt_link_kind_invalid" });
  }
});

const PublicContextSnapshotSchema = ContextSnapshotSchema.extend({
  title: PublicText,
  summary: PublicText
}).strict();

export const HqContextPageSchema = z.object({
  contexts: z.array(PublicContextSnapshotSchema).max(100),
  cursor: Cursor.optional(),
  compacted: z.boolean().optional()
}).strict();
export const HqEventPageSchema = z.object({
  events: z.array(HqEventSchema).max(500),
  snapshots: z.array(PublicContextSnapshotSchema).max(100),
  cursor: Cursor.optional(),
  compacted: z.boolean(),
  oldestSeq: z.number().int().nonnegative(),
  latestSeq: z.number().int().nonnegative()
}).strict();
export type HqContextPage = z.infer<typeof HqContextPageSchema>;
export type HqEventPage = z.infer<typeof HqEventPageSchema>;

export const HqQuestionSchema = z.object({
  source: z.literal("hq"),
  kind: z.enum(["router_clarification", "managed_orca_question"]),
  requestId: Id,
  sessionId: Id,
  contextId: Id.optional(),
  messageId: Id.optional(),
  body: PublicText,
  occurredAt: IsoDate,
  state: z.string().min(1),
  evidence: EvidenceSchema
}).strict();
export type HqQuestion = z.infer<typeof HqQuestionSchema>;

const OrcaPageBase = z.object({ cursor: Cursor.optional(), warnings: z.array(PublicText).max(100).default([]) });
export const OrcaRunPageSchema = OrcaPageBase.extend({
  runs: z.array(z.object({ id: Id, status: z.string().min(1) }).passthrough()).max(100)
}).strict();
export const OrcaTaskPageSchema = OrcaPageBase.extend({
  tasks: z.array(z.object({ id: Id, runId: Id, status: z.string().min(1) }).passthrough()).max(100)
}).strict();
export const OrcaWorkerPageSchema = OrcaPageBase.extend({
  workers: z.array(z.object({ dispatchId: Id, taskId: Id.optional(), runId: Id.optional(), status: z.string().min(1) }).passthrough()).max(100)
}).strict();
export const OrcaWorkerDetailSchema = z.object({
  dispatchId: Id,
  projection: z.object({ liveness: z.object({ verdict: z.string().min(1) }).passthrough() }).passthrough(),
  observation: z.object({ status: z.string().min(1), exactWorker: z.boolean() }).passthrough(),
  terminal: z.object({ connected: z.boolean().optional(), writable: z.boolean().optional(), incarnation: Id.optional() }).passthrough().nullable(),
  outcome: z.unknown().optional(),
  resourceSettlement: z.unknown().optional()
}).passthrough();

const OrcaOutputBase = {
  cursor: Cursor.optional(),
  archived: z.boolean(),
  warnings: z.array(PublicText).max(100)
};
export const OrcaOutputPageSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("transcript"),
    ...OrcaOutputBase,
    messages: z.array(z.object({ id: Id, role: z.string().min(1), text: PublicText, occurredAt: IsoDate.optional() }).strict()).max(500)
  }).strict(),
  z.object({ source: z.literal("terminal"), ...OrcaOutputBase, lines: z.array(PublicText).max(500) }).strict()
]);
export const OrcaQuestionSchema = z.object({
  source: z.literal("orca"),
  messageId: Id,
  runId: Id.optional(),
  taskId: Id.optional(),
  dispatchId: Id.optional(),
  terminalHandle: Id.optional(),
  body: PublicText,
  occurredAt: IsoDate.optional(),
  state: z.literal("pending"),
  evidence: EvidenceSchema
}).strict();
export const OrcaResourceInventorySchema = z.object({
  projects: z.array(z.object({
    id: Id,
    hostScope: z.enum(["covered", "not_covered"]),
    setups: z.array(z.object({
      id: Id,
      worktrees: z.array(z.object({
        id: Id,
        terminals: z.array(z.object({ id: Id }).passthrough()).max(100)
      }).passthrough()).max(100)
    }).passthrough()).max(100)
  }).passthrough()).max(100)
}).strict();
export const OperationsMutationReceiptSchema = z.object({
  requestId: Id,
  action: z.string().min(1),
  targetId: Id,
  state: z.enum(["accepted", "rejected", "unknown"]),
  observedAt: IsoDate,
  detail: PublicText.pipe(z.string().max(1024)).optional()
}).strict();

export type OrcaRunPage = z.infer<typeof OrcaRunPageSchema>;
export type OrcaTaskPage = z.infer<typeof OrcaTaskPageSchema>;
export type OrcaWorkerPage = z.infer<typeof OrcaWorkerPageSchema>;
export type OrcaWorkerDetail = z.infer<typeof OrcaWorkerDetailSchema>;
export type OrcaOutputPage = z.infer<typeof OrcaOutputPageSchema>;
export type OrcaQuestion = z.infer<typeof OrcaQuestionSchema>;
export type OrcaResourceInventory = z.infer<typeof OrcaResourceInventorySchema>;
export type OperationsMutationReceipt = z.infer<typeof OperationsMutationReceiptSchema>;
