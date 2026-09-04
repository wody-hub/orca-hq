import { join, normalize, isAbsolute } from "node:path";

import { z } from "zod";

const AbsolutePathSchema = z.string().trim().min(1).refine(isAbsolute, "must be an absolute path").transform(normalize);

export const PilotConfigSchema = z.object({
  schema: z.literal("orca-hq.private-pilot.v1"),
  databasePath: AbsolutePathSchema,
  projectRegistryPath: AbsolutePathSchema,
  credentialAccounts: z.array(z.string().trim().min(1))
}).strict();

export type PilotConfig = z.infer<typeof PilotConfigSchema>;

export function validatePilotConfig(input: unknown): PilotConfig {
  return Object.freeze(PilotConfigSchema.parse(input));
}

export function parsePilotConfigText(text: string): PilotConfig {
  return validatePilotConfig(JSON.parse(text) as unknown);
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
