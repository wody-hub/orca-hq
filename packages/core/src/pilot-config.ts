import { join, normalize, isAbsolute } from "node:path";

import { z } from "zod";

import { LaunchProfileSchema } from "./native-work.js";

const AbsolutePathSchema = z.string().trim().min(1).refine(isAbsolute, "must be an absolute path").transform(normalize);

/**
 * All fields are optional so an existing installed config without this block keeps working; the
 * runtime falls back to its own defaults (10 active workers, a single "primary" codex profile,
 * "retain" completed-primary terminals) exactly where a field here is absent.
 */
export const NativeExecutionConfigSchema = z.object({
  // `.safe()` matters: the admission gate itself rejects a non-safe integer with a bare TypeError
  // at startup, so an out-of-range limit has to fail here as a named configuration error instead.
  maxActiveWorkers: z.union([z.literal("unlimited"), z.number().int().positive().safe()]).optional(),
  retentionPolicy: z.enum(["retain", "release"]).optional(),
  roleProfiles: z.record(z.string().trim().min(1).max(128), LaunchProfileSchema).optional()
}).strict().superRefine((value, ctx) => {
  // Declaring role profiles replaces the built-in default set wholesale, so a set without
  // "primary" would leave the runtime with no profile to launch substantive work with. Rejecting
  // it here turns that into a configuration error rather than a startup crash.
  if (value.roleProfiles !== undefined && value.roleProfiles.primary === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "native_profile_primary_required",
      path: ["roleProfiles"]
    });
  }
});

export const PilotConfigSchema = z.object({
  schema: z.literal("orca-hq.private-pilot.v1"),
  databasePath: AbsolutePathSchema,
  voiceMode: z.enum(["disabled", "openai"]).optional(),
  projectRegistryPath: AbsolutePathSchema,
  credentialAccounts: z.array(z.string().trim().min(1)),
  nativeExecution: NativeExecutionConfigSchema.optional()
}).strict();

export type NativeExecutionConfig = z.infer<typeof NativeExecutionConfigSchema>;

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
