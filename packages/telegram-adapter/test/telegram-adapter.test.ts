import { IdentityResolver, type CommandEnvelope, type CommandIngress } from "@orca-hq/core";
import { ControlStore, openDatabase } from "@orca-hq/persistence";
import { describe, expect, it, vi } from "vitest";

import {
  createTelegramAdapter,
  deliverTelegramMessage,
  pollTelegramUpdates,
  TelegramRateLimitError
} from "../src/index.js";
import textUpdate from "./fixtures/text-update.json" with { type: "json" };

const identities = new IdentityResolver({
  bindings: [{
    principalId: "owner",
    slackUserIds: [],
    telegramUserIds: ["7788"],
    telegramChatIds: ["9900"],
    tailscaleLoginNames: [],
    roles: ["owner"]
  }],
  allowedSlackWorkspaceIds: ["T123"]
});

function acceptedIngress(): CommandIngress & { accept: ReturnType<typeof vi.fn> } {
  return {
    accept: vi.fn(async (command: CommandEnvelope) => ({
      kind: "accepted" as const,
      commandId: command.commandId
    }))
  };
}

function adapterFor(options: {
  ingress?: CommandIngress & { accept: ReturnType<typeof vi.fn> };
  cursorStore?: { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
  outbox?: { enqueue: ReturnType<typeof vi.fn> };
  approvalPort?: { request: ReturnType<typeof vi.fn> };
} = {}) {
  const ingress = options.ingress ?? acceptedIngress();
  const cursorStore = options.cursorStore ?? {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined)
  };
  const outbox = options.outbox ?? { enqueue: vi.fn(async () => undefined) };
  const approvalPort = options.approvalPort ?? { request: vi.fn(async () => undefined) };
  const adapter = createTelegramAdapter({ botIdentity: "bot-123", maxVoiceBytes: 1024 }, {
    ingress,
    identities,
    cursorStore,
    outbox,
    approvalPort
  });
  return { adapter, ingress, cursorStore, outbox, approvalPort };
}

function approvalCallback(riskLevel: "L0" | "L1" | "L2" | "L3") {
  return {
    update_id: 501,
    callback_query: {
      id: "callback-1",
      from: { id: 7788 },
      message: { message_id: 43, chat: { id: 9900 } },
      data: `approval:${riskLevel}`
    }
  };
}

describe("Telegram adapter", () => {
  it("requires an explicit Telegram voice byte limit at composition", () => {
    // Break caught: an omitted voice limit silently creates an unbounded media ingestion path.
    expect(() => createTelegramAdapter({ botIdentity: "bot-123" } as never, {
      ingress: acceptedIngress(),
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      outbox: { enqueue: vi.fn(async () => undefined) },
      approvalPort: { request: vi.fn(async () => undefined) }
    })).toThrow("maxVoiceBytes");
  });

  it("stores an update before advancing its offset", async () => {
    // Break caught: persisting the offset first loses a command if durable ingress crashes.
    const { adapter, ingress, cursorStore } = adapterFor();

    await adapter.handleUpdate(textUpdate);

    expect(ingress.accept.mock.invocationCallOrder[0]).toBeLessThan(cursorStore.save.mock.invocationCallOrder[0]);
    expect(cursorStore.save).toHaveBeenCalledWith("telegram", 501);
  });

  it.each(["L2", "L3"] as const)("rejects Telegram approval callbacks for %s", async (riskLevel) => {
    // Break caught: allowing a Telegram approval request above L1 bypasses the channel approval ceiling.
    const { adapter, approvalPort, outbox } = adapterFor();

    await adapter.handleUpdate(approvalCallback(riskLevel));

    expect(approvalPort.request).not.toHaveBeenCalled();
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      channel: "telegram",
      destination: "9900",
      template: "approval_channel_not_allowed"
    }));
  });

  it("redelivers safely when offset persistence fails after durable ingress", async () => {
    // Break caught: treating an offset-save failure as completed loses the redelivery needed to recover its cursor.
    const database = openDatabase(":memory:");
    const ingress = new ControlStore(database);
    const cursorStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn()
        .mockRejectedValueOnce(new Error("cursor database unavailable"))
        .mockResolvedValueOnce(undefined)
    };
    const { adapter } = adapterFor({ ingress, cursorStore });

    try {
      await expect(adapter.handleUpdate(textUpdate)).rejects.toThrow("cursor database unavailable");
      await adapter.handleUpdate(textUpdate);

      expect(ingress.listCommands()).toHaveLength(1);
      expect(cursorStore.save).toHaveBeenLastCalledWith("telegram", 501);
    } finally {
      database.close();
    }
  });

  it.each([
    ["user", { ...textUpdate, message: { ...textUpdate.message, from: { id: 9999 } } }],
    ["chat", { ...textUpdate, message: { ...textUpdate.message, chat: { id: 8888 } } }]
  ] as const)("creates no command or response for an unknown Telegram %s", async (_kind, update) => {
    // Break caught: resolving only one half of a Telegram binding exposes command authority or response metadata.
    const database = openDatabase(":memory:");
    const ingress = new ControlStore(database);
    const { adapter, outbox, approvalPort } = adapterFor({ ingress });

    try {
      await adapter.handleUpdate(update);

      expect(ingress.listCommands()).toHaveLength(0);
      expect(outbox.enqueue).not.toHaveBeenCalled();
      expect(approvalPort.request).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("commits an ignored update only after determining it has no command authority", async () => {
    // Break caught: leaving a non-text provider update uncommitted poisons every later long-poll batch.
    const { adapter, ingress, cursorStore } = adapterFor();

    await adapter.handleUpdate({ update_id: 502, edited_message: { message_id: 99 } });

    expect(ingress.accept).not.toHaveBeenCalled();
    expect(cursorStore.save).toHaveBeenCalledWith("telegram", 503);
  });

  it("starts long polling from the persisted Telegram offset", async () => {
    // Break caught: omitting the durable offset replays every historical update after adapter restart.
    const controller = new AbortController();
    const getUpdates = vi.fn(async () => {
      controller.abort();
      return [];
    });
    const cursorStore = {
      load: vi.fn(async () => 501),
      save: vi.fn(async () => undefined)
    };

    await pollTelegramUpdates({
      adapter: adapterFor().adapter,
      cursorStore,
      updates: { getUpdates },
      signal: controller.signal
    });

    expect(getUpdates).toHaveBeenCalledWith(expect.objectContaining({ offset: 501 }));
  });

  it("uses Telegram retry-after instead of local jitter", async () => {
    // Break caught: ignoring the provider retry hint causes avoidable 429 retries.
    const controller = new AbortController();
    const sleep = vi.fn(async () => { controller.abort(); });
    const getUpdates = vi.fn(async () => { throw new TelegramRateLimitError(7); });

    await pollTelegramUpdates({
      adapter: adapterFor().adapter,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      updates: { getUpdates },
      signal: controller.signal,
      sleep,
      random: () => 0
    });

    expect(sleep).toHaveBeenCalledWith(7_000, controller.signal);
  });

  it("caps consecutive polling retries", async () => {
    // Break caught: an unbounded retry loop can hide a permanently failed Telegram credential or provider port.
    const error = new Error("provider unavailable");
    const getUpdates = vi.fn(async () => { throw error; });

    await expect(pollTelegramUpdates({
      adapter: adapterFor().adapter,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      updates: { getUpdates },
      signal: new AbortController().signal,
      maxConsecutiveFailures: 1,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    })).rejects.toThrow("provider unavailable");

    expect(getUpdates).toHaveBeenCalledTimes(2);
  });

  it("caps consecutive retries when handling a fetched update fails", async () => {
    // Break caught: resetting after fetch rather than after a completed batch retries a durable-ingress failure forever.
    const controller = new AbortController();
    const error = new Error("durable ingress unavailable");
    const handleUpdate = vi.fn(async () => { throw error; });
    const getUpdates = vi.fn(async () => {
      if (getUpdates.mock.calls.length === 3) controller.abort();
      return [{ update_id: 500 }];
    });

    await expect(pollTelegramUpdates({
      adapter: { handleUpdate, deliver: vi.fn() },
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      updates: { getUpdates },
      signal: controller.signal,
      maxConsecutiveFailures: 1,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    })).rejects.toThrow("durable ingress unavailable");

    expect(handleUpdate).toHaveBeenCalledTimes(2);
    expect(getUpdates).toHaveBeenCalledTimes(2);
  });

  it("delivers progress as a reply to the originating Telegram message", async () => {
    // Break caught: dropping reply_to_message_id detaches progress from its source command.
    const send = vi.fn(async () => ({ messageId: 44 }));

    await expect(deliverTelegramMessage({
      id: "outbox-1",
      channel: "telegram",
      destination: "9900",
      template: "progress",
      payload: { text: "Working on it", replyToMessageId: 42 },
      attempts: 1,
      nextAttemptAt: "2026-09-01T00:00:00.000Z"
    }, { send })).resolves.toEqual({ providerMessageId: "44" });

    expect(send).toHaveBeenCalledWith({ chatId: "9900", text: "Working on it", replyToMessageId: 42 });
  });

  it("renders an approval-channel denial from its durable template payload", async () => {
    // Break caught: requiring pre-rendered provider text bypasses the durable template contract used by callback handling.
    const send = vi.fn(async () => ({ messageId: 45 }));

    await deliverTelegramMessage({
      id: "approval-denied-1",
      channel: "telegram",
      destination: "9900",
      template: "approval_channel_not_allowed",
      payload: { riskLevel: "L3" },
      attempts: 1,
      nextAttemptAt: "2026-09-01T00:00:00.000Z"
    }, { send });

    expect(send).toHaveBeenCalledWith({
      chatId: "9900",
      text: "Telegram에서는 L3 승인을 처리할 수 없습니다. Slack HQ에서 승인해 주세요."
    });
  });
});
