import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SlackFileSchema } from "./events.js";
import type { z } from "zod";

export const DEFAULT_SLACK_STAGED_ARTIFACT_RETENTION_MS = 15 * 60_000;
export const SLACK_MANAGED_STAGING_DIRECTORY = "orca-hq-slack-artifacts-v1";

const MAX_TIMER_MS = 2_147_483_647;
const SlackFileIdPattern = /^[A-Za-z0-9_-]+$/;
const ManagedArtifactNamePattern = /^attachment-[A-Za-z0-9_-]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SlackFile = z.infer<typeof SlackFileSchema>;

export type SlackFileDownloader = Readonly<{
  /** Downloads only by opaque provider file ID; private download URLs never leave event parsing. */
  download(fileId: string): AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;
}>;

export type StagedSlackAttachment = Readonly<{
  providerFileId: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  contentSha256: string;
  /** Ephemeral ownership handle; never copied into a durable command or audit event. */
  remove(): Promise<void>;
}>;

export type SlackAttachmentStager = ((file: SlackFile) => Promise<StagedSlackAttachment>) & Readonly<{
  /** Completes the startup janitor before an adapter begins accepting events. */
  ready: Promise<void>;
}>;

export type SlackAttachmentWriter = Readonly<{
  write(chunk: Uint8Array): Promise<Readonly<{ bytesWritten: number }>>;
}>;

export class SlackAttachmentTooLargeError extends Error {
  constructor(readonly fileId: string, readonly maxBytes: number) {
    super(`Slack file ${fileId} exceeds the ${maxBytes}-byte limit`);
    this.name = "SlackAttachmentTooLargeError";
  }
}

/** Ensures a filesystem short write cannot truncate untrusted staged content. */
export async function writeFully(handle: SlackAttachmentWriter, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk.subarray(offset));
    const remainingBytes = chunk.byteLength - offset;
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remainingBytes) {
      throw new Error("Slack attachment staging write was incomplete");
    }
    offset += bytesWritten;
  }
}

function scheduleRemoval(path: string, delayMs: number): NodeJS.Timeout {
  const expiry = setTimeout(() => rm(path, { force: true }).catch(() => undefined), delayMs);
  expiry.unref();
  return expiry;
}

async function initializeManagedStagingDirectory(
  managedDirectory: string,
  retentionMs: number
): Promise<void> {
  await mkdir(managedDirectory, { recursive: true });
  const now = Date.now();
  const entries = await readdir(managedDirectory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !ManagedArtifactNamePattern.test(entry.name)) return;
    const path = join(managedDirectory, entry.name);
    const metadata = await stat(path);
    const remainingMs = metadata.mtimeMs + retentionMs - now;
    if (remainingMs <= 0) {
      await rm(path, { force: true });
      return;
    }
    scheduleRemoval(path, Math.min(remainingMs, retentionMs));
  }));
}

export function createSlackAttachmentStager(options: Readonly<{
  maxAttachmentBytes: number;
  stagingDirectory: string;
  stagedArtifactRetentionMs?: number;
  files: SlackFileDownloader;
}>): SlackAttachmentStager {
  if (!Number.isSafeInteger(options.maxAttachmentBytes) || options.maxAttachmentBytes < 0) {
    throw new TypeError("maxAttachmentBytes must be a non-negative safe integer");
  }
  const retentionMs = options.stagedArtifactRetentionMs ?? DEFAULT_SLACK_STAGED_ARTIFACT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0 || retentionMs > MAX_TIMER_MS) {
    throw new TypeError(`stagedArtifactRetentionMs must be between 1 and ${MAX_TIMER_MS}`);
  }
  if (options.stagingDirectory.trim().length === 0) throw new TypeError("stagingDirectory is required");
  const managedDirectory = join(options.stagingDirectory, SLACK_MANAGED_STAGING_DIRECTORY);
  const ready = initializeManagedStagingDirectory(managedDirectory, retentionMs);
  // Constructors can be composed before startup awaits `ready`. Mark the eager
  // janitor promise as observed while preserving its rejection for every
  // explicit `ready`/staging awaiter.
  void ready.catch(() => undefined);

  const stage = async (file: SlackFile): Promise<StagedSlackAttachment> => {
    await ready;
    if (!SlackFileIdPattern.test(file.id)) throw new TypeError("Slack file ID is invalid");
    if (file.size !== undefined && file.size > options.maxAttachmentBytes) {
      throw new SlackAttachmentTooLargeError(file.id, options.maxAttachmentBytes);
    }

    const stagedPath = join(managedDirectory, `attachment-${file.id}-${randomUUID()}`);
    const handle = await open(stagedPath, "wx");
    const hash = createHash("sha256");
    let byteCount = 0;

    try {
      for await (const chunk of await options.files.download(file.id)) {
        const nextByteCount = byteCount + chunk.byteLength;
        if (nextByteCount > options.maxAttachmentBytes) {
          throw new SlackAttachmentTooLargeError(file.id, options.maxAttachmentBytes);
        }
        await writeFully(handle, chunk);
        hash.update(chunk);
        byteCount = nextByteCount;
      }
    } catch (error) {
      await handle.close();
      await rm(stagedPath, { force: true });
      throw error;
    }

    await handle.close();
    const expiry = scheduleRemoval(stagedPath, retentionMs);
    return {
      providerFileId: file.id,
      name: file.name,
      ...(file.mimetype === undefined ? {} : { mimeType: file.mimetype }),
      sizeBytes: byteCount,
      contentSha256: hash.digest("hex"),
      remove: async () => {
        clearTimeout(expiry);
        await rm(stagedPath, { force: true });
      }
    };
  };
  return Object.assign(stage, { ready });
}
