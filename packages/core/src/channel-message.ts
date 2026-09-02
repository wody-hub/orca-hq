import { z } from "zod";

export type ChannelMessageJson =
  | null
  | boolean
  | number
  | string
  | ChannelMessageJson[]
  | { [key: string]: ChannelMessageJson };

function isChannelMessageJson(
  value: unknown,
  ancestors: Set<object>
): value is ChannelMessageJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  if (Array.isArray(value)) {
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isChannelMessageJson(value[index], ancestors)) {
        ancestors.delete(value);
        return false;
      }
    }
    ancestors.delete(value);
    return Reflect.ownKeys(value).every((key) => key === "length" || (
      typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length
    ));
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;

  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !isChannelMessageJson(
      (value as Record<string, unknown>)[key],
      ancestors
    )) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

export const ChannelMessageJsonSchema = z.custom<ChannelMessageJson>(
  (value): value is ChannelMessageJson => isChannelMessageJson(value, new Set()),
  { message: "must be a lossless JSON value" }
);

export const OutboundMessageSchema = z.object({
  id: z.string().min(1),
  commandId: z.string().min(1).optional(),
  channel: z.enum(["slack", "telegram", "tailscale-web"]),
  destination: z.string().min(1),
  template: z.string().min(1),
  payload: ChannelMessageJsonSchema,
  attempts: z.number().int().positive(),
  nextAttemptAt: z.string().datetime()
}).strict();

export const OutboundDeliveryReceiptSchema = z.object({
  providerMessageId: z.string().min(1)
}).strict();

export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;
export type OutboundDeliveryReceipt = z.infer<typeof OutboundDeliveryReceiptSchema>;
export type OutboundMessageFor<C extends OutboundMessage["channel"]> =
  Omit<OutboundMessage, "channel"> & Readonly<{ channel: C }>;

export class InvalidOutboundMessageError extends Error {
  readonly code = "invalid_outbound_message";
  readonly retryable = false;

  constructor() {
    super("invalid_outbound_message");
    this.name = "InvalidOutboundMessageError";
  }
}

export type OutboundDeliveryFailure = Readonly<{
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
}>;

export type OutboundDeliveryPort<
  C extends OutboundMessage["channel"] = OutboundMessage["channel"]
> = Readonly<{
  deliver(message: OutboundMessageFor<C>): Promise<OutboundDeliveryReceipt>;
}>;
