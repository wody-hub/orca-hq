import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdentityResolver, type CommandEnvelope, type CommandIngress } from "@orca-hq/core";
import { createVoiceCommandTranscriber, createVoiceIngestionService } from "@orca-hq/voice";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSlackAdapter } from "../src/index.js";
import voiceFileShareFixture from "./fixtures/voice-file-share.json" with { type: "json" };

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

async function voiceTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orca-slack-voice-limit-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function unusedStagingDirectory(): string {
  const directory = join(tmpdir(), `orca-slack-voice-staging-test-${randomUUID()}`);
  temporaryDirectories.push(directory);
  return directory;
}

const identities = new IdentityResolver({
  bindings: [{
    principalId: "owner",
    slackUserIds: ["U123"],
    telegramUserIds: [],
    telegramChatIds: [],
    tailscaleLoginNames: [],
    roles: ["owner"]
  }],
  allowedSlackWorkspaceIds: ["T123"]
});

describe("Slack voice event", () => {
  it("rejects declared Slack voice media over the configured attachment limit", async () => {
    // Break caught: the voice branch bypasses the declared-size check used by ordinary Slack attachments.
    const ingress = { accept: vi.fn(async () => ({ kind: "accepted" as const, commandId: "unused" })) };
    const files = { download: vi.fn(async function* () { yield new Uint8Array([1]); }) };
    const transcriber = { transcribe: vi.fn(async () => ({
      text: "상태를 알려줘", provider: "openai" as const, sourceFileSha256: "e".repeat(64)
    })) };
    const adapter = createSlackAdapter({
      teamId: "T123", channelId: "C123", maxAttachmentBytes: 2,
      stagingDirectory: unusedStagingDirectory()
    }, {
      ingress,
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files,
      voice: {
        transcriber,
        confirmations: { request: vi.fn(async () => undefined) }
      }
    });
    const oversizedEvent = {
      ...voiceFileShareFixture,
      files: [{ ...voiceFileShareFixture.files[0], size: 3 }]
    };

    await expect(adapter.handleEvent(oversizedEvent, "T123")).rejects.toThrow("voice media exceeds");

    expect(files.download).not.toHaveBeenCalled();
    expect(transcriber.transcribe).not.toHaveBeenCalled();
    expect(ingress.accept).not.toHaveBeenCalled();
  });

  it("stops an over-limit Slack voice stream and removes partial temporary audio", async () => {
    // Break caught: a missing streamed cap lets forged size metadata bypass the limit during transcription.
    const temporaryDirectory = await voiceTemporaryDirectory();
    const ingress = { accept: vi.fn(async () => ({ kind: "accepted" as const, commandId: "unused" })) };
    const providerTranscribe = vi.fn(async () => ({ text: "상태를 알려줘" }));
    const transcriber = createVoiceCommandTranscriber(createVoiceIngestionService({
      temporaryDirectory,
      transcriber: { id: "local-whisper", transcribe: providerTranscribe }
    }));
    const adapter = createSlackAdapter({
      teamId: "T123", channelId: "C123", maxAttachmentBytes: 3,
      stagingDirectory: unusedStagingDirectory()
    }, {
      ingress,
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: {
        download: vi.fn(async function* () {
          yield new Uint8Array([1, 2]);
          yield new Uint8Array([3, 4]);
        })
      },
      voice: {
        transcriber,
        confirmations: { request: vi.fn(async () => undefined) }
      }
    });

    await expect(adapter.handleEvent(voiceFileShareFixture, "T123")).rejects.toThrow(
      "voice media exceeds"
    );

    expect(providerTranscribe).not.toHaveBeenCalled();
    expect(ingress.accept).not.toHaveBeenCalled();
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it("routes a confident voice event through transcription and ingress", async () => {
    // Break caught: exported voice helpers are ineffective if Socket Mode processing never calls them.
    const ingress: CommandIngress & { accept: ReturnType<typeof vi.fn> } = {
      accept: vi.fn(async (command: CommandEnvelope) => ({ kind: "accepted" as const, commandId: command.commandId }))
    };
    const files = { download: vi.fn(async function* () { yield new Uint8Array([4, 5, 6]); }) };
    const adapter = createSlackAdapter({
      teamId: "T123", channelId: "C123", maxAttachmentBytes: 1024,
      stagingDirectory: unusedStagingDirectory()
    }, {
      ingress,
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files,
      voice: {
        transcriber: { transcribe: vi.fn(async () => ({
          text: "  릴리스 상태를 알려줘  ", provider: "openai" as const,
          sourceFileSha256: "c".repeat(64), confidence: 0.8
        })) },
        confirmations: { request: vi.fn(async () => undefined) }
      }
    });

    await adapter.handleEvent(voiceFileShareFixture, "T123");

    expect(files.download).toHaveBeenCalledWith("FVOICE");
    expect(ingress.accept).toHaveBeenCalledWith(expect.objectContaining({
      channel: "slack", text: "릴리스 상태를 알려줘",
      transcript: { provider: "openai", sourceFileSha256: "c".repeat(64), confidence: 0.8 }
    }));
    expect(JSON.stringify(ingress.accept.mock.calls[0]?.[0])).not.toContain("FVOICE");
  });

  it("routes a low-confidence voice event to confirmation instead of ingress", async () => {
    // Break caught: uncertain Slack text must be explicitly confirmed before it can be a command.
    const ingress = { accept: vi.fn(async () => ({ kind: "accepted" as const, commandId: "unused" })) };
    const confirmations = { request: vi.fn(async () => undefined) };
    const adapter = createSlackAdapter({
      teamId: "T123", channelId: "C123", maxAttachmentBytes: 1024,
      stagingDirectory: unusedStagingDirectory()
    }, {
      ingress,
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield new Uint8Array([4]); }) },
      voice: {
        transcriber: { transcribe: vi.fn(async () => ({
          text: "프로덕션을 삭제해", provider: "openai" as const,
          sourceFileSha256: "d".repeat(64), confidence: 0.79
        })) },
        confirmations
      }
    });

    await adapter.handleEvent(voiceFileShareFixture, "T123");

    expect(ingress.accept).not.toHaveBeenCalled();
    expect(confirmations.request).toHaveBeenCalledWith(expect.objectContaining({
      channel: "slack", messageTs: "171.004", confirmationText: "프로덕션을 삭제해", trusted: false
    }));
    expect(JSON.stringify(confirmations.request.mock.calls[0]?.[0])).not.toContain("sourceFileSha256");
  });
});
