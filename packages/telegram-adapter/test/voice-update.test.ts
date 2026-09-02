import { IdentityResolver } from "@orca-hq/core";
import { describe, expect, it } from "vitest";

import { toTelegramVoiceCommand } from "../src/updates.js";

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
  it("normalizes a confident Korean transcript into one command", () => {
    // Break caught: treating a voice transcript as attachment metadata loses the command text.
    const result = toTelegramVoiceCommand(
      { message },
      identities,
      "bot-123",
      { text: "  배포 상태를 알려줘  ", provider: "openai", sourceFileSha256: "a".repeat(64), confidence: 0.8 }
    );

    expect(result).toMatchObject({
      kind: "command",
      command: {
        channel: "telegram",
        externalMessageId: "9900:42",
        principalId: "owner",
        text: "배포 상태를 알려줘",
        transcript: {
          provider: "openai",
          sourceFileSha256: "a".repeat(64),
          confidence: 0.8
        }
      }
    });
  });

  it("requires confirmation before a low-confidence transcript can become command text", () => {
    // Break caught: a likely-wrong transcript must not enter executable command text.
    const result = toTelegramVoiceCommand(
      { message },
      identities,
      "bot-123",
      { text: "프로덕션을 삭제해", provider: "openai", sourceFileSha256: "b".repeat(64), confidence: 0.79 }
    );

    expect(result).toEqual({
      kind: "confirmation_required",
      confirmationText: "프로덕션을 삭제해"
    });
    expect(JSON.stringify(result)).not.toContain("sourceFileSha256");
  });
});
