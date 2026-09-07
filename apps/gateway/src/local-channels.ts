export interface LocalMessage {
  id: string;
  channel: "slack" | "telegram";
  destination: string;
  userId: string;
  text: string;
  receivedAt: string;
  threadId?: string;
}

type Channel = LocalMessage["channel"];
type ConnectionState = "connected" | "disconnected";

export interface LocalChannelsOptions {
  partialStart?: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  slackAppToken: string;
  slackBotToken: string;
  slackChannelId: string;
  onMessage(message: LocalMessage): Promise<void>;
  onStatus?(channel: Channel, state: ConnectionState): void;
  cursor: {
    load(channel: Channel): string | number | undefined;
    save(channel: Channel, cursor: string | number): void;
  };
  fetch?: typeof globalThis.fetch;
  socketFactory?(url: string): WebSocket;
}

export interface LocalChannels {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: LocalMessage, text: string): Promise<void>;
  status(): { slack: boolean; telegram: boolean };
}

interface TelegramEnvelope<T> {
  ok?: boolean;
  result?: T;
}

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string; is_bot?: boolean };
  };
}

interface SlackEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: {
    team_id?: string;
    event_id?: string;
    event?: {
      type?: string;
      channel?: string;
      user?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
      bot_id?: string;
      subtype?: string;
    };
  };
}

const TELEGRAM_API = "https://api.telegram.org";
const SLACK_API = "https://slack.com/api";
const MAX_INPUT = 8_000;
const MAX_OUTPUT = 3_500;
const TRUNCATION_MARKER = "\n[이하 생략]";
const REQUEST_TIMEOUT_MS = 10_000;
const LONG_POLL_TIMEOUT_MS = 35_000;

function safeStatus(callback: LocalChannelsOptions["onStatus"], channel: Channel, state: ConnectionState): void {
  try {
    callback?.(channel, state);
  } catch {
    // Status observers must not take down provider ingress.
  }
}

function truncated(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function abortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function boundedSignal(lifecycleSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return lifecycleSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([lifecycleSignal, timeoutSignal]);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); }
    );
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener("abort", stopped);
      resolve();
    }
    function stopped(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", stopped);
      reject(new DOMException("aborted", "AbortError"));
    }
    signal.addEventListener("abort", stopped, { once: true });
  });
}

export function createLocalChannels(options: LocalChannelsOptions): LocalChannels {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const makeSocket = options.socketFactory ?? ((url: string) => new WebSocket(url));
  const telegramBase = `${TELEGRAM_API}/bot${options.telegramBotToken}`;
  let telegramBotId = "";
  let slackTeamId = "";
  let slackBotUserId = "";
  let slackCursor: string | undefined;
  let controller: AbortController | undefined;
  let telegramTask: Promise<void> | undefined;
  let slackTask: Promise<void> | undefined;
  let slackSocket: WebSocket | undefined;
  let telegramConnected = false;
  let slackConnected = false;
  let starting = false;
  let started = false;
  let slackSerial = Promise.resolve();

  function telegramConfigured(): boolean {
    return [options.telegramBotToken, options.telegramChatId].every((value) => value.trim().length > 0);
  }

  function slackConfigured(): boolean {
    return [options.slackAppToken, options.slackBotToken, options.slackChannelId].every((value) => value.trim().length > 0);
  }

  function validateConfiguration(): void {
    if (!telegramConfigured() || !slackConfigured()) throw new Error("Local channel configuration is invalid");
  }

  function setConnected(channel: Channel, connected: boolean): void {
    if (channel === "telegram") {
      if (telegramConnected === connected) return;
      telegramConnected = connected;
    } else {
      if (slackConnected === connected) return;
      slackConnected = connected;
    }
    safeStatus(options.onStatus, channel, connected ? "connected" : "disconnected");
  }

  async function providerJson<T>(
    provider: "Telegram" | "Slack",
    operation: string,
    url: string,
    init: RequestInit
  ): Promise<T> {
    let response: Response;
    try {
      const signal = init.signal;
      response = signal === null || signal === undefined
        ? await fetchImpl(url, init)
        : await abortable(fetchImpl(url, init), signal);
    } catch (error) {
      if (abortError(error)) throw error;
      throw new Error(`${provider} ${operation} failed`);
    }
    let body: unknown;
    try {
      const reading = response.json();
      body = init.signal === null || init.signal === undefined
        ? await reading
        : await abortable(reading, init.signal);
    } catch {
      throw new Error(`${provider} ${operation} failed`);
    }
    if (!response.ok || typeof body !== "object" || body === null || (body as { ok?: boolean }).ok !== true) {
      throw new Error(`${provider} ${operation} failed`);
    }
    return body as T;
  }

  function telegramRequest<T>(
    method: string,
    body: Record<string, unknown>,
    lifecycleSignal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<TelegramEnvelope<T>> {
    const signal = boundedSignal(lifecycleSignal, timeoutMs);
    return providerJson<TelegramEnvelope<T>>("Telegram", method, `${telegramBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  }

  function slackRequest<T>(
    method: string,
    token: string,
    body: Record<string, unknown>,
    lifecycleSignal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const signal = boundedSignal(lifecycleSignal, timeoutMs);
    return providerJson<T>("Slack", method === "auth.test" ? "authentication" : method, `${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": method === "conversations.info"
          ? "application/x-www-form-urlencoded; charset=utf-8"
          : "application/json; charset=utf-8"
      },
      body: method === "conversations.info"
        ? new URLSearchParams({ channel: String(body.channel) }).toString()
        : JSON.stringify(body),
      signal
    });
  }

  async function validateTelegram(signal: AbortSignal): Promise<void> {
    const identity = await telegramRequest<{ id?: number | string; is_bot?: boolean }>("getMe", {}, signal);
    if (identity.result?.is_bot !== true || identity.result.id === undefined) throw new Error("Telegram authentication failed");
    telegramBotId = String(identity.result.id);
    const chat = await telegramRequest<{ id?: number | string; type?: string }>("getChat", { chat_id: options.telegramChatId }, signal);
    if (String(chat.result?.id) !== options.telegramChatId || chat.result?.type !== "private") {
      throw new Error("Telegram chat validation failed");
    }
  }

  async function validateSlack(signal: AbortSignal): Promise<string> {
    const identity = await slackRequest<{ team_id?: string; user_id?: string }>("auth.test", options.slackBotToken, {}, signal);
    if (typeof identity.team_id !== "string" || typeof identity.user_id !== "string") throw new Error("Slack authentication failed");
    slackTeamId = identity.team_id;
    slackBotUserId = identity.user_id;
    const info = await slackRequest<{ channel?: {
      id?: string;
      is_channel?: boolean;
      is_group?: boolean;
      is_private?: boolean;
      is_member?: boolean;
      is_im?: boolean;
    } }>(
      "conversations.info", options.slackBotToken, { channel: options.slackChannelId }, signal
    );
    const channel = info.channel;
    if (channel?.id !== options.slackChannelId
      || channel.is_private !== true
      || channel.is_member !== true
      || channel.is_im === true
      || (channel.is_channel !== true && channel.is_group !== true)) {
      throw new Error("Slack channel validation failed");
    }
    return openSlackSocketUrl(signal);
  }

  async function openSlackSocketUrl(signal: AbortSignal): Promise<string> {
    const opened = await slackRequest<{ url?: string }>("apps.connections.open", options.slackAppToken, {}, signal);
    if (typeof opened.url !== "string" || !opened.url.startsWith("wss://")) throw new Error("Slack socket connection failed");
    return opened.url;
  }

  async function processTelegramUpdate(update: TelegramUpdate): Promise<void> {
    if (!Number.isInteger(update.update_id)) return;
    const updateId = update.update_id as number;
    const nextCursor = updateId + 1;
    const message = update.message;
    const accepted = message !== undefined
      && Number.isInteger(message.message_id)
      && typeof message.text === "string"
      && message.text.length > 0
      && message.text.length <= MAX_INPUT
      && message.chat?.type === "private"
      && String(message.chat.id) === options.telegramChatId
      && String(message.from?.id) === options.telegramChatId
      && message.from?.is_bot !== true;
    if (accepted) {
      await options.onMessage({
        id: `telegram:${telegramBotId}:${options.telegramChatId}:${updateId}:${message.message_id}`,
        channel: "telegram",
        destination: options.telegramChatId,
        userId: String(message.from?.id),
        text: message.text as string,
        receivedAt: new Date((message.date ?? 0) * 1_000).toISOString()
      });
    }
    options.cursor.save("telegram", nextCursor);
  }

  async function initialTelegramPoll(signal: AbortSignal): Promise<number | undefined> {
    const stored = options.cursor.load("telegram");
    let offset = typeof stored === "number" ? stored : undefined;
    const response = await telegramRequest<TelegramUpdate[]>("getUpdates", {
      timeout: 0,
      allowed_updates: ["message"],
      ...(offset === undefined ? {} : { offset })
    }, signal);
    for (const update of response.result ?? []) {
      await processTelegramUpdate(update);
      if (Number.isInteger(update.update_id)) offset = (update.update_id as number) + 1;
    }
    return offset;
  }

  async function pollTelegram(signal: AbortSignal, initialOffset: number | undefined): Promise<void> {
    let offset = initialOffset;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const response = await telegramRequest<TelegramUpdate[]>("getUpdates", {
          timeout: 30,
          allowed_updates: ["message"],
          ...(typeof offset === "number" ? { offset } : {})
        }, signal, LONG_POLL_TIMEOUT_MS);
        setConnected("telegram", true);
        failures = 0;
        for (const update of response.result ?? []) {
          await processTelegramUpdate(update);
          if (Number.isInteger(update.update_id)) offset = (update.update_id as number) + 1;
        }
      } catch (error) {
        if (signal.aborted || abortError(error)) return;
        setConnected("telegram", false);
        failures += 1;
        await wait(Math.min(250 * (2 ** Math.min(failures - 1, 5)), 5_000), signal).catch(() => undefined);
      }
    }
  }

  async function processSlackEnvelope(socket: WebSocket, envelope: SlackEnvelope): Promise<void> {
    const envelopeId = envelope.envelope_id;
    if (typeof envelopeId !== "string") return;
    const event = envelope.payload?.event;
    const eventId = envelope.payload?.event_id;
    const valid = envelope.type === "events_api"
      && envelope.payload?.team_id === slackTeamId
      && typeof eventId === "string"
      && event?.type === "message"
      && event.channel === options.slackChannelId
      && typeof event.user === "string"
      && event.user !== slackBotUserId
      && typeof event.text === "string"
      && event.text.length > 0
      && event.text.length <= MAX_INPUT
      && event.bot_id === undefined
      && event.subtype === undefined;
    if (valid && eventId !== slackCursor) {
      const local: LocalMessage = {
        id: `slack:${slackTeamId}:${options.slackChannelId}:${eventId}`,
        channel: "slack",
        destination: options.slackChannelId,
        userId: event.user as string,
        text: event.text as string,
        receivedAt: new Date(Number.parseFloat(event.ts ?? "0") * 1_000).toISOString(),
        ...((event.thread_ts ?? event.ts) === undefined ? {} : { threadId: event.thread_ts ?? event.ts })
      };
      await options.onMessage(local);
    }
    if (typeof eventId === "string" && eventId !== slackCursor) {
      options.cursor.save("slack", eventId);
      slackCursor = eventId;
    }
    if (socket.readyState === 1) socket.send(JSON.stringify({ envelope_id: envelopeId }));
  }

  function attachSlackSocket(url: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = makeSocket(url);
      slackSocket = socket;
      let opened = false;
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error("Slack socket connection failed"));
        socket.close();
      }, REQUEST_TIMEOUT_MS);
      const onAbort = () => {
        finish();
        socket.close();
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        if (slackSocket === socket) slackSocket = undefined;
        if (error === undefined) resolve(); else reject(error);
      };
      socket.addEventListener("open", () => {
        opened = true;
        clearTimeout(timeout);
        setConnected("slack", true);
      }, { once: true });
      socket.addEventListener("message", (event) => {
        let envelope: SlackEnvelope;
        try {
          envelope = JSON.parse(String((event as MessageEvent).data)) as SlackEnvelope;
        } catch {
          return;
        }
        slackSerial = slackSerial.then(() => processSlackEnvelope(socket, envelope)).catch(() => undefined);
      });
      socket.addEventListener("error", () => {
        if (!opened) {
          finish(new Error("Slack socket connection failed"));
          socket.close();
        }
      }, { once: true });
      socket.addEventListener("close", () => {
        setConnected("slack", false);
        finish();
      }, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function runSlack(firstUrl: string, signal: AbortSignal): Promise<void> {
    let url = firstUrl;
    let failures = 0;
    while (!signal.aborted) {
      try {
        await attachSlackSocket(url, signal);
        if (signal.aborted) return;
        failures = 0;
      } catch (error) {
        if (signal.aborted || abortError(error)) return;
        setConnected("slack", false);
        failures += 1;
      }
      try {
        await wait(Math.min(250 * (2 ** Math.min(failures, 5)), 5_000), signal);
        url = await openSlackSocketUrl(signal);
      } catch (error) {
        if (signal.aborted || abortError(error)) return;
        failures += 1;
      }
    }
  }

  async function stop(): Promise<void> {
    controller?.abort();
    slackSocket?.close();
    await Promise.allSettled([telegramTask, slackTask, slackSerial]);
    telegramTask = undefined;
    slackTask = undefined;
    slackSocket = undefined;
    controller = undefined;
    starting = false;
    started = false;
    setConnected("telegram", false);
    setConnected("slack", false);
  }

  return {
    async start(): Promise<void> {
      if (started || starting) return;
      starting = true;
      try {
        controller = new AbortController();
        if (options.partialStart === true) {
          const signal = controller.signal;
          const independently = async (channel: Channel, connect: () => Promise<void>) => {
            while (!signal.aborted) {
              try { await connect(); } catch { setConnected(channel, false); }
              if (!signal.aborted) await wait(2000, signal).catch(() => undefined);
            }
          };
          telegramTask = independently("telegram", async () => {
            if (!telegramConfigured()) throw new Error("Telegram configuration is invalid");
            await validateTelegram(signal);
            const offset = await initialTelegramPoll(signal);
            setConnected("telegram", true);
            await pollTelegram(signal, offset);
          });
          slackTask = independently("slack", async () => {
            if (!slackConfigured()) throw new Error("Slack configuration is invalid");
            const url = await validateSlack(signal);
            const stored = options.cursor.load("slack");
            slackCursor = typeof stored === "string" ? stored : undefined;
            await runSlack(url, signal);
          });
          started = true;
          return;
        }
        validateConfiguration();
        await validateTelegram(controller.signal);
        const slackUrl = await validateSlack(controller.signal);
        const telegramOffset = await initialTelegramPoll(controller.signal);
        const storedSlackCursor = options.cursor.load("slack");
        slackCursor = typeof storedSlackCursor === "string" ? storedSlackCursor : undefined;
        setConnected("telegram", true);
        telegramTask = pollTelegram(controller.signal, telegramOffset);
        slackTask = runSlack(slackUrl, controller.signal);
        const deadline = Date.now() + 10_000;
        while (!slackConnected) {
          if (Date.now() >= deadline) throw new Error("Slack socket connection failed");
          await wait(5, controller.signal);
        }
        started = true;
      } catch (error) {
        await stop();
        if (abortError(error)) throw new Error("Local channel startup failed");
        throw error;
      } finally {
        starting = false;
      }
    },
    stop,
    async send(message: LocalMessage, text: string): Promise<void> {
      const output = truncated(text);
      if (message.channel === "telegram") {
        await telegramRequest("sendMessage", { chat_id: message.destination, text: output }, controller?.signal);
      } else {
        await slackRequest("chat.postMessage", options.slackBotToken, {
          channel: message.destination,
          text: output,
          ...(message.threadId === undefined ? {} : { thread_ts: message.threadId })
        }, controller?.signal);
      }
    },
    status: () => ({ slack: slackConnected, telegram: telegramConnected })
  };
}
