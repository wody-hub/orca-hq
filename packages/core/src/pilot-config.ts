import { join, normalize, isAbsolute } from "node:path";

import { z } from "zod";

const AbsolutePathSchema = z.string().trim().min(1).refine(isAbsolute, "must be an absolute path").transform(normalize);

export const PilotConfigSchema = z.object({
  schema: z.literal("orca-hq.private-pilot.v1"),
  databasePath: AbsolutePathSchema,
  projectRegistryPath: AbsolutePathSchema,
  credentialAccounts: z.array(z.string().trim().min(1))
}).strict();

export const LegacyPilotConfigSchema = z.object({
  schema: z.literal("orca-hq.private-pilot.v1"),
  projectRegistryPath: AbsolutePathSchema,
  credentialAccounts: z.array(z.string().trim().min(1))
}).strict();

export type PilotConfig = z.infer<typeof PilotConfigSchema>;
export type LegacyPilotConfig = z.infer<typeof LegacyPilotConfigSchema>;
export type PilotConfigInspection =
  | Readonly<{ status: "missing" | "invalid" }>
  | Readonly<{ status: "legacy"; config: LegacyPilotConfig }>
  | Readonly<{ status: "current"; config: PilotConfig }>;

export function validatePilotConfig(input: unknown): PilotConfig {
  return Object.freeze(PilotConfigSchema.parse(input));
}

export function parsePilotConfigText(text: string): PilotConfig {
  return validatePilotConfig(JSON.parse(text) as unknown);
}

export function inspectPilotConfigText(text: string | undefined): PilotConfigInspection {
  if (text === undefined) return Object.freeze({ status: "missing" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return Object.freeze({ status: "invalid" });
  }
  const current = PilotConfigSchema.safeParse(parsed);
  if (current.success) return Object.freeze({ status: "current", config: Object.freeze(current.data) });
  const legacy = LegacyPilotConfigSchema.safeParse(parsed);
  return legacy.success
    ? Object.freeze({ status: "legacy", config: Object.freeze(legacy.data) })
    : Object.freeze({ status: "invalid" });
}

export function pilotConfigurationPath(input: Readonly<{
  homeDirectory: string;
  configDirectory?: string | undefined;
}>): string {
  return join(input.configDirectory ?? join(input.homeDirectory, ".config"), "orca-hq", "pilot.json");
}

export function defaultPilotDataDirectory(homeDirectory: string): string {
  return join(homeDirectory, "Library/Application Support/orca-hq");
}

export function defaultPilotDatabasePath(homeDirectory: string): string {
  return join(defaultPilotDataDirectory(homeDirectory), "control.sqlite");
}
