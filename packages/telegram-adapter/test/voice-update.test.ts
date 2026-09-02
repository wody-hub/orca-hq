import { IdentityResolver, type CommandEnvelope, type CommandIngress } from "@orca-hq/core";
import { describe, expect, it, vi } from "vitest";

import { createTelegramAdapter } from "../src/index.js";

const identities = new IdentityResolver({
  bindings: [{
    principalId: "owner",
    slackUserIds: [],
    telegramUserIds: ["7788"],
    telegramChatIds: ["9900"],
    tailscaleLoginNames: [],
    roles: ["owner"]
  }],
  allowedSlackWorkspaceIds: []
});

const message = {
  message_id: 42,
  date: 1_725_000_000,
  from: { id: 7788 },
  chat: { id: 9900 },
  voice: { file_id: "voice-file-1", file_unique_id: "stable-voice-1", duration: 4 }
};

describe("Telegram voice update", () => {
  it("ingests a confident voice update before advancing its cursor", async () => {
    // Break caught: a voice update falling through as ignored loses the command while advancing Telegram's offset.
    const ingress: CommandIngress & { accept: ReturnType<typeof vi.fn> } = {
      accept: vi.fn(async (command: CommandEnvelope) => ({ kind: "accepted" as const, commandId: command.commandId }))
    };
    const cursorStore = { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) };
    const media = { download: vi.fn(async function* () { yield new Uint8Array([1, 2, 3]); }) };
    const transcriber = {
      transcribe: vi.fn(async () => ({
        text: "  배포 상태를 알려줘  ", provider: "openai" as const,
        sourceFileSha256: "a".repeat(64), confidence: 0.8
      }))
    };
    const confirmations = { request: vi.fn(async () => undefined) };
    const adapter = createTelegramAdapter({ botIdentity: "bot-123" }, {
      ingress,
      identities,
      cursorStore,
      outbox: { enqueue: vi.fn(async () => undefined) },
      approvalPort: { request: vi.fn(async () => undefined) },
      voice: { media, transcriber, confirmations }
    });

    await adapter.handleUpdate({ update_id: 502, message });

    expect(media.download).toHaveBeenCalledWith("voice-file-1");
    expect(ingress.accept).toHaveBeenCalledWith(expect.objectContaining({
      channel: "telegram", externalMessageId: "9900:42", principalId: "owner", text: "배포 상태를 알려줘",
      transcript: { provider: "openai", sourceFileSha256: "a".repeat(64), confidence: 0.8 }
    }));
    expect(ingress.accept.mock.invocationCallOrder[0]).toBeLessThan(cursorStore.save.mock.invocationCallOrder[0]);
    expect(JSON.stringify(ingress.accept.mock.calls[0]?.[0])).not.toContain("voice-file-1");
    expect(confirmations.request).not.toHaveBeenCalled();
  });

  it("delivers a low-confidence confirmation before advancing its cursor", async () => {
    // Break caught: low-confidence text must not enter ingress and a failed confirmation must remain redeliverable.
    const ingress = { accept: vi.fn(async () => ({ kind: "accepted" as const, commandId: "unused" })) };
    const cursorStore = { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) };
    const confirmations = { request: vi.fn(async () => undefined) };
    const adapter = createTelegramAdapter({ botIdentity: "bot-123" }, {
      ingress,
      identities,
      cursorStore,
      outbox: { enqueue: vi.fn(async () => undefined) },
      approvalPort: { request: vi.fn(async () => undefined) },
      voice: {
        media: { download: vi.fn(async function* () { yield new Uint8Array([1]); }) },
        transcriber: { transcribe: vi.fn(async () => ({
          text: "프로덕션을 삭제해", provider: "openai" as const,
          sourceFileSha256: "b".repeat(64), confidence: 0.79
        })) },
        confirmations
      }
    });

    await adapter.handleUpdate({ update_id: 503, message });

    expect(ingress.accept).not.toHaveBeenCalled();
    expect(confirmations.request).toHaveBeenCalledWith(expect.objectContaining({
      channel: "telegram", chatId: "9900", messageId: 42, confirmationText: "프로덕션을 삭제해", trusted: false
    }));
    expect(confirmations.request.mock.invocationCallOrder[0]).toBeLessThan(cursorStore.save.mock.invocationCallOrder[0]);
    expect(JSON.stringify(confirmations.request.mock.calls[0]?.[0])).not.toContain("sourceFileSha256");
  });

  it("does not advance its cursor after voice transcription fails", async () => {
    // Break caught: saving Telegram's offset after a voice failure drops the update permanently.
    const cursorStore = { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) };
    const adapter = createTelegramAdapter({ botIdentity: "bot-123" }, {
      ingress: { accept: vi.fn(async () => ({ kind: "accepted" as const, commandId: "unused" })) },
      identities,
      cursorStore,
      outbox: { enqueue: vi.fn(async () => undefined) },
      approvalPort: { request: vi.fn(async () => undefined) },
      voice: {
        media: { download: vi.fn(async function* () { yield new Uint8Array([1]); }) },
        transcriber: { transcribe: vi.fn(async () => { throw new Error("transcriber unavailable"); }) },
        confirmations: { request: vi.fn(async () => undefined) }
      }
    });

    await expect(adapter.handleUpdate({ update_id: 504, message })).rejects.toThrow("transcriber unavailable");

    expect(cursorStore.save).not.toHaveBeenCalled();
  });

  it("does not advance its cursor when confirmation delivery fails", async () => {
    // Break caught: a failed explicit-confirmation request must be redelivered with the same Telegram update.
    const cursorStore = { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) };
    const adapter = createTelegramAdapter({ botIdentity: "bot-123" }, {
      ingress: { accept: vi.fn(async () => ({ kind: "accepted" as const, commandId: "unused" })) },
      identities,
      cursorStore,
      outbox: { enqueue: vi.fn(async () => undefined) },
      approvalPort: { request: vi.fn(async () => undefined) },
      voice: {
        media: { download: vi.fn(async function* () { yield new Uint8Array([1]); }) },
        transcriber: { transcribe: vi.fn(async () => ({
          text: "프로덕션을 삭제해", provider: "openai" as const,
          sourceFileSha256: "f".repeat(64), confidence: 0.79
        })) },
        confirmations: { request: vi.fn(async () => { throw new Error("confirmation unavailable"); }) }
      }
    });

    await expect(adapter.handleUpdate({ update_id: 505, message })).rejects.toThrow("confirmation unavailable");

    expect(cursorStore.save).not.toHaveBeenCalled();
  });
});
