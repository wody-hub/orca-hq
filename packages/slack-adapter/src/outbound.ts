import {
  InvalidOutboundMessageError,
  OutboundDeliveryReceiptSchema,
  OutboundMessageSchema,
  type OutboundMessageFor
} from "@orca-hq/core";
import { z } from "zod";

const SlackPayloadSchema = z.object({
  text: z.string().min(1),
  threadId: z.string().min(1).optional()
}).passthrough();

export const SlackOutboundMessageSchema = OutboundMessageSchema.extend({
  channel: z.literal("slack"),
  payload: SlackPayloadSchema
}).strict().superRefine((message, context) => {
  const isHqMirror = message.template === "final_summary" && message.id.endsWith(":slack-hq");
  if (!isHqMirror && message.payload.threadId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", "threadId"],
      message: "originating Slack thread is required"
    });
  }
});

export type SlackOutboundMessage = OutboundMessageFor<"slack">;

export type SlackMessagePort = Readonly<{
  send(message: Readonly<{
    channel: string;
    text: string;
    threadTs?: string | undefined;
  }>): Promise<Readonly<{ ts: string }>>;
}>;

export type SlackDeliveryReceipt = Readonly<{ providerMessageId: string }>;

/** A provider delivery port. Persistent Outbox state transitions belong to the shared dispatcher. */
export async function deliverSlackMessage(
  messageInput: SlackOutboundMessage,
  messages: SlackMessagePort
): Promise<SlackDeliveryReceipt> {
  const parsed = SlackOutboundMessageSchema.safeParse(messageInput);
  if (!parsed.success) throw new InvalidOutboundMessageError();
  const message = parsed.data;
  const response = await messages.send({
    channel: message.destination,
    text: message.payload.text,
    ...(message.payload.threadId === undefined ? {} : { threadTs: message.payload.threadId })
  });
  return OutboundDeliveryReceiptSchema.parse({ providerMessageId: response.ts });
}
