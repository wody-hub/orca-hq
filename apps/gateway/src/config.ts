import { z } from "zod";

const GatewayConfigSchema = z.object({
  databasePath: z.string().trim().min(1),
  shutdownDrainMs: z.number().int().positive().max(5 * 60_000).default(30_000)
}).strict();

export type GatewayConfig = z.input<typeof GatewayConfigSchema>;
export type ValidatedGatewayConfig = z.output<typeof GatewayConfigSchema>;

/**
 * Validates only non-secret process configuration. Secret material remains behind
 * the injected Keychain-backed runtime port and is never copied into this value.
 */
export function validateGatewayConfig(input: GatewayConfig): ValidatedGatewayConfig {
  return Object.freeze(GatewayConfigSchema.parse(input));
}
