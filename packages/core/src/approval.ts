import { z } from "zod";
import { ChannelSchema } from "./command.js";
import { PrincipalBindingSchema } from "./identity.js";
import { ExecutionProposalSchema } from "./proposal.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ApprovalRecordSchema = z.object({
  approvalId: z.string().min(1),
  proposalDigest: Sha256Schema,
  operationDigest: Sha256Schema,
  principalId: z.string().min(1),
  channel: ChannelSchema,
  approvedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  typedPhraseDigest: Sha256Schema.optional()
}).strict();

export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const ApprovalRequestInputSchema = z.object({
  approvalId: z.string().min(1),
  proposal: ExecutionProposalSchema,
  operation: z.string().min(1),
  commandDigest: Sha256Schema,
  diffSha256: Sha256Schema.optional(),
  targetEnvironment: z.string().min(1).optional(),
  channel: ChannelSchema,
  allowedChannels: z.array(ChannelSchema)
}).strict();

export const ApprovalValidationInputSchema = z.object({
  proposal: ExecutionProposalSchema,
  operation: z.string().min(1),
  commandDigest: Sha256Schema,
  diffSha256: Sha256Schema.optional(),
  targetEnvironment: z.string().min(1).optional()
}).strict();

export const ApprovalRequestSchema = ApprovalRequestInputSchema.extend({
  proposalDigest: Sha256Schema,
  digest: Sha256Schema,
  riskLevel: z.enum(["L2", "L3"]),
  operationPhrase: z.string().min(1).optional(),
  typedPhraseDigest: Sha256Schema.optional()
}).strict();

export const PersistedApprovalSchema = z.object({
  approval: ApprovalRecordSchema,
  state: z.enum(["approved", "consumed", "invalidated"])
}).strict();

export const ApprovalConfirmationSchema = ApprovalRecordSchema.extend({
  executionProposalId: z.string().min(1)
}).strict();

export type ApprovalRequestInput = z.infer<typeof ApprovalRequestInputSchema>;
export type ApprovalValidationInput = z.infer<typeof ApprovalValidationInputSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type PersistedApproval = z.infer<typeof PersistedApprovalSchema>;
export type ApprovalConfirmation = z.infer<typeof ApprovalConfirmationSchema>;

export type ApprovalDecision =
  | Readonly<{ kind: "approved"; id?: string }>
  | Readonly<{
      kind: "denied";
      reason: "channel_not_allowed" | "role" | "phrase_mismatch" | "not_found" | "replayed";
    }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "changed" }>;

export interface ApprovalStore {
  confirmApproval(approval: ApprovalConfirmation): ApprovalRecord;
  findApproval(approvalId: string): PersistedApproval | undefined;
  consumeApproval(approvalId: string): boolean;
  invalidateApproval(approvalId: string, reason: "digest_changed" | "manual"): boolean;
}

export type ApprovalPrincipal = z.infer<typeof PrincipalBindingSchema>;
