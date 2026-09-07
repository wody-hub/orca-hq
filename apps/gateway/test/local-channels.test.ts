import { describe, expect, it, vi } from "vitest";

import { createLocalChannels, type LocalMessage } from "../src/local-channels.js";

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  readyState = 0;

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  throw failure;
}

function harness(overrides: Partial<Parameters<typeof createLocalChannels>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let telegramUpdates: unknown[] = [];
  let failInitialTelegramPoll = false;
  let slackChannel: Record<string, unknown> = { id: "C1", is_channel: true, is_private: true, is_member: true, is_im: false };
  let hangSlackSend = false;
  let slackSendSignal: AbortSignal | undefined;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.endsWith("/getMe")) return json({ ok: true, result: { id: 71, is_bot: true, username: "hq_bot" } });
    if (url.endsWith("/getChat")) return json({ ok: true, result: { id: 42, type: "private" } });
    if (url.includes("/getUpdates")) {
      const body = JSON.parse(String(init?.body)) as { timeout?: number };
      if (body.timeout === 0 && failInitialTelegramPoll) return json({ ok: false, description: "Conflict" }, 409);
      const result = telegramUpdates;
      telegramUpdates = [];
      if (result.length > 0) return json({ ok: true, result });
      if (body.timeout === 0) return json({ ok: true, result: [] });
      return await new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    if (url.endsWith("/auth.test")) return json({ ok: true, team_id: "T1", user_id: "U-BOT" });
    if (url.endsWith("/conversations.info")) {
      // Slack rejects JSON arguments for this method; channel must be form encoded.
      const contentType = new Headers(init?.headers).get("content-type") ?? "";
      if (!contentType.startsWith("application/x-www-form-urlencoded")
        || new URLSearchParams(String(init?.body)).get("channel") !== "C1") {
        return json({ ok: false, error: "invalid_arguments" });
      }
      return json({ ok: true, channel: slackChannel });
    }
    if (url.endsWith("/apps.connections.open")) return json({ ok: true, url: "wss://socket.test/link" });
    if (url.endsWith("/chat.postMessage")) {
      slackSendSignal = init?.signal ?? undefined;
      if (hangSlackSend) return await new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      return json({ ok: true, ts: "2.1" });
    }
    if (url.endsWith("/sendMessage")) return json({ ok: true, result: { message_id: 91 } });
    throw new Error("unexpected request");
  });
  const cursor = {
    load: vi.fn((_channel: "slack" | "telegram") => undefined as string | number | undefined),
    save: vi.fn((_channel: "slack" | "telegram", _cursor: string | number) => undefined)
  };
  const onMessage = vi.fn(async (_message: LocalMessage) => undefined);
  const runtime = createLocalChannels({
    telegramBotToken: "telegram-secret",
    telegramChatId: "42",
    slackAppToken: "slack-app-secret",
    slackBotToken: "slack-bot-secret",
    slackChannelId: "C1",
    onMessage,
    cursor,
    fetch: fetch as typeof globalThis.fetch,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket as unknown as WebSocket;
    },
    ...overrides
  });
  return {
    runtime, fetch, requests, cursor,
    onMessage: (overrides.onMessage ?? onMessage) as typeof onMessage,
    sockets,
    setTelegramUpdates(updates: unknown[]) { telegramUpdates = updates; },
    failInitialTelegramPoll() { failInitialTelegramPoll = true; },
    setSlackChannel(channel: Record<string, unknown>) { slackChannel = channel; },
    hangSlackSend() { hangSlackSend = true; },
    slackSendSignal: () => slackSendSignal
  };
}

describe("local channels", () => {
  it("keeps Slack available when Telegram initial polling fails in managed mode", async () => {
    const h = harness({ partialStart: true });
    h.failInitialTelegramPoll();
    await h.runtime.start();
    try { await eventually(() => expect(h.runtime.status()).toEqual({slack:true, telegram:false})); }
    finally { await h.runtime.stop(); }
  });
  it("keeps Slack available when Telegram configuration is missing in managed mode", async () => {
    const h = harness({ partialStart: true, telegramBotToken: "" });
    await h.runtime.start();
    try {
      await eventually(() => expect(h.runtime.status()).toEqual({ slack: true, telegram: false }));
      expect(h.requests.some(({ url }) => url.endsWith("/auth.test"))).toBe(true);
      expect(h.requests.some(({ url }) => url.includes("api.telegram.org"))).toBe(false);
    } finally { await h.runtime.stop(); }
  });
  it("keeps Telegram available when Slack configuration is missing in managed mode", async () => {
    const h = harness({ partialStart: true, slackAppToken: "" });
    await h.runtime.start();
    try {
      await eventually(() => expect(h.runtime.status()).toEqual({ slack: false, telegram: true }));
      expect(h.requests.some(({ url }) => url.endsWith("/getMe"))).toBe(true);
      expect(h.requests.some(({ url }) => url.includes("slack.com"))).toBe(false);
    } finally { await h.runtime.stop(); }
  });
  it("rejects missing token and destination configuration before contacting providers", async () => {
    // Break caught: malformed local configuration can be embedded in a credential-bearing provider request.
    const providerFetch = vi.fn(async () => json({ ok: true }));
    const h = harness({ telegramBotToken: "", fetch: providerFetch as typeof globalThis.fetch });

    await expect(h.runtime.start()).rejects.toThrow("Local channel configuration is invalid");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(h.runtime.status()).toEqual({ slack: false, telegram: false });
  });

  it("validates both provider identities and returns after opening ingress", async () => {
    // Break caught: start can begin consuming before validating the configured destinations, or block forever on long polling.
    const states: string[] = [];
    const h = harness({ onStatus: (channel, state) => states.push(`${channel}:${state}`) });

    await h.runtime.start();

    expect(h.runtime.status()).toEqual({ slack: true, telegram: true });
    expect(h.requests.map(({ url }) => url.replace("telegram-secret", "[token]"))).toEqual(expect.arrayContaining([
      "https://api.telegram.org/bot[token]/getMe",
      "https://api.telegram.org/bot[token]/getChat",
      "https://slack.com/api/auth.test",
      "https://slack.com/api/conversations.info",
      "https://slack.com/api/apps.connections.open"
    ]));
    expect(states).toEqual(expect.arrayContaining(["telegram:connected", "slack:connected"]));
    await h.runtime.stop();
  });

  it("rejects public, non-member, and direct-message Slack destinations", async () => {
    // Break caught: a valid channel ID can still expose HQ commands outside the configured private member channel.
    for (const channel of [
      { id: "C1", is_channel: true, is_private: false, is_member: true, is_im: false },
      { id: "C1", is_channel: true, is_private: true, is_member: false, is_im: false },
      { id: "C1", is_channel: false, is_private: true, is_member: true, is_im: true }
    ]) {
      const h = harness();
      h.setSlackChannel(channel);
      await expect(h.runtime.start()).rejects.toThrow("Slack channel validation failed");
      expect(h.runtime.status()).toEqual({ slack: false, telegram: false });
    }
  });

  it("accepts a legacy private Slack group when the bot is a member", async () => {
    // Break caught: older conversations.info group shapes can be rejected even though they satisfy the same private-channel boundary.
    const h = harness();
    h.setSlackChannel({ id: "C1", is_group: true, is_private: true, is_member: true, is_im: false });

    await h.runtime.start();

    expect(h.runtime.status()).toEqual({ slack: true, telegram: true });
    await h.runtime.stop();
  });

  it("requires an actual initial Telegram getUpdates success before reporting connected", async () => {
    // Break caught: a webhook conflict can report healthy after getMe/getChat even though no update can be consumed.
    const h = harness();
    h.failInitialTelegramPoll();

    await expect(h.runtime.start()).rejects.toThrow("Telegram getUpdates failed");
    expect(h.runtime.status()).toEqual({ slack: false, telegram: false });
  });

  it("redacts credentials and provider URLs from startup errors and cleans up partial startup", async () => {
    // Break caught: provider error bodies can leak token-bearing URLs or credentials, while Telegram polling remains alive.
    const h = harness({
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/getMe")) return json({ ok: true, result: { id: 71, is_bot: true } });
        if (url.endsWith("/getChat")) return json({ ok: true, result: { id: 42, type: "private" } });
        return json({ ok: false, error: "slack-bot-secret at https://secret.example/path" }, 401);
      }) as typeof globalThis.fetch
    });

    await expect(h.runtime.start()).rejects.toThrow("Slack authentication failed");
    try {
      await h.runtime.start();
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain("slack-bot-secret");
      expect(message).not.toContain("https://");
      expect(message).not.toContain("telegram-secret");
    }
    expect(h.runtime.status()).toEqual({ slack: false, telegram: false });
    await h.runtime.stop();
  });

  it("accepts only configured private Telegram user text and advances after durable acceptance", async () => {
    // Break caught: bot/foreign/non-text updates can enter HQ, or a valid update can be checkpointed before durable acceptance.
    const order: string[] = [];
    const h = harness({
      onMessage: vi.fn(async (message: LocalMessage) => { order.push(`accept:${message.id}`); }),
      cursor: {
        load: () => 10,
        save: (channel, value) => { order.push(`save:${channel}:${value}`); }
      }
    });
    h.setTelegramUpdates([
      { update_id: 10, message: { message_id: 1, date: 1, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: true }, text: "bot" } },
      { update_id: 11, message: { message_id: 2, date: 2, chat: { id: 99, type: "private" }, from: { id: 99, is_bot: false }, text: "foreign" } },
      { update_id: 12, message: { message_id: 3, date: 3, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false }, text: "x".repeat(8_001) } },
      { update_id: 13, message: { message_id: 4, date: 4, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false }, text: "run tests" } }
    ]);

    await h.runtime.start();
    await eventually(() => expect(order).toContain("save:telegram:14"));

    expect(order).toEqual([
      "save:telegram:11",
      "save:telegram:12",
      "save:telegram:13",
      "accept:telegram:71:42:13:4",
      "save:telegram:14"
    ]);
    await h.runtime.stop();
  });

  it("serializes Slack events, accepts configured non-bot messages, then acknowledges and saves", async () => {
    // Break caught: concurrent callbacks, early ACK, or early cursor saves can lose Socket Mode messages after a process failure.
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const h = harness({
      onMessage: vi.fn(async (message: LocalMessage) => {
        order.push(`accept:${message.id}`);
        if (message.text === "first") await firstPending;
      }),
      cursor: {
        load: () => undefined,
        save: (channel, value) => { order.push(`save:${channel}:${value}`); }
      }
    });
    await h.runtime.start();
    const socket = h.sockets[0]!;
    socket.receive({ envelope_id: "E1", type: "events_api", payload: { team_id: "T1", event_id: "EV1", event: { type: "message", channel: "C1", user: "U1", text: "first", ts: "1.1" } } });
    socket.receive({ envelope_id: "E2", type: "events_api", payload: { team_id: "T1", event_id: "EV2", event: { type: "message", channel: "C1", user: "U2", text: "second", ts: "1.2", bot_id: "B1" } } });
    await eventually(() => expect(order).toEqual(["accept:slack:T1:C1:EV1"]));
    expect(socket.sent).toEqual([]);

    releaseFirst?.();
    await eventually(() => expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "E1" }), JSON.stringify({ envelope_id: "E2" })]));
    expect(order).toEqual(["accept:slack:T1:C1:EV1", "save:slack:EV1", "save:slack:EV2"]);
    await h.runtime.stop();
  });

  it("acknowledges the durable Slack cursor replay without accepting it twice", async () => {
    // Break caught: reconnect can dispatch the last durably accepted Socket Mode envelope a second time.
    const h = harness({
      cursor: {
        load: (channel) => channel === "slack" ? "EV1" : undefined,
        save: vi.fn()
      }
    });
    await h.runtime.start();
    const socket = h.sockets[0]!;
    socket.receive({ envelope_id: "E1", type: "events_api", payload: { team_id: "T1", event_id: "EV1", event: { type: "message", channel: "C1", user: "U1", text: "already stored", ts: "1.1" } } });

    await eventually(() => expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "E1" })]));
    expect(h.onMessage).not.toHaveBeenCalled();
    await h.runtime.stop();
  });

  it("leaves a Slack envelope unacknowledged when durable acceptance fails", async () => {
    // Break caught: swallowing a storage failure and ACKing loses the only provider retry of a command.
    const save = vi.fn();
    const h = harness({
      onMessage: vi.fn(async () => { throw new Error("database unavailable"); }),
      cursor: { load: () => undefined, save }
    });
    await h.runtime.start();
    const socket = h.sockets[0]!;
    socket.receive({ envelope_id: "E1", type: "events_api", payload: { team_id: "T1", event_id: "EV1", event: { type: "message", channel: "C1", user: "U1", text: "persist me", ts: "1.1" } } });

    await eventually(() => expect(h.onMessage).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(socket.sent).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    await h.runtime.stop();
  });

  it("reports a Slack disconnect, reconnects, and stops during a reconnectable lifecycle", async () => {
    // Break caught: a closed one-use Socket Mode URL can leave health stale or ingress permanently disconnected.
    const states: string[] = [];
    const h = harness({ onStatus: (channel, state) => states.push(`${channel}:${state}`) });
    await h.runtime.start();
    h.sockets[0]!.close();

    await eventually(() => expect(h.sockets.length).toBe(2));
    expect(states).toEqual(expect.arrayContaining(["slack:connected", "slack:disconnected"]));
    await h.runtime.stop();
    expect(h.runtime.status()).toEqual({ slack: false, telegram: false });
  });

  it("sends replies through each provider and truncates oversized output", async () => {
    // Break caught: replies can target the wrong destination, exceed provider limits, or accept unbounded inbound text.
    const h = harness();
    await h.runtime.start();
    const telegram: LocalMessage = { id: "t", channel: "telegram", destination: "42", userId: "42", text: "hello", receivedAt: "2026-09-07T00:00:00.000Z" };
    const slack: LocalMessage = { id: "s", channel: "slack", destination: "C1", userId: "U1", text: "hello", receivedAt: "2026-09-07T00:00:00.000Z", threadId: "1.1" };

    await h.runtime.send(telegram, "x".repeat(8_001));
    await h.runtime.send(slack, "done");

    const telegramBody = JSON.parse(String(h.requests.find(({ url }) => url.endsWith("/sendMessage"))?.init?.body)) as { chat_id: string; text: string };
    expect(telegramBody.chat_id).toBe("42");
    expect(telegramBody.text.length).toBeLessThanOrEqual(3_500);
    expect(telegramBody.text).toContain("[이하 생략]");
    const slackBody = JSON.parse(String(h.requests.find(({ url }) => url.endsWith("/chat.postMessage"))?.init?.body)) as Record<string, string>;
    expect(slackBody).toEqual({ channel: "C1", text: "done", thread_ts: "1.1" });
    await h.runtime.stop();
    expect(h.runtime.status()).toEqual({ slack: false, telegram: false });
  });

  it("aborts an in-flight provider send when stopped", async () => {
    // Break caught: shutdown can hang forever on a result delivery fetch that never returns.
    const h = harness();
    await h.runtime.start();
    h.hangSlackSend();
    const message: LocalMessage = { id: "s", channel: "slack", destination: "C1", userId: "U1", text: "hello", receivedAt: "2026-09-07T00:00:00.000Z" };
    const sending = h.runtime.send(message, "done");
    await eventually(() => expect(h.slackSendSignal()).toBeDefined());

    await h.runtime.stop();

    expect(h.slackSendSignal()?.aborted).toBe(true);
    await expect(sending).rejects.toThrow();
  });
});
