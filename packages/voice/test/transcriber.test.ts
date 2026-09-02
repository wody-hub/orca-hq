import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiTranscriber, createVoiceIngestionService } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orca-voice-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeAudioStream(): Readable {
  return Readable.from([new Uint8Array([0, 1, 2]), new Uint8Array([3, 4, 5])]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("voice ingestion", () => {
  it("requests Korean transcription and deletes audio after success", async () => {
    // Break caught: forgetting the language or retaining audio after a completed transcription.
    const directory = await temporaryDirectory();
    const openai = {
      transcribe: vi.fn(async () => ({ text: "프로젝트 상태 알려줘", confidence: 0.98 }))
    };
    const service = createVoiceIngestionService({
      temporaryDirectory: directory,
      transcriber: createOpenAiTranscriber({
        credentials: { getOpenAiApiKey: vi.fn(async () => "test-only-key") },
        openai
      })
    });

    const result = await service.ingest(fakeAudioStream(), { language: "ko", retain: false });

    expect(openai.transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: "ko" }));
    expect(result).toMatchObject({
      text: "프로젝트 상태 알려줘",
      provider: "openai",
      confidence: 0.98,
      sourceFileSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(await exists(result.temporaryPath)).toBe(false);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("deletes audio after provider failure", async () => {
    // Break caught: cleanup only on success leaves an audio file after a provider outage.
    const directory = await temporaryDirectory();
    const openai = {
      transcribe: vi.fn(async () => { throw new Error("provider unavailable"); })
    };
    const service = createVoiceIngestionService({
      temporaryDirectory: directory,
      transcriber: createOpenAiTranscriber({
        credentials: { getOpenAiApiKey: vi.fn(async () => "test-only-key") },
        openai
      })
    });

    await expect(service.ingest(fakeAudioStream(), { language: "ko", retain: false }))
      .rejects.toThrow("provider unavailable");

    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("retains audio only when explicitly requested", async () => {
    // Break caught: an omitted retention flag must never preserve a voice recording.
    const directory = await temporaryDirectory();
    const service = createVoiceIngestionService({
      temporaryDirectory: directory,
      transcriber: {
        id: "local-whisper",
        transcribe: vi.fn(async () => ({ text: "진행해", confidence: 0.99 }))
      }
    });

    const result = await service.ingest(fakeAudioStream(), { language: "ko", retain: true });

    expect(await exists(result.temporaryPath)).toBe(true);
  });
});
