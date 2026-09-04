#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDoctor, doctorExitCode, type DoctorPorts } from "./doctor.js";
import { createMacosHostAdapters, type HostAdapters } from "./host.js";
import { createTerminalPrompt, type GuidedPromptPort } from "./prompt.js";
import { createSetup, type SetupPorts } from "./setup.js";

export type { HostAdapters } from "./host.js";

const commandNames = ["setup", "doctor", "start", "stop", "status", "logs", "update", "uninstall"] as const;
type CommandName = (typeof commandNames)[number];

export interface CliDependencies {
  readonly doctor?: DoctorPorts;
  readonly setup?: SetupPorts;
  readonly stdout?: Pick<typeof process.stdout, "write">;
  readonly host?: HostAdapters;
  readonly prompt?: GuidedPromptPort;
}

function write(output: Pick<typeof process.stdout, "write">, text: string): void {
  output.write(`${text}\n`);
}

function command(input: readonly string[]): CommandName | undefined {
  const candidate = input[0];
  return commandNames.includes(candidate as CommandName) ? candidate as CommandName : undefined;
}

export async function runCli(input: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const output = dependencies.stdout ?? process.stdout;
  const host = dependencies.host ?? createMacosHostAdapters();
  const selected = command(input);
  if (selected === undefined) {
    write(output, `Usage: hq ${commandNames.join("|")}`);
    return 2;
  }
  if (selected === "doctor") {
    const format = input[1] === "--format" ? input[2] : undefined;
    if (format !== "json") {
      write(output, "hq doctor requires --format json");
      return 2;
    }
    const result = await createDoctor(dependencies.doctor ?? host.doctor).run({ format: "json" });
    write(output, JSON.stringify(result));
    return doctorExitCode(result);
  }
  if (selected === "setup") {
    const prompt = dependencies.prompt ?? createTerminalPrompt();
    try {
      const answers = await prompt.collectSetupAnswers();
      const setup = dependencies.setup ?? host.setup({ write: (text) => write(output, text) }, () => prompt.confirm(), answers);
      const result = await createSetup(setup).run(answers);
      return result.ok ? 0 : 1;
    } catch {
      write(output, "Setup failed while applying configuration.");
      return 1;
    } finally {
      prompt.close();
    }
  }
  write(output, `hq ${selected} is reserved for the private-pilot service adapter.`);
  return 1;
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
