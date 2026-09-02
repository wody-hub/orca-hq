import { randomUUID } from "node:crypto";

import {
  deriveIdempotencyKey,
  type CommandEnvelope,
  type IdentityResolver
} from "@orca-hq/core";
import type { Transcript } from "@orca-hq/voice";
import { z } from "zod";

import type { SlackFile, StagedSlackAttachment, SlackAttachmentStager } from "./attachments.js";

const SlackTimestampSchema = z.string().regex(/^\d+(?:\.\d+)?$/);

export const SlackFileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1),
  mimetype: z.string().min(1).optional(),
  size: z.number().int().nonnegative().optional(),
  url_private: z.string().url().optional()
}).passthrough();

export const SlackMessageEventSchema = z.object({
  type: z.literal("message"),
  channel: z.string().min(1),
  user: z.string().min(1),
  text: z.string().min(1),
  ts: SlackTimestampSchema,
  thread_ts: SlackTimestampSchema.optional(),
  subtype: z.string().min(1).optional(),
  files: z.array(SlackFileSchema).max(10).optional()
}).passthrough();

export const SlackVoiceMessageEventSchema = z.object({
  type: z.literal("message"),
  channel: z.string().min(1),
  user: z.string().min(1),
  ts: SlackTimestampSchema,
  thread_ts: SlackTimestampSchema.optional(),
  subtype: z.string().min(1).optional(),
  files: z.array(SlackFileSchema).length(1)
}).passthrough();

export type SlackMessageEvent = z.infer<typeof SlackMessageEventSchema>;
export type SlackVoiceMessageEvent = z.infer<typeof SlackVoiceMessageEventSchema>;

export type SlackCommandConfig = Readonly<{
  teamId: string;
  channelId: string;
}>;

export type SlackCommandPorts = Readonly<{
  identities: IdentityResolver;
  stageAttachment: SlackAttachmentStager;
}>;

export type PreparedSlackCommand = Readonly<{
  command: CommandEnvelope;
  removeStagedArtifacts(): Promise<void>;
}>;

function receivedAtFromSlackTimestamp(timestamp: string): string {
  return new Date(Number(timestamp) * 1_000).toISOString();
}

function attachmentMetadata(attachments: readonly StagedSlackAttachment[]) {
  return attachments.length === 0 ? undefined : attachments.map((attachment) => ({
    provider: "slack" as const,
    providerFileId: attachment.providerFileId,
    name: attachment.name,
    ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }),
    ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
    contentSha256: attachment.contentSha256
  }));
}

function isAcceptedUserMessageSubtype(event: Readonly<{
  subtype?: string | undefined;
  files?: readonly unknown[] | undefined;
  bot_id?: unknown;
  bot_profile?: unknown;
}>): boolean {
  if (event.bot_id !== undefined || event.bot_profile !== undefined) return false;
  return event.subtype === undefined ||
    (event.subtype === "file_share" && (event.files?.length ?? 0) > 0);
}

/**
 * Translates an untrusted Slack message into the durable core command shape.
 * A return value of undefined means the event was malformed, out of scope, or
 * originated by an identity which has no command authority.
 */
export async function toCommandEnvelope(
  eventInput: unknown,
  config: SlackCommandConfig,
  ports: SlackCommandPorts
): Promise<PreparedSlackCommand | undefined> {
  const parsed = SlackMessageEventSchema.safeParse(eventInput);
  if (!parsed.success || !isAcceptedUserMessageSubtype(parsed.data) ||
    parsed.data.channel !== config.channelId) {
    return undefined;
  }

  const identity = ports.identities.resolve("slack", parsed.data.user, config.teamId);
  if ("kind" in identity) return undefined;

  const attachments: StagedSlackAttachment[] = [];
  try {
    for (const file of parsed.data.files ?? []) {
      attachments.push(await ports.stageAttachment(file));
    }
  } catch (error) {
    await Promise.all(attachments.map((attachment) => attachment.remove()));
    throw error;
  }
  const normalizedAttachments = attachmentMetadata(attachments);
  const externalThreadId = parsed.data.thread_ts ?? parsed.data.ts;

  return {
    command: {
      commandId: randomUUID(),
      idempotencyKey: deriveIdempotencyKey(`slack:${config.teamId}`, parsed.data.ts),
      channel: "slack",
      externalMessageId: parsed.data.ts,
      externalThreadId,
      principalId: identity.principalId,
      receivedAt: receivedAtFromSlackTimestamp(parsed.data.ts),
      text: parsed.data.text,
      ...(normalizedAttachments === undefined ? {} : { attachments: normalizedAttachments })
    },
    removeStagedArtifacts: async () => {
      await Promise.all(attachments.map((attachment) => attachment.remove()));
    }
  };
}

/**
 * Matches exactly one audio attachment without exposing its provider URL or bytes.
 */
export function slackVoiceFileId(eventInput: unknown, config: SlackCommandConfig): string | undefined {
  return slackVoiceFile(eventInput, config)?.id;
}

export function slackVoiceFile(eventInput: unknown, config: SlackCommandConfig): SlackFile | undefined {
  const event = SlackVoiceMessageEventSchema.safeParse(eventInput);
  if (!event.success || !isAcceptedUserMessageSubtype(event.data) ||
    event.data.channel !== config.channelId) return undefined;
  const file = event.data.files[0];
  if (file?.mimetype === undefined || !file.mimetype.startsWith("audio/")) return undefined;
  return file;
}

/** Creates a durable command only from a centrally validated, confident transcript. */
export function toSlackVoiceCommandEnvelope(
  eventInput: unknown,
  config: SlackCommandConfig,
  principalId: string,
  transcript: Transcript
): CommandEnvelope | undefined {
  const event = SlackVoiceMessageEventSchema.safeParse(eventInput);
  if (!event.success || !isAcceptedUserMessageSubtype(event.data) ||
    event.data.channel !== config.channelId) return undefined;
  return {
    commandId: randomUUID(),
    idempotencyKey: deriveIdempotencyKey(`slack:${config.teamId}`, event.data.ts),
    channel: "slack",
    externalMessageId: event.data.ts,
    externalThreadId: event.data.thread_ts ?? event.data.ts,
    principalId,
    receivedAt: receivedAtFromSlackTimestamp(event.data.ts),
    text: transcript.text,
    transcript: {
      provider: transcript.provider,
      sourceFileSha256: transcript.sourceFileSha256,
      ...(transcript.confidence === undefined ? {} : { confidence: transcript.confidence })
    }
  };
}
