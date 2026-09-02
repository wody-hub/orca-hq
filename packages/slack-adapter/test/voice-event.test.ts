import { IdentityResolver } from "@orca-hq/core";
import { describe, expect, it } from "vitest";

import { toSlackVoiceCommandEnvelope } from "../src/events.js";

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

const event = { type: "message", channel: "C123", user: "U123", ts: "171.001" };

describe("Slack voice event", () => {
  it("keeps a confident Korean transcript as a normalized command", () => {
    // Break caught: voice commands must retain the transcript provenance without retaining provider media details.
    const result = toSlackVoiceCommandEnvelope(event, { teamId: "T123", channelId: "C123" }, identities, {
      text: "  릴리스 상태를 알려줘  ",
      provider: "openai",
      sourceFileSha256: "c".repeat(64),
      confidence: 0.8
    });

    expect(result).toMatchObject({
      kind: "command",
      command: {
        channel: "slack",
        text: "릴리스 상태를 알려줘",
        transcript: { provider: "openai", sourceFileSha256: "c".repeat(64), confidence: 0.8 }
      }
    });
  });

  it("does not produce a command for a low-confidence transcript", () => {
    // Break caught: a low-confidence voice response must wait for a user confirmation.
    const result = toSlackVoiceCommandEnvelope(event, { teamId: "T123", channelId: "C123" }, identities, {
      text: "프로덕션을 삭제해",
      provider: "openai",
      sourceFileSha256: "d".repeat(64),
      confidence: 0.79
    });

    expect(result).toEqual({ kind: "confirmation_required", confirmationText: "프로덕션을 삭제해" });
  });
});
