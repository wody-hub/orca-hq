import { z } from "zod";
import { ChannelSchema } from "./command.js";

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
