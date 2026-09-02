import { randomUUID } from "node:crypto";

import {
  deriveIdempotencyKey,
  type CommandEnvelope,
  type IdentityResolver,
  type RiskLevel
} from "@orca-hq/core";
import { z } from "zod";

const IdentifierSchema = z.union([z.string().min(1), z.number().int()]);

export const TelegramTextMessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int().nonnegative(),
  from: z.object({ id: IdentifierSchema }).passthrough(),
  chat: z.object({ id: IdentifierSchema }).passthrough(),
  text: z.string().min(1)
}).passthrough();

export const TelegramVoiceMessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int().nonnegative(),
  from: z.object({ id: IdentifierSchema }).passthrough(),
  chat: z.object({ id: IdentifierSchema }).passthrough(),
  voice: z.object({
    file_id: z.string().min(1),
    file_unique_id: z.string().min(1),
    duration: z.number().int().nonnegative()
  }).passthrough()
}).passthrough();

const VoiceTranscriptSchema = z.object({
  text: z.string().min(1),
  provider: z.enum(["openai", "local-whisper"]),
  sourceFileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  confidence: z.number().min(0).max(1).optional()
}).strict();

export const TelegramApprovalCallbackSchema = z.object({
  id: z.string().min(1),
  from: z.object({ id: IdentifierSchema }).passthrough(),
  message: z.object({
    message_id: z.number().int(),
    chat: z.object({ id: IdentifierSchema }).passthrough()
  }).passthrough(),
  data: z.string().min(1)
}).passthrough();

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.unknown().optional(),
  callback_query: z.unknown().optional()
}).passthrough();

export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;
export type TelegramTextMessage = z.infer<typeof TelegramTextMessageSchema>;
export type TelegramVoiceMessage = z.infer<typeof TelegramVoiceMessageSchema>;
export type TelegramApprovalCallback = z.infer<typeof TelegramApprovalCallbackSchema>;

export type VoiceCommandResult =
  | Readonly<{ kind: "command"; command: CommandEnvelope }>
  | Readonly<{ kind: "confirmation_required"; confirmationText: string }>;

export function telegramIdentifier(value: string | number): string {
  return String(value);
}

export function toTelegramCommand(
  update: Readonly<{ message: TelegramTextMessage }>,
  principalId: string,
  botIdentity: string
): CommandEnvelope {
  const chatId = telegramIdentifier(update.message.chat.id);
  const messageId = String(update.message.message_id);
  return {
    commandId: randomUUID(),
    idempotencyKey: deriveIdempotencyKey(`telegram:${botIdentity}:${chatId}`, messageId),
    channel: "telegram",
    externalMessageId: `${chatId}:${messageId}`,
    externalThreadId: messageId,
    principalId,
    receivedAt: new Date(update.message.date * 1_000).toISOString(),
    text: update.message.text
  };
}

/**
 * Normalizes a transcribed Telegram voice message without retaining provider media metadata.
 * Low-confidence text is returned only for an explicit user confirmation, never as a Command.
 */
export function toTelegramVoiceCommand(
  update: Readonly<{ message: TelegramVoiceMessage }>,
  identities: IdentityResolver,
  botIdentity: string,
  transcriptInput: unknown
): VoiceCommandResult | undefined {
  const transcript = VoiceTranscriptSchema.safeParse(transcriptInput);
  if (!transcript.success) return undefined;

  const userId = telegramIdentifier(update.message.from.id);
  const chatId = telegramIdentifier(update.message.chat.id);
  const identity = identities.resolve("telegram", userId, chatId);
  if ("kind" in identity) return undefined;

  const text = transcript.data.text.trim();
  if (text.length === 0) return undefined;
  if (transcript.data.confidence !== undefined && transcript.data.confidence < 0.8) {
    return { kind: "confirmation_required", confirmationText: text };
  }

  const messageId = String(update.message.message_id);
  return {
    kind: "command",
    command: {
      commandId: randomUUID(),
      idempotencyKey: deriveIdempotencyKey(`telegram:${botIdentity}:${chatId}`, messageId),
      channel: "telegram",
      externalMessageId: `${chatId}:${messageId}`,
      externalThreadId: messageId,
      principalId: identity.principalId,
      receivedAt: new Date(update.message.date * 1_000).toISOString(),
      text,
      transcript: {
        provider: transcript.data.provider,
        sourceFileSha256: transcript.data.sourceFileSha256,
        ...(transcript.data.confidence === undefined ? {} : { confidence: transcript.data.confidence })
      }
    }
  };
}

export function callbackRiskLevel(data: string): RiskLevel | undefined {
  const match = /^approval:(L[0-3])$/.exec(data);
  return match?.[1] as RiskLevel | undefined;
}
