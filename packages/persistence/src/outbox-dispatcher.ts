import {
  OutboundDeliveryReceiptSchema,
  OutboundMessageSchema,
  type OutboundDeliveryFailure,
  type OutboundDeliveryPort,
  type OutboundMessage
} from "@orca-hq/core";
import { z } from "zod";

import { ControlStore, type JsonValue } from "./store.js";

type ChannelProvider = "slack" | "telegram" | "tailscale-web";
type OutboundProviders = Readonly<{
  slack?: OutboundDeliveryPort<"slack">;
  telegram?: OutboundDeliveryPort<"telegram">;
  "tailscale-web"?: OutboundDeliveryPort<"tailscale-web">;
}>;

export type OutboxDispatcherOptions = Readonly<{
  store: ControlStore;
  workerId: string;
  providers: OutboundProviders;
  slackHqDestination?: string;
}>;

const DEFAULT_RETRY_MS = 1_000;
const MAX_RETRY_MS = 5 * 60_000;
const SAFE_ERROR_CODE = /^[a-z0-9_.:-]{1,64}$/i;
const TelegramCompanyFinalPayloadSchema = z.object({
  text: z.string().min(1),
  replyToMessageId: z.number().int().optional(),
  taskId: z.string().min(1).optional(),
  companyWork: z.literal(true),
  redactedSummary: z.string().min(1),
  sensitive: z.boolean().optional()
}).strict();

export class OutboxDispatcher {
  readonly #store: ControlStore;
  readonly #workerId: string;
  readonly #providers: OutboundProviders;
  readonly #slackHqDestination: string | undefined;

  constructor(options: OutboxDispatcherOptions) {
    if (options.workerId.length === 0) throw new Error("Outbox worker ID is required");
    this.#store = options.store;
    this.#workerId = options.workerId;
    this.#providers = options.providers;
    this.#slackHqDestination = options.slackHqDestination;
  }

  async tick(nowInput: string): Promise<void> {
    const now = new Date(nowInput).toISOString();
    const claimed = this.#store.claimOutbox(now, this.#workerId);
    if (claimed === undefined) return;

    const message = OutboundMessageSchema.parse({
      id: claimed.id,
      ...(claimed.commandId === undefined ? {} : { commandId: claimed.commandId }),
      channel: claimed.channel,
      destination: claimed.destination,
      template: claimed.template,
      payload: claimed.payload,
      attempts: claimed.attempts,
      nextAttemptAt: claimed.nextAttemptAt
    });
    try {
      this.#prepareSlackHqMirror(message, now);
      const receipt = OutboundDeliveryReceiptSchema.parse(await this.#deliver(message));
      this.#store.markOutboxDelivered(message.id, receipt.providerMessageId, now);
      if (message.commandId !== undefined) {
        this.#store.appendAudit({
          id: `${message.id}:delivered-audit`,
          subjectId: message.commandId,
          eventType: "outbox.delivered",
          data: { messageId: message.id, channel: message.channel }
        });
      }
    } catch (error) {
      const failure = normalizeDeliveryFailure(error);
      if (failure.retryable) {
        const retryDelayMs = failure.retryAfterMs ?? retryDelay(message.attempts);
        this.#store.rescheduleOutbox(message.id, {
          nextAttemptAt: new Date(new Date(now).getTime() + retryDelayMs).toISOString(),
          lastError: failure as JsonValue
        }, now);
      } else {
        this.#store.markOutboxFailed(message.id, {
          channel: message.channel,
          attempts: message.attempts,
          failure: failure as JsonValue
        }, now);
      }
    }
  }

  #deliver(message: OutboundMessage) {
    switch (message.channel) {
      case "slack":
        return requiredProvider(this.#providers.slack).deliver({ ...message, channel: "slack" });
      case "telegram":
        return requiredProvider(this.#providers.telegram).deliver({ ...message, channel: "telegram" });
      case "tailscale-web":
        return requiredProvider(this.#providers["tailscale-web"]).deliver({
          ...message,
          channel: "tailscale-web"
        });
    }
  }

  #prepareSlackHqMirror(message: OutboundMessage, now: string): void {
    if (message.channel !== "telegram" || message.template !== "final_summary") return;
    const payloadRecord = typeof message.payload === "object" && message.payload !== null
      && !Array.isArray(message.payload)
      ? message.payload
      : undefined;
    if (payloadRecord?.companyWork !== true) return;

    const payload = TelegramCompanyFinalPayloadSchema.safeParse(message.payload);
    if (!payload.success) {
      this.#recordMirrorFailure(message, "invalid_company_final_summary");
      return;
    }
    if (this.#slackHqDestination === undefined || this.#slackHqDestination.length === 0) {
      this.#recordMirrorFailure(message, "slack_hq_not_configured");
      return;
    }

    try {
      this.#store.enqueueOutbox({
        id: `${message.id}:slack-hq`,
        ...(message.commandId === undefined ? {} : { commandId: message.commandId }),
        channel: "slack",
        destination: this.#slackHqDestination,
        template: "final_summary",
        payload: { text: payload.data.redactedSummary },
        nextAttemptAt: now
      });
    } catch {
      this.#recordMirrorFailure(message, "mirror_enqueue_failed");
    }
  }

  #recordMirrorFailure(message: OutboundMessage, code: string): void {
    try {
      this.#store.appendAudit({
        subjectId: `${message.id}:slack-hq`,
        eventType: "outbox.mirror_failed",
        data: {
          originMessageId: message.id,
          channel: "slack",
          failure: { code, retryable: false }
        }
      });
    } catch {
      // Mirror observability cannot make an independently deliverable origin retry or fail.
    }
  }
}

function requiredProvider<C extends ChannelProvider>(
  provider: OutboundDeliveryPort<C> | undefined
): OutboundDeliveryPort<C> {
  if (provider !== undefined) return provider;
  throw Object.assign(new Error("provider_not_configured"), {
    code: "provider_not_configured",
    retryable: true
  });
}

function retryDelay(attempts: number): number {
  return Math.min(DEFAULT_RETRY_MS * (2 ** Math.max(attempts - 1, 0)), MAX_RETRY_MS);
}

function normalizeDeliveryFailure(error: unknown): OutboundDeliveryFailure {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
  const candidateCode = record?.code;
  const code = typeof candidateCode === "string" && SAFE_ERROR_CODE.test(candidateCode)
    ? candidateCode
    : "provider_delivery_failed";
  const retryAfterMs = record?.retryAfterMs;
  return Object.freeze({
    code,
    retryable: record?.retryable !== false,
    ...(typeof retryAfterMs === "number" && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
      ? { retryAfterMs }
      : {})
  });
}
