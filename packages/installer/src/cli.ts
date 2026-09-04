#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDoctor, doctorExitCode, type DoctorPorts } from "./doctor.js";
import { createMacosHostAdapters, type HostAdapters } from "./host.js";
import {
  createLaunchdOperations,
  createNodeLaunchdPort,
  defaultLaunchdPaths,
  type LaunchdOperations
} from "./launchd.js";
import { createDefaultLifecycleHostComposition, type LifecycleComposition } from "./lifecycle-host.js";
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
  readonly launchd?: LaunchdOperations;
  readonly lifecycle?: LifecycleComposition;
  readonly lifecycleFactory?: () => Promise<LifecycleComposition>;
}

function write(output: Pick<typeof process.stdout, "write">, text: string): void {
  output.write(`${text}\n`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
  if (selected === "start" || selected === "stop" || selected === "status") {
    const launchd = dependencies.launchd
      ?? createLaunchdOperations(defaultLaunchdPaths(), createNodeLaunchdPort());
    try {
      if (selected === "start") {
        await launchd.install();
        if ((await launchd.status()).state !== "running") await launchd.start();
        write(output, "Orca HQ gateway started.");
        return 0;
      }
      if (selected === "stop") {
        await launchd.stop();
        write(output, "Orca HQ gateway stopped.");
        return 0;
      }
      const status = await launchd.status();
      write(output, JSON.stringify(status));
      return status.state === "stopped" ? 1 : 0;
    } catch {
      write(output, "Gateway service operation failed.");
      return 1;
    }
  }
  if (selected === "update" || selected === "uninstall") {
    if (selected === "update" && (input.length !== 3 || input[1] !== "--revision" || input[2] === undefined)) {
      write(output, "Usage: hq update --revision <full-commit-sha>");
      return 2;
    }
    const uninstallSyntaxValid = input.length === 1
      || (input.length === 2 && input[1] === "--remove-data")
      || (input.length === 3 && input[1] === "--confirm" && input[2] !== undefined)
      || (input.length === 4 && input[1] === "--remove-data" && input[2] === "--confirm" && input[3] !== undefined);
    if (selected === "uninstall" && !uninstallSyntaxValid) {
      write(output, "Usage: hq uninstall [--confirm <exact-program-phrase> | --remove-data [--confirm <exact-program-and-data-phrase>]]");
      return 2;
    }
    try {
      const lifecycle = dependencies.lifecycle
        ?? await (dependencies.lifecycleFactory ?? (() => createDefaultLifecycleHostComposition({ doctor: host.doctor })))();
      if (selected === "update") {
        const result = await lifecycle.update.run({ revision: input[2]! });
        write(output, JSON.stringify({
          previousRevision: result.previousRevision,
          revision: result.revision,
          backupId: result.backup.id
        }));
        return 0;
      }
      if (input.length === 1) {
        write(output, `Program path: ${lifecycle.uninstall.programPath}`);
        write(output, `Confirmation required: ${lifecycle.uninstall.programConfirmationPhrase}`);
        write(output, `Re-run: pnpm hq uninstall --confirm ${shellQuote(lifecycle.uninstall.programConfirmationPhrase)}`);
        return 2;
      }
      if (input.length === 2 && input[1] === "--remove-data") {
        write(output, `Program path: ${lifecycle.uninstall.programPath}`);
        write(output, `Data path: ${lifecycle.uninstall.dataPath}`);
        write(output, `Confirmation required: ${lifecycle.uninstall.dataConfirmationPhrase}`);
        write(output, `Re-run: pnpm hq uninstall --remove-data --confirm ${shellQuote(lifecycle.uninstall.dataConfirmationPhrase)}`);
        return 2;
      }
      if (input.length === 3 && input[1] === "--confirm" && input[2] !== undefined) {
        await lifecycle.uninstall.run({ removeData: false, confirmation: input[2] });
      } else if (input.length === 4 && input[1] === "--remove-data" && input[2] === "--confirm" && input[3] !== undefined) {
        await lifecycle.uninstall.run({ removeData: true, confirmation: input[3] });
      } else {
        write(output, "Usage: hq uninstall [--confirm <exact-program-phrase> | --remove-data [--confirm <exact-program-and-data-phrase>]]");
        return 2;
      }
      write(output, "Orca HQ lifecycle uninstall completed.");
      return 0;
    } catch (error) {
      write(output, (error as { code?: unknown }).code === "lifecycle_config_invalid"
        ? "Lifecycle configuration is missing or invalid; run hq setup to create or migrate it."
        : "Lifecycle operation failed.");
      return 1;
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
