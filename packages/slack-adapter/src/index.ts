import { Readable } from "node:stream";

import { deriveIdempotencyKey, type CommandIngress, type IdentityResolver } from "@orca-hq/core";
import {
  assertVoiceMediaSize,
  decideTranscript,
  limitVoiceMediaBytes,
  type VoiceCommandTranscriber
} from "@orca-hq/voice";
import { z } from "zod";

import {
  createSlackAttachmentStager,
  type SlackFileDownloader
} from "./attachments.js";
import {
  SlackVoiceMessageEventSchema,
  slackVoiceFile,
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
    action_ts: z.string().regex(/^\d+(?:\.\d+)?$/),
    value: z.string().min(1).optional()
  })).min(1)
}).passthrough();

const SlackSocketModeEnvelopeSchema = z.object({
  team_id: z.string().min(1)
}).passthrough();

const SlackApprovalRequestAcceptanceSchema = z.object({
  kind: z.enum(["accepted", "duplicate"]),
  requestId: z.string().min(1)
}).strict();

export type SlackApprovalRequest = Readonly<{
  channel: "slack";
  teamId: string;
  channelId: string;
  principalId: string;
  messageTs: string;
  actionId: string;
  value: string | undefined;
  idempotencyKey: string;
  trusted: false;
}>;

export type SlackApprovalRequestPort = Readonly<{
  accept(request: SlackApprovalRequest): Promise<Readonly<{
    kind: "accepted" | "duplicate";
    requestId: string;
  }>>;
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
  stagedArtifactRetentionMs?: number;
  interactiveActionsEnabled?: boolean;
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
  approvalRequests?: SlackApprovalRequestPort;
}>;

export type SlackAdapter = Readonly<{
  ready(): Promise<void>;
  interactiveActionsEnabled: boolean;
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
    stagingDirectory: z.string().min(1),
    stagedArtifactRetentionMs: z.number().int().positive().optional(),
    interactiveActionsEnabled: z.boolean().default(false)
  }).strict().parse(config);
  if (parsedConfig.interactiveActionsEnabled && ports.approvalRequests === undefined) {
    throw new TypeError("interactive actions require a durable approval-request port");
  }
  const stageAttachment = createSlackAttachmentStager({
    maxAttachmentBytes: parsedConfig.maxAttachmentBytes,
    stagingDirectory: parsedConfig.stagingDirectory,
    ...(parsedConfig.stagedArtifactRetentionMs === undefined
      ? {}
      : { stagedArtifactRetentionMs: parsedConfig.stagedArtifactRetentionMs }),
    files: ports.files
  });

  const handleEvent = async (event: unknown, workspaceId?: string): Promise<void> => {
    await stageAttachment.ready;
    if (workspaceId !== undefined && workspaceId !== parsedConfig.teamId) return;
    const voiceEvent = SlackVoiceMessageEventSchema.safeParse(event);
    const voiceFile = slackVoiceFile(event, parsedConfig);
    if (voiceEvent.success && voiceFile !== undefined) {
      const identity = ports.identities.resolve("slack", voiceEvent.data.user, parsedConfig.teamId);
      if (!("kind" in identity)) {
        if (ports.voice === undefined) throw new Error("Slack voice port is not configured");
        assertVoiceMediaSize(voiceFile.size, parsedConfig.maxAttachmentBytes);
        const stream = Readable.from(limitVoiceMediaBytes(
          await ports.files.download(voiceFile.id),
          parsedConfig.maxAttachmentBytes
        ));
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
    const prepared = await toCommandEnvelope(event, parsedConfig, {
      identities: ports.identities,
      stageAttachment
    });
    if (prepared !== undefined) {
      try {
        const result = await ports.ingress.accept(prepared.command);
        if (result.kind === "duplicate") await prepared.removeStagedArtifacts();
      } catch (error) {
        await prepared.removeStagedArtifacts();
        throw error;
      }
    }
  };

  const handleInteractiveAction = async (payload: unknown): Promise<SlackApprovalRequest | undefined> => {
    if (!parsedConfig.interactiveActionsEnabled) return undefined;
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
      idempotencyKey: deriveIdempotencyKey(`slack-action:${parsedConfig.teamId}`, action.action_ts),
      trusted: false
    };
    SlackApprovalRequestAcceptanceSchema.parse(await ports.approvalRequests!.accept(request));
    return request;
  };

  return Object.freeze({
    ready: async () => stageAttachment.ready,
    interactiveActionsEnabled: parsedConfig.interactiveActionsEnabled,
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
  if (adapter.interactiveActionsEnabled) {
    app.action(/.*/, async ({ body, ack }) => {
      await adapter.handleInteractiveAction(body);
      await ack();
    });
  }
}
