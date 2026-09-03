import pino, { type DestinationStream, type Logger } from "pino";

import { REDACTED_VALUE } from "./redaction.js";

export const REDACT_PATHS = Object.freeze([
  "authorization", "*.authorization",
  "token", "*.token",
  "cookie", "*.cookie",
  "voiceUrl", "*.voiceUrl",
  "signedUrl", "*.signedUrl",
  "prompt", "*.prompt",
  "transcript", "*.transcript"
]);

export function safeErrorSerializer(error: unknown): { type: string; message: string } {
  return {
    type: error instanceof Error ? error.name : "Error",
    message: REDACTED_VALUE
  };
}

export function createLogger(destination?: DestinationStream): Logger {
  return pino({
    redact: { paths: [...REDACT_PATHS], censor: REDACTED_VALUE },
    serializers: { err: safeErrorSerializer },
    base: { service: "orca-hq" }
  }, destination);
}
