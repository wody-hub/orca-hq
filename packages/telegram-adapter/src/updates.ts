import { randomUUID } from "node:crypto";

import { deriveIdempotencyKey, type CommandEnvelope, type RiskLevel } from "@orca-hq/core";
import { z } from "zod";

const IdentifierSchema = z.union([z.string().min(1), z.number().int()]);

export const TelegramTextMessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int().nonnegative(),
  from: z.object({ id: IdentifierSchema }).passthrough(),
  chat: z.object({ id: IdentifierSchema }).passthrough(),
  text: z.string().min(1)
}).passthrough();

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
export type TelegramApprovalCallback = z.infer<typeof TelegramApprovalCallbackSchema>;

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

export function callbackRiskLevel(data: string): RiskLevel | undefined {
  const match = /^approval:(L[0-3])$/.exec(data);
  return match?.[1] as RiskLevel | undefined;
}
