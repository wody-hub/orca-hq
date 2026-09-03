import { z } from "zod";

const GatewayConfigSchema = z.object({
  databasePath: z.string().trim().min(1),
  shutdownDrainMs: z.number().int().positive().max(5 * 60_000).default(30_000),
  httpPort: z.number().int().min(0).max(65_535).default(4_310),
  allowEphemeralHttpPortForTests: z.boolean().default(false),
  outboxPollMs: z.number().int().positive().max(60_000).default(50),
  outboxMaxBackoffMs: z.number().int().positive().max(5 * 60_000).default(5_000),
  outboxClaimTtlMs: z.number().int().positive().max(60 * 60_000).default(60_000)
}).strict().superRefine((config, context) => {
  if (config.httpPort === 0 && !config.allowEphemeralHttpPortForTests) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["httpPort"],
      message: "ephemeral HTTP port is test-only"
    });
  }
  if (config.outboxMaxBackoffMs < config.outboxPollMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outboxMaxBackoffMs"],
      message: "Outbox maximum backoff must cover its poll interval"
    });
  }
});

export type GatewayConfig = z.input<typeof GatewayConfigSchema>;
export type ValidatedGatewayConfig = z.output<typeof GatewayConfigSchema>;

/**
 * Validates only non-secret process configuration. Secret material remains behind
 * the injected Keychain-backed runtime port and is never copied into this value.
 */
export function validateGatewayConfig(input: GatewayConfig): ValidatedGatewayConfig {
  return Object.freeze(GatewayConfigSchema.parse(input));
}
