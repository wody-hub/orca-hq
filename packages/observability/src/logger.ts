import pino, { type DestinationStream, type Logger } from "pino";

import { REDACTED_VALUE, redactDeep, type RedactionOptions } from "./redaction.js";

export const REDACT_PATHS = Object.freeze([
  "authorization", "*.authorization",
  "token", "*.token",
  "cookie", "*.cookie",
  "voiceUrl", "*.voiceUrl",
  "signedUrl", "*.signedUrl",
  "prompt", "*.prompt",
  "transcript", "*.transcript"
]);

export function safeErrorSerializer(
  error: unknown,
  options: RedactionOptions = {}
): { type: string; name: string; code?: string | number; message: string } {
  if (!(error instanceof Error)) {
    return { type: "Unknown", name: "Unknown", message: REDACTED_VALUE };
  }

  const code = (error as Error & { code?: unknown }).code;
  const serialized = {
    type: error.name,
    name: error.name,
    message: redactMessage(error.message, options)
  };
  return typeof code === "string" || typeof code === "number"
    ? { ...serialized, code }
    : serialized;
}

function redactMessage(message: string, options: RedactionOptions): string {
  const redacted = redactDeep(message, options);
  return typeof redacted === "string" ? redacted : REDACTED_VALUE;
}

export function createLogger(
  destination?: DestinationStream,
  redactionOptions: RedactionOptions = {}
): Logger {
  return pino({
    redact: { paths: [...REDACT_PATHS], censor: REDACTED_VALUE },
    formatters: {
      log: (payload) => redactDeep(payload, redactionOptions) as Record<string, unknown>
    },
    serializers: { err: (error) => safeErrorSerializer(error, redactionOptions) },
    base: { service: "orca-hq" }
  }, destination);
}
