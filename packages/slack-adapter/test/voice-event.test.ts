import { IdentityResolver, type CommandEnvelope, type CommandIngress } from "@orca-hq/core";
import { describe, expect, it, vi } from "vitest";

import { createSlackAdapter } from "../src/index.js";

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

const event = {
  type: "message", channel: "C123", user: "U123", ts: "171.001",
  files: [{ id: "FVOICE", name: "voice.mp4", mimetype: "audio/mp4" }]
};

describe("Slack voice event", () => {
  it("routes a confident voice event through transcription and ingress", async () => {
    // Break caught: exported voice helpers are ineffective if Socket Mode processing never calls them.
    const ingress: CommandIngress & { accept: ReturnType<typeof vi.fn> } = {
      accept: vi.fn(async (command: CommandEnvelope) => ({ kind: "accepted" as const, commandId: command.commandId }))
    };
    const files = { download: vi.fn(async function* () { yield new Uint8Array([4, 5, 6]); }) };
    const adapter = createSlackAdapter({
      teamId: "T123", channelId: "C123", maxAttachmentBytes: 1024, stagingDirectory: "unused"
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

    await adapter.handleEvent(event, "T123");

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
      teamId: "T123", channelId: "C123", maxAttachmentBytes: 1024, stagingDirectory: "unused"
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

    await adapter.handleEvent(event, "T123");

    expect(ingress.accept).not.toHaveBeenCalled();
    expect(confirmations.request).toHaveBeenCalledWith(expect.objectContaining({
      channel: "slack", messageTs: "171.001", confirmationText: "프로덕션을 삭제해", trusted: false
    }));
    expect(JSON.stringify(confirmations.request.mock.calls[0]?.[0])).not.toContain("sourceFileSha256");
  });
});
