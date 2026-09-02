import {
  OutboundDeliveryReceiptSchema,
  OutboundMessageSchema,
  type OutboundMessageFor
} from "@orca-hq/core";
import { z } from "zod";

const TelegramTextPayloadSchema = z.object({
  text: z.string().min(1),
  replyToMessageId: z.number().int().optional()
}).passthrough();

const TelegramApprovalDeniedPayloadSchema = z.object({
  riskLevel: z.enum(["L2", "L3"])
}).strict();

export const TelegramOutboundMessageSchema = OutboundMessageSchema.extend({
  channel: z.literal("telegram")
}).strict();

export type TelegramOutboundMessage = OutboundMessageFor<"telegram">;

export type TelegramMessagePort = Readonly<{
  send(message: Readonly<{
    chatId: string;
    text: string;
    replyToMessageId?: number | undefined;
  }>): Promise<Readonly<{ messageId: number }>>;
}>;

export async function deliverTelegramMessage(
  input: TelegramOutboundMessage,
  messages: TelegramMessagePort
): Promise<Readonly<{ providerMessageId: string }>> {
  const message = TelegramOutboundMessageSchema.parse(input);
  const rendered = renderTelegramMessage(message.template, message.payload);
  const response = await messages.send({
    chatId: message.destination,
    text: rendered.text,
    ...(rendered.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: rendered.replyToMessageId })
  });
  return OutboundDeliveryReceiptSchema.parse({
    providerMessageId: String(z.number().int().parse(response.messageId))
  });
}

function renderTelegramMessage(
  template: string,
  payload: unknown
): Readonly<{ text: string; replyToMessageId?: number }> {
  if (template === "approval_channel_not_allowed") {
    const denied = TelegramApprovalDeniedPayloadSchema.parse(payload);
    return {
      text: `Telegram에서는 ${denied.riskLevel} 승인을 처리할 수 없습니다. Slack HQ에서 승인해 주세요.`
    };
  }
  const text = TelegramTextPayloadSchema.parse(payload);
  return {
    text: text.text,
    ...(text.replyToMessageId === undefined ? {} : { replyToMessageId: text.replyToMessageId })
  };
}
