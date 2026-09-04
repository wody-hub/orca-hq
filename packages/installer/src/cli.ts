import { fileURLToPath } from "node:url";

import { createDoctor, doctorExitCode, type DoctorPorts } from "./doctor.js";
import { createSetup, type SetupAnswers, type SetupPorts } from "./setup.js";

const commandNames = ["setup", "doctor", "start", "stop", "status", "logs", "update", "uninstall"] as const;
type CommandName = (typeof commandNames)[number];

export interface CliDependencies {
  readonly doctor?: DoctorPorts;
  readonly setup?: SetupPorts;
  readonly stdout?: Pick<typeof process.stdout, "write">;
  readonly setupAnswers?: SetupAnswers;
}

function unavailablePorts(): DoctorPorts {
  const unavailable = async () => "fail" as const;
  return {
    checks: {
      macosCpu: unavailable, nodePnpm: unavailable, orcaCapabilities: unavailable,
      codexAuthentication: unavailable, claudeAuthentication: unavailable, tailscaleTailnet: unavailable,
      slackSocketMode: unavailable, telegramAllowlistedChat: unavailable, openAiVoice: unavailable,
      keychain: unavailable, sqliteDirectory: unavailable, launchd: unavailable, projectDiscovery: unavailable
    },
    registry: { review: async () => ({ status: "fail", curatedProjects: 0 }) }
  };
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
    const result = await createDoctor(dependencies.doctor ?? unavailablePorts()).run({ format: "json" });
    write(output, JSON.stringify(result));
    return doctorExitCode(result);
  }
  if (selected === "setup") {
    if (dependencies.setup === undefined || dependencies.setupAnswers === undefined) {
      write(output, "hq setup requires injected setup adapters and answers.");
      return 1;
    }
    const result = await createSetup(dependencies.setup).run(dependencies.setupAnswers);
    return result.ok ? 0 : 1;
  }
  write(output, `hq ${selected} is reserved for the private-pilot service adapter.`);
  return 1;
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
