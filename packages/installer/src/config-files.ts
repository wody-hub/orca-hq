import { validatePilotConfig, type PilotConfig } from "@orca-hq/core";

export interface ConfigFilePort {
  readonly path: string;
  preview(text: string): Promise<void>;
  write(text: string): Promise<void>;
}

export type { PilotConfig } from "@orca-hq/core";

/** Produces the only persisted setup configuration; credential values are excluded by construction. */
export function createConfigText(input: PilotConfig): string {
  return `${JSON.stringify(validatePilotConfig(input), null, 2)}\n`;
}
