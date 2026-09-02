import { z } from "zod";

export const TelegramOutboundMessageSchema = z.object({
  id: z.string().min(1),
  destination: z.string().min(1),
  text: z.string().min(1),
  replyToMessageId: z.number().int().optional()
}).strict();

export type TelegramOutboundMessage = z.infer<typeof TelegramOutboundMessageSchema>;

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
  const response = await messages.send({
    chatId: message.destination,
    text: message.text,
    ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId })
  });
  return { providerMessageId: String(z.number().int().parse(response.messageId)) };
}
