import { Readable } from "node:stream";

import type { CommandIngress, IdentityResolver } from "@orca-hq/core";
import { decideTranscript, type VoiceCommandTranscriber } from "@orca-hq/voice";
import { z } from "zod";

import {
  callbackRiskLevel,
  TelegramApprovalCallbackSchema,
  TelegramTextMessageSchema,
  TelegramUpdateSchema,
  TelegramVoiceMessageSchema,
  telegramIdentifier,
  toTelegramCommand,
  toTelegramVoiceCommand,
  type TelegramApprovalCallback
} from "./updates.js";
import {
  deliverTelegramMessage,
  type TelegramMessagePort,
  type TelegramOutboundMessage
} from "./outbound.js";

export * from "./outbound.js";
export * from "./polling.js";
export * from "./updates.js";

export type TelegramCursorStore = Readonly<{
  load(channel: "telegram"): Promise<number | undefined>;
  save(channel: "telegram", offset: number): Promise<void>;
}>;

export type TelegramOutbox = Readonly<{
  enqueue(message: Readonly<{
    id: string;
    channel: "telegram";
    destination: string;
    template: "approval_channel_not_allowed";
    payload: Readonly<{ riskLevel: "L2" | "L3" }>;
  }>): Promise<void>;
}>;

export type TelegramApprovalPort = Readonly<{
  request(request: Readonly<{
    channel: "telegram";
    callbackId: string;
    principalId: string;
    chatId: string;
    messageId: number;
    riskLevel: "L0" | "L1";
    trusted: false;
  }>): Promise<void>;
}>;

export type TelegramVoicePorts = Readonly<{
  /** Downloads by opaque file ID; no provider URLs are exposed to command construction. */
  media: Readonly<{
    download(fileId: string): AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;
  }>;
  transcriber: VoiceCommandTranscriber;
  confirmations: Readonly<{
    request(request: Readonly<{
      channel: "telegram";
      principalId: string;
      chatId: string;
      messageId: number;
      confirmationText: string;
      trusted: false;
    }>): Promise<void>;
  }>;
}>;

export type TelegramAdapterConfig = Readonly<{ botIdentity: string }>;
export type TelegramAdapterPorts = Readonly<{
  ingress: CommandIngress;
  identities: IdentityResolver;
  cursorStore: TelegramCursorStore;
  outbox: TelegramOutbox;
  approvalPort: TelegramApprovalPort;
  messages?: TelegramMessagePort | undefined;
  voice?: TelegramVoicePorts;
}>;
export type TelegramAdapter = Readonly<{
  handleUpdate(update: unknown): Promise<void>;
  deliver(message: TelegramOutboundMessage): Promise<Readonly<{ providerMessageId: string }>>;
}>;

function approvalIdentity(callback: TelegramApprovalCallback) {
  return {
    userId: telegramIdentifier(callback.from.id),
    chatId: telegramIdentifier(callback.message.chat.id)
  };
}

export function createTelegramAdapter(config: TelegramAdapterConfig, ports: TelegramAdapterPorts): TelegramAdapter {
  const parsedConfig = z.object({ botIdentity: z.string().min(1) }).strict().parse(config);
  return Object.freeze({
    handleUpdate: async (input: unknown): Promise<void> => {
      const parsed = TelegramUpdateSchema.safeParse(input);
      if (!parsed.success) return;
      const update = parsed.data;
      const message = TelegramTextMessageSchema.safeParse(update.message);
      if (message.success) {
        const userId = telegramIdentifier(message.data.from.id);
        const chatId = telegramIdentifier(message.data.chat.id);
        const identity = ports.identities.resolve("telegram", userId, chatId);
        if (!("kind" in identity)) {
          await ports.ingress.accept(toTelegramCommand({ message: message.data }, identity.principalId, parsedConfig.botIdentity));
        }
        await ports.cursorStore.save("telegram", update.update_id + 1);
        return;
      }

      const voiceMessage = TelegramVoiceMessageSchema.safeParse(update.message);
      if (voiceMessage.success) {
        const userId = telegramIdentifier(voiceMessage.data.from.id);
        const chatId = telegramIdentifier(voiceMessage.data.chat.id);
        const identity = ports.identities.resolve("telegram", userId, chatId);
        if (!("kind" in identity)) {
          if (ports.voice === undefined) throw new Error("Telegram voice port is not configured");
          const stream = Readable.from(await ports.voice.media.download(voiceMessage.data.voice.file_id));
          const decision = decideTranscript(await ports.voice.transcriber.transcribe(stream));
          if (decision === undefined) throw new Error("Telegram voice transcript is invalid");
          if (decision.kind === "command") {
            await ports.ingress.accept(toTelegramVoiceCommand(
              { message: voiceMessage.data }, identity.principalId, parsedConfig.botIdentity, decision.transcript
            ));
          } else {
            await ports.voice.confirmations.request({
              channel: "telegram",
              principalId: identity.principalId,
              chatId,
              messageId: voiceMessage.data.message_id,
              confirmationText: decision.confirmationText,
              trusted: false
            });
          }
        }
        await ports.cursorStore.save("telegram", update.update_id + 1);
        return;
      }

      const callback = TelegramApprovalCallbackSchema.safeParse(update.callback_query);
      if (callback.success) {
        const { userId, chatId } = approvalIdentity(callback.data);
        const identity = ports.identities.resolve("telegram", userId, chatId);
        if (!("kind" in identity)) {
          const riskLevel = callbackRiskLevel(callback.data.data);
          if (riskLevel === "L2" || riskLevel === "L3") {
            await ports.outbox.enqueue({
              id: `telegram:${parsedConfig.botIdentity}:approval-denied:${callback.data.id}`,
              channel: "telegram",
              destination: chatId,
              template: "approval_channel_not_allowed",
              payload: { riskLevel }
            });
          } else if (riskLevel === "L0" || riskLevel === "L1") {
            await ports.approvalPort.request({
              channel: "telegram",
              callbackId: callback.data.id,
              principalId: identity.principalId,
              chatId,
              messageId: callback.data.message.message_id,
              riskLevel,
              trusted: false
            });
          }
        }
      }
      await ports.cursorStore.save("telegram", update.update_id + 1);
    },
    deliver: async (message: TelegramOutboundMessage) => {
      if (ports.messages === undefined) throw new Error("Telegram message port is not configured");
      return deliverTelegramMessage(message, ports.messages);
    }
  });
}
