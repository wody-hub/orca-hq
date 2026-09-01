import { z } from "zod";

export const ChannelSchema = z.enum(["slack", "telegram", "tailscale-web"]);

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const CommandEnvelopeSchema = z.object({
  commandId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  channel: ChannelSchema,
  externalMessageId: z.string().min(1),
  externalThreadId: z.string().min(1).optional(),
  principalId: z.string().min(1),
  receivedAt: z.string().datetime(),
  text: z.string().min(1),
  attachments: z.array(z.object({
    provider: z.literal("slack"),
    providerFileId: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    contentSha256: Sha256Schema.optional()
  }).strict()).max(10).optional(),
  transcript: z.object({
    provider: z.enum(["openai", "local-whisper"]),
    sourceFileSha256: Sha256Schema,
    confidence: z.number().min(0).max(1).optional()
  }).optional()
}).strict();

export type Channel = z.infer<typeof ChannelSchema>;
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
