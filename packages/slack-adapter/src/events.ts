import { randomUUID } from "node:crypto";

import {
  deriveIdempotencyKey,
  type CommandEnvelope,
  type IdentityResolver
} from "@orca-hq/core";
import type { Transcript } from "@orca-hq/voice";
import { z } from "zod";

import type { StagedSlackAttachment, SlackAttachmentStager } from "./attachments.js";

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

/**
 * Translates an untrusted Slack message into the durable core command shape.
 * A return value of undefined means the event was malformed, out of scope, or
 * originated by an identity which has no command authority.
 */
export async function toCommandEnvelope(
  eventInput: unknown,
  config: SlackCommandConfig,
  ports: SlackCommandPorts
): Promise<CommandEnvelope | undefined> {
  const parsed = SlackMessageEventSchema.safeParse(eventInput);
  if (!parsed.success || parsed.data.subtype !== undefined || parsed.data.channel !== config.channelId) {
    return undefined;
  }

  const identity = ports.identities.resolve("slack", parsed.data.user, config.teamId);
  if ("kind" in identity) return undefined;

  const attachments = parsed.data.files === undefined
    ? []
    : await Promise.all(parsed.data.files.map((file) => ports.stageAttachment(file)));
  const normalizedAttachments = attachmentMetadata(attachments);
  const externalThreadId = parsed.data.thread_ts ?? parsed.data.ts;

  return {
    commandId: randomUUID(),
    idempotencyKey: deriveIdempotencyKey(`slack:${config.teamId}`, parsed.data.ts),
    channel: "slack",
    externalMessageId: parsed.data.ts,
    externalThreadId,
    principalId: identity.principalId,
    receivedAt: receivedAtFromSlackTimestamp(parsed.data.ts),
    text: parsed.data.text,
    ...(normalizedAttachments === undefined ? {} : { attachments: normalizedAttachments })
  };
}

/**
 * Matches exactly one audio attachment without exposing its provider URL or bytes.
 */
export function slackVoiceFileId(eventInput: unknown, config: SlackCommandConfig): string | undefined {
  const event = SlackVoiceMessageEventSchema.safeParse(eventInput);
  if (!event.success || event.data.subtype !== undefined || event.data.channel !== config.channelId) return undefined;
  const file = event.data.files[0];
  if (file?.mimetype === undefined || !file.mimetype.startsWith("audio/")) return undefined;
  return file.id;
}

/** Creates a durable command only from a centrally validated, confident transcript. */
export function toSlackVoiceCommandEnvelope(
  eventInput: unknown,
  config: SlackCommandConfig,
  principalId: string,
  transcript: Transcript
): CommandEnvelope | undefined {
  const event = SlackVoiceMessageEventSchema.safeParse(eventInput);
  if (!event.success || event.data.subtype !== undefined || event.data.channel !== config.channelId) return undefined;
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
