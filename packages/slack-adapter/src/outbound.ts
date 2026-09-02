import { z } from "zod";

export const SlackOutboundMessageSchema = z.object({
  id: z.string().min(1),
  destination: z.string().min(1),
  text: z.string().min(1),
  threadId: z.string().min(1)
}).strict();

export type SlackOutboundMessage = z.infer<typeof SlackOutboundMessageSchema>;

export type SlackMessagePort = Readonly<{
  send(message: Readonly<{ channel: string; text: string; threadTs: string }>): Promise<Readonly<{ ts: string }>>;
}>;

export type SlackDeliveryReceipt = Readonly<{ providerMessageId: string }>;

/** A provider delivery port. Persistent Outbox state transitions belong to the shared dispatcher. */
export async function deliverSlackMessage(
  messageInput: SlackOutboundMessage,
  messages: SlackMessagePort
): Promise<SlackDeliveryReceipt> {
  const message = SlackOutboundMessageSchema.parse(messageInput);
  const response = await messages.send({
    channel: message.destination,
    text: message.text,
    threadTs: message.threadId
  });
  return { providerMessageId: z.string().min(1).parse(response.ts) };
}
