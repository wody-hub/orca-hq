import type { TelegramAdapter, TelegramCursorStore } from "./index.js";

export type TelegramUpdatesPort = Readonly<{
  getUpdates(request: Readonly<{
    offset: number | undefined;
    timeoutSeconds: number;
    signal: AbortSignal;
  }>): Promise<readonly unknown[]>;
}>;

export class TelegramRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Telegram rate limited; retry after ${retryAfterSeconds} seconds`);
    this.name = "TelegramRateLimitError";
  }
}

export type TelegramPollingOptions = Readonly<{
  adapter: TelegramAdapter;
  cursorStore: TelegramCursorStore;
  updates: TelegramUpdatesPort;
  signal: AbortSignal;
  timeoutSeconds?: number | undefined;
  maxConsecutiveFailures?: number | undefined;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}>;

function delayFor(error: unknown, failures: number, random: () => number): number {
  if (error instanceof TelegramRateLimitError) return error.retryAfterSeconds * 1_000;
  const maximum = Math.min(30_000, 250 * 2 ** Math.max(0, failures - 1));
  return Math.floor(random() * maximum);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Telegram polling aborted", "AbortError"));
    }, { once: true });
  });
}

/** Long-polls an injected authenticated provider port; the adapter neither opens a server nor retains credentials. */
export async function pollTelegramUpdates(options: TelegramPollingOptions): Promise<void> {
  const timeoutSeconds = options.timeoutSeconds ?? 30;
  const maxFailures = options.maxConsecutiveFailures ?? 5;
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;
  let failures = 0;

  while (!options.signal.aborted) {
    try {
      const offset = await options.cursorStore.load("telegram");
      const updates = await options.updates.getUpdates({ offset, timeoutSeconds, signal: options.signal });
      failures = 0;
      for (const update of updates) {
        if (options.signal.aborted) return;
        await options.adapter.handleUpdate(update);
      }
    } catch (error) {
      if (options.signal.aborted) return;
      failures += 1;
      if (failures > maxFailures) throw error;
      await wait(delayFor(error, failures, random), options.signal);
    }
  }
}
