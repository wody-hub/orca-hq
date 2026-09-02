import {
  CommandEnvelopeSchema,
  ExecutionProposalSchema,
  RouteCandidateSchema,
  type CommandEnvelope,
  type ExecutionProposal
} from "@orca-hq/core";
import { z } from "zod";

export const CODEX_HQ_PROTOCOL_VERSION = 1 as const;
export const CODEX_HQ_MODEL = "gpt-5.6-sol" as const;
export const CODEX_TERRA_MODEL = "gpt-5.6-terra" as const;

export const HqModelConfigurationSchema = z.object({
  authorityModel: z.literal(CODEX_HQ_MODEL),
  assistantModel: z.literal(CODEX_TERRA_MODEL).optional()
}).strict();

export type HqModelConfiguration = z.infer<typeof HqModelConfigurationSchema>;

export const ClarificationSchema = z.object({
  commandId: z.string().min(1),
  question: z.string().trim().min(1),
  candidates: z.array(RouteCandidateSchema).max(3).optional()
}).strict();

export type Clarification = z.infer<typeof ClarificationSchema>;

export const PolicyPreviewResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("auto"),
    approvalId: z.string().min(1).optional()
  }).strict(),
  z.object({
    kind: z.literal("approval_required"),
    reason: z.enum(["missing", "changed", "expired", "invalid"])
  }).strict(),
  z.object({
    kind: z.literal("rejected"),
    reason: z.enum([
      "invalid_context",
      "invalid_proposal",
      "project_operation_not_allowed",
      "risk_mismatch",
      "role_not_allowed",
      "channel_not_allowed"
    ])
  }).strict()
]);

export type PolicyPreviewResult = z.infer<typeof PolicyPreviewResultSchema>;

export const HqFailureReasonSchema = z.enum([
  "invalid_command",
  "duplicate_command",
  "invalid_model_authority",
  "invalid_model_event",
  "invalid_model_output",
  "missing_terminal_result",
  "multiple_terminal_results",
  "invalid_project_route",
  "invalid_registry_response",
  "registry_unavailable",
  "policy_rejected",
  "invalid_policy_response",
  "policy_unavailable",
  "codex_runtime_failed",
  "queue_unavailable"
]);

export const HqResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("proposal"),
    proposal: ExecutionProposalSchema
  }).strict(),
  z.object({
    kind: z.literal("clarification"),
    clarification: ClarificationSchema
  }).strict(),
  z.object({
    kind: z.literal("failure"),
    reason: HqFailureReasonSchema
  }).strict(),
  z.object({
    kind: z.literal("degraded"),
    reason: z.literal("codex_unavailable")
  }).strict()
]);

export type HqFailureReason = z.infer<typeof HqFailureReasonSchema>;
export type HqResult = z.infer<typeof HqResultSchema>;

export const HqQueueClaimSchema = z.object({
  claimToken: z.string().min(1),
  command: z.unknown()
}).strict();

export const HqQueueTerminalRecordSchema = z.object({
  claimToken: z.string().min(1),
  commandId: z.string().min(1),
  result: HqResultSchema
}).strict();

export type HqQueueClaim = z.infer<typeof HqQueueClaimSchema>;
export type HqQueueTerminalRecord = z.infer<typeof HqQueueTerminalRecordSchema>;

export const HQ_TOOL_NAMES = Object.freeze([
  "searchProjects",
  "inspectProject",
  "previewPolicy",
  "submitProposal",
  "askClarification"
] as const);

export const HqToolNameSchema = z.enum(HQ_TOOL_NAMES);
export type HqToolName = z.infer<typeof HqToolNameSchema>;

export const CodexEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_call"),
    model: z.literal(CODEX_HQ_MODEL),
    callId: z.string().min(1),
    tool: HqToolNameSchema,
    input: z.unknown()
  }).strict(),
  z.object({
    type: z.literal("failure"),
    model: z.literal(CODEX_HQ_MODEL),
    reason: z.enum([
      "authentication_required",
      "quota_unavailable",
      "runtime_unavailable",
      "process_failed"
    ])
  }).strict()
]);

export type CodexEvent = z.infer<typeof CodexEventSchema>;

export const CodexToolResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    callId: z.string().min(1),
    ok: z.literal(true),
    output: z.unknown()
  }).strict(),
  z.object({
    callId: z.string().min(1),
    ok: z.literal(false),
    error: z.object({
      code: z.enum(["invalid_tool_input", "invalid_tool_result", "tool_failed"])
    }).strict()
  }).strict()
]);

export type CodexToolResponse = z.infer<typeof CodexToolResponseSchema>;

export const TerraAssistanceSchema = z.object({
  model: z.literal(CODEX_TERRA_MODEL),
  labels: z.array(z.string().trim().min(1)).max(10),
  summary: z.string().trim().min(1)
}).strict();

export type TerraAssistance = z.infer<typeof TerraAssistanceSchema>;

export interface TerraAssistanceRequest {
  readonly model: typeof CODEX_TERRA_MODEL;
  readonly text: string;
}

export interface TerraAssistancePort {
  assist(request: TerraAssistanceRequest): Promise<unknown>;
}

export interface CodexTurnRequest {
  readonly protocol: typeof CODEX_HQ_PROTOCOL_VERSION;
  readonly model: typeof CODEX_HQ_MODEL;
  readonly command: CommandEnvelope;
  readonly tools: readonly HqToolName[];
  readonly assistance?: TerraAssistance | undefined;
}

export interface CodexCliTurn {
  readonly events: AsyncIterable<unknown>;
  respond(response: CodexToolResponse): Promise<void>;
  close(): Promise<void>;
}

export interface CodexCliPort {
  openTurn(request: CodexTurnRequest): Promise<CodexCliTurn>;
}

export const CodexPortErrorCodeSchema = z.enum([
  "authentication_required",
  "quota_unavailable",
  "runtime_unavailable",
  "process_failed"
]);

export type CodexPortErrorCode = z.infer<typeof CodexPortErrorCodeSchema>;

export class CodexPortError extends Error {
  override readonly name = "CodexPortError";
  readonly code: CodexPortErrorCode;

  constructor(code: CodexPortErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface OrderedCommandQueuePort {
  /** Atomically persists commands in invocation order. */
  enqueue(command: CommandEnvelope): Promise<void>;
  /** Reserves the FIFO head under a stable token until a terminal record is persisted. */
  claimNext(): Promise<unknown | undefined>;
  /** Idempotently records this exact result by claim token and removes the current claim. */
  complete(record: HqQueueTerminalRecord): Promise<void>;
  /** Idempotently records this exact degraded result and retains recovery FIFO order. */
  defer(record: HqQueueTerminalRecord): Promise<void>;
}

export interface RegistryQueryPort {
  searchProjects(input: Readonly<{ query: string; limit?: number | undefined }>): Promise<unknown>;
  inspectProject(input: Readonly<{ projectKey: string }>): Promise<unknown>;
}

export interface PolicyPreviewPort {
  previewPolicy(input: Readonly<{
    command: CommandEnvelope;
    proposal: ExecutionProposal;
  }>): Promise<unknown>;
}

// Kept as a runtime boundary for durable queue adapters implemented outside this package.
export const QueuedCommandSchema = CommandEnvelopeSchema;
