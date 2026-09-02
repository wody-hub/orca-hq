import { Readable } from "node:stream";

import type { CommandIngress, IdentityResolver } from "@orca-hq/core";
import { decideTranscript, type VoiceCommandTranscriber } from "@orca-hq/voice";
import { z } from "zod";

import {
  createSlackAttachmentStager,
  type SlackFileDownloader
} from "./attachments.js";
import {
  SlackVoiceMessageEventSchema,
  slackVoiceFileId,
  toCommandEnvelope,
  toSlackVoiceCommandEnvelope
} from "./events.js";
import {
  deliverSlackMessage,
  type SlackMessagePort,
  type SlackOutboundMessage
} from "./outbound.js";
import {
  reconcileSlackHistory,
  type ChannelCursorStore,
  type SlackHistoryPort
} from "./reconcile.js";

export * from "./attachments.js";
export * from "./events.js";
export * from "./outbound.js";
export * from "./reconcile.js";

const SlackInteractiveActionSchema = z.object({
  team: z.object({ id: z.string().min(1) }),
  user: z.object({ id: z.string().min(1) }),
  channel: z.object({ id: z.string().min(1) }),
  container: z.object({ message_ts: z.string().min(1) }),
  actions: z.array(z.object({
    action_id: z.string().min(1),
    value: z.string().min(1).optional()
  })).min(1)
}).passthrough();

const SlackSocketModeEnvelopeSchema = z.object({
  team_id: z.string().min(1)
}).passthrough();

export type SlackApprovalRequest = Readonly<{
  channel: "slack";
  teamId: string;
  channelId: string;
  principalId: string;
  messageTs: string;
  actionId: string;
  value: string | undefined;
  trusted: false;
}>;

export type SlackSocketModeApp = Readonly<{
  event(
    name: "message",
    handler: (payload: Readonly<{ event: unknown; body: unknown }>) => Promise<void>
  ): void;
  action(
    constraint: string | RegExp,
    handler: (payload: Readonly<{ body: unknown; ack: () => Promise<void> }>) => Promise<void>
  ): void;
}>;

export type SlackAdapterConfig = Readonly<{
  teamId: string;
  channelId: string;
  maxAttachmentBytes: number;
  stagingDirectory: string;
}>;

export type SlackVoicePorts = Readonly<{
  transcriber: VoiceCommandTranscriber;
  confirmations: Readonly<{
    request(request: Readonly<{
      channel: "slack";
      teamId: string;
      channelId: string;
      principalId: string;
      messageTs: string;
      confirmationText: string;
      trusted: false;
    }>): Promise<void>;
  }>;
}>;

export type SlackAdapterPorts = Readonly<{
  ingress: CommandIngress;
  identities: IdentityResolver;
  cursorStore: ChannelCursorStore;
  history: SlackHistoryPort;
  files: SlackFileDownloader;
  voice?: SlackVoicePorts;
  messages?: SlackMessagePort;
  approvalRequests?: Readonly<{ accept(request: SlackApprovalRequest): Promise<void> }>;
}>;

export type SlackAdapter = Readonly<{
  handleEvent(event: unknown, workspaceId?: string): Promise<void>;
  reconcile(): Promise<void>;
  deliver(message: SlackOutboundMessage): Promise<Readonly<{ providerMessageId: string }>>;
  handleInteractiveAction(payload: unknown): Promise<SlackApprovalRequest | undefined>;
}>;

export function createSlackAdapter(config: SlackAdapterConfig, ports: SlackAdapterPorts): SlackAdapter {
  const parsedConfig = z.object({
    teamId: z.string().min(1),
    channelId: z.string().min(1),
    maxAttachmentBytes: z.number().int().nonnegative(),
    stagingDirectory: z.string().min(1)
  }).strict().parse(config);
  const stageAttachment = createSlackAttachmentStager({
    maxAttachmentBytes: parsedConfig.maxAttachmentBytes,
    stagingDirectory: parsedConfig.stagingDirectory,
    files: ports.files
  });

  const handleEvent = async (event: unknown, workspaceId?: string): Promise<void> => {
    if (workspaceId !== undefined && workspaceId !== parsedConfig.teamId) return;
    const voiceEvent = SlackVoiceMessageEventSchema.safeParse(event);
    const voiceFileId = slackVoiceFileId(event, parsedConfig);
    if (voiceEvent.success && voiceFileId !== undefined) {
      const identity = ports.identities.resolve("slack", voiceEvent.data.user, parsedConfig.teamId);
      if (!("kind" in identity)) {
        if (ports.voice === undefined) throw new Error("Slack voice port is not configured");
        const stream = Readable.from(await ports.files.download(voiceFileId));
        const decision = decideTranscript(await ports.voice.transcriber.transcribe(stream));
        if (decision === undefined) throw new Error("Slack voice transcript is invalid");
        if (decision.kind === "command") {
          const command = toSlackVoiceCommandEnvelope(
            voiceEvent.data, parsedConfig, identity.principalId, decision.transcript
          );
          if (command === undefined) throw new Error("Slack voice event is invalid");
          await ports.ingress.accept(command);
        } else {
          await ports.voice.confirmations.request({
            channel: "slack",
            teamId: parsedConfig.teamId,
            channelId: parsedConfig.channelId,
            principalId: identity.principalId,
            messageTs: voiceEvent.data.ts,
            confirmationText: decision.confirmationText,
            trusted: false
          });
        }
      }
      return;
    }
    const command = await toCommandEnvelope(event, parsedConfig, {
      identities: ports.identities,
      stageAttachment
    });
    if (command !== undefined) await ports.ingress.accept(command);
  };

  const handleInteractiveAction = async (payload: unknown): Promise<SlackApprovalRequest | undefined> => {
    const parsed = SlackInteractiveActionSchema.safeParse(payload);
    if (!parsed.success || parsed.data.team.id !== parsedConfig.teamId ||
      parsed.data.channel.id !== parsedConfig.channelId) return undefined;

    const identity = ports.identities.resolve("slack", parsed.data.user.id, parsedConfig.teamId);
    if ("kind" in identity) return undefined;

    const action = parsed.data.actions[0];
    if (action === undefined) return undefined;
    const request: SlackApprovalRequest = {
      channel: "slack",
      teamId: parsedConfig.teamId,
      channelId: parsedConfig.channelId,
      principalId: identity.principalId,
      messageTs: parsed.data.container.message_ts,
      actionId: action.action_id,
      value: action.value,
      trusted: false
    };
    await ports.approvalRequests?.accept(request);
    return request;
  };

  return Object.freeze({
    handleEvent,
    reconcile: async () => reconcileSlackHistory({
      channelId: parsedConfig.channelId,
      cursorStore: ports.cursorStore,
      history: ports.history,
      handleEvent
    }),
    deliver: async (message) => {
      if (ports.messages === undefined) throw new Error("Slack message port is not configured");
      return deliverSlackMessage(message, ports.messages);
    },
    handleInteractiveAction
  });
}

/** Registers Socket Mode handlers without opening a connection or holding credentials. */
export function registerSlackSocketModeHandlers(app: SlackSocketModeApp, adapter: SlackAdapter): void {
  app.event("message", async ({ event, body }) => {
    const envelope = SlackSocketModeEnvelopeSchema.safeParse(body);
    if (!envelope.success) return;
    await adapter.handleEvent(event, envelope.data.team_id);
  });
  app.action(/.*/, async ({ body, ack }) => {
    await ack();
    await adapter.handleInteractiveAction(body);
  });
}
