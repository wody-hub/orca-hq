import { z } from "zod";

export interface ConfigFilePort {
  readonly path: string;
  preview(text: string): Promise<void>;
  write(text: string): Promise<void>;
}

const ConfigSchema = z.object({
  schema: z.literal("orca-hq.private-pilot.v1"),
  projectRegistryPath: z.string().min(1),
  credentialAccounts: z.array(z.string().min(1))
}).strict();

export type PilotConfig = z.infer<typeof ConfigSchema>;

/** Produces the only persisted setup configuration; credential values are excluded by construction. */
export function createConfigText(input: PilotConfig): string {
  return `${JSON.stringify(ConfigSchema.parse(input), null, 2)}\n`;
}
