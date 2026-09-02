import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import type { SlackFileSchema } from "./events.js";
import type { z } from "zod";

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
}>;

export type SlackAttachmentStager = (file: SlackFile) => Promise<StagedSlackAttachment>;

export class SlackAttachmentTooLargeError extends Error {
  constructor(readonly fileId: string, readonly maxBytes: number) {
    super(`Slack file ${fileId} exceeds the ${maxBytes}-byte limit`);
    this.name = "SlackAttachmentTooLargeError";
  }
}

export function createSlackAttachmentStager(options: Readonly<{
  maxAttachmentBytes: number;
  stagingDirectory: string;
  files: SlackFileDownloader;
}>): SlackAttachmentStager {
  if (!Number.isSafeInteger(options.maxAttachmentBytes) || options.maxAttachmentBytes < 0) {
    throw new TypeError("maxAttachmentBytes must be a non-negative safe integer");
  }

  return async (file) => {
    if (file.size !== undefined && file.size > options.maxAttachmentBytes) {
      throw new SlackAttachmentTooLargeError(file.id, options.maxAttachmentBytes);
    }

    await mkdir(options.stagingDirectory, { recursive: true });
    const stagedPath = join(options.stagingDirectory, file.id);
    const handle = await open(stagedPath, "w");
    const hash = createHash("sha256");
    let byteCount = 0;

    try {
      for await (const chunk of await options.files.download(file.id)) {
        byteCount += chunk.byteLength;
        if (byteCount > options.maxAttachmentBytes) {
          throw new SlackAttachmentTooLargeError(file.id, options.maxAttachmentBytes);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } catch (error) {
      await handle.close();
      await rm(stagedPath, { force: true });
      throw error;
    }

    await handle.close();
    return {
      providerFileId: file.id,
      name: file.name,
      ...(file.mimetype === undefined ? {} : { mimeType: file.mimetype }),
      sizeBytes: byteCount,
      contentSha256: hash.digest("hex")
    };
  };
}
