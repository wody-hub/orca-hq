import { createHash } from "node:crypto";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TemporaryAudioFile = Readonly<{
  path: string;
  remove(): Promise<void>;
}>;

export async function temporaryAudioFile(parentDirectory = tmpdir()): Promise<TemporaryAudioFile> {
  const directory = await mkdtemp(join(parentDirectory, "orca-hq-voice-"));
  return {
    path: join(directory, "audio"),
    remove: async () => rm(directory, { recursive: true, force: true })
  };
}

async function writeFully(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk.subarray(offset));
    const remaining = chunk.byteLength - offset;
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw new Error("Voice audio staging write was incomplete");
    }
    offset += bytesWritten;
  }
}

/** Streams audio to an ephemeral file while calculating its durable provenance hash. */
export async function writeAndHash(stream: AsyncIterable<Uint8Array>, path: string): Promise<string> {
  const handle = await open(path, "wx");
  const hash = createHash("sha256");
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
      await writeFully(handle, chunk);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
