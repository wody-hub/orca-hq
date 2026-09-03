import type { OutboxDispatcher } from "@orca-hq/persistence";

import type { GatewayDiagnostic, GatewayOutboxPort } from "./lifecycle.js";

type Timer = ReturnType<typeof setTimeout>;

export type GatewayOutboxDriverOptions = Readonly<{
  dispatcher: Pick<OutboxDispatcher, "tick">;
  now: () => Date;
  pollMs: number;
  maxBackoffMs: number;
  auditFailure(): Promise<void> | void;
}>;

/** Lifecycle-owned single-flight scheduler for the durable Outbox dispatcher. */
export class GatewayOutboxDriver implements GatewayOutboxPort {
  readonly #dispatcher: Pick<OutboxDispatcher, "tick">;
  readonly #now: () => Date;
  readonly #pollMs: number;
  readonly #maxBackoffMs: number;
  readonly #auditFailure: () => Promise<void> | void;
  #running = false;
  #timer: Timer | undefined;
  #inFlight: Promise<void> | undefined;
  #nextDelayMs: number;
  #failureReported = false;
  #reportDiagnostic: ((diagnostic: GatewayDiagnostic) => void) | undefined;

  constructor(options: GatewayOutboxDriverOptions) {
    this.#dispatcher = options.dispatcher;
    this.#now = options.now;
    this.#pollMs = options.pollMs;
    this.#maxBackoffMs = options.maxBackoffMs;
    this.#auditFailure = options.auditFailure;
    this.#nextDelayMs = options.pollMs;
  }

  async start(reportDiagnostic: (diagnostic: GatewayDiagnostic) => void): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#reportDiagnostic = reportDiagnostic;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#inFlight;
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#inFlight = this.#tick();
    }, delayMs);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    try {
      await this.#dispatcher.tick(this.#now().toISOString());
      this.#nextDelayMs = this.#pollMs;
      this.#failureReported = false;
    } catch {
      if (!this.#failureReported) {
        this.#failureReported = true;
        this.#reportDiagnostic?.({ component: "outbox", code: "outbox_tick_failed" });
      }
      try {
        await this.#auditFailure();
      } catch {
        // An observability failure cannot terminate or recursively fail the driver.
      }
      this.#nextDelayMs = Math.min(
        this.#maxBackoffMs,
        Math.max(this.#pollMs, this.#nextDelayMs * 2)
      );
    } finally {
      this.#inFlight = undefined;
      this.#schedule(this.#nextDelayMs);
    }
  }
}
