#!/usr/bin/env node

import type { Readable } from "node:stream";
import { runChat } from "./chat.js";
import { createProgressClient, validProgressIdentifier, type ProgressClient } from "./progress-client.js";
import { runWatch } from "./watch.js";
import type { ProgressWindowManager, ProgressWindowMode } from "./progress-window.js";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { createCredentialCommand, credentialAccounts, type CredentialOperations } from "./credential.js";
import { createDoctor, doctorExitCode, type DoctorPorts } from "./doctor.js";
import {
  configurationPath,
  createMacosHostAdapters,
  createNodeMachine,
  type HostAdapters,
  type HostMachinePort
} from "./host.js";
import {
  createLaunchdOperations,
  createNodeLaunchdPort,
  defaultLaunchdPaths,
  type LaunchdOperations
} from "./launchd.js";
import { createDefaultLifecycleHostComposition, type LifecycleComposition } from "./lifecycle-host.js";
import { createSecretPrompt, createTerminalPrompt, type GuidedPromptPort, type SecretPromptPort } from "./prompt.js";
import { createHttpReadinessProbe, type GatewayReadinessProbe } from "./readiness.js";
import { createSetup, type SetupPorts } from "./setup.js";
import { createControlClient, validSessionId, type ControlClientOptions, type ControlClient } from "./control.js";

export type { HostAdapters } from "./host.js";

const commandNames = [
  "setup", "credential", "doctor", "start", "stop", "status", "logs", "update", "uninstall",
  "ask", "chat", "watch", "projects", "run", "jobs"
] as const;
type CommandName = (typeof commandNames)[number];

export interface CliDependencies {
  readonly doctor?: DoctorPorts;
  readonly setup?: SetupPorts;
  readonly stdout?: Pick<typeof process.stdout, "write">;
  readonly host?: HostAdapters;
  readonly prompt?: GuidedPromptPort;
  readonly launchd?: LaunchdOperations;
  readonly readiness?: GatewayReadinessProbe;
  readonly credential?: CredentialOperations;
  readonly credentialMachine?: HostMachinePort;
  readonly credentialPrompt?: SecretPromptPort;
  readonly lifecycle?: LifecycleComposition;
  readonly lifecycleFactory?: () => Promise<LifecycleComposition>;
  readonly control?: ControlClient;
  readonly controlFactory?: (options: ControlClientOptions) => ControlClient;
  readonly stdin?: Readable;
  readonly progress?: ProgressClient;
  readonly progressWindows?: ProgressWindowManager;
  readonly signal?: AbortSignal;
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

type StructuredControlCommand = Readonly<{
  action: string;
  project?: string;
  path?: string;
  alias?: string;
  jobId?: string;
  prompt?: string;
  worktree?: string;
}>;

function structuredControlCommand(input: readonly string[]): StructuredControlCommand | undefined {
  if (input[0] === "projects") {
    if (input.length === 1 || (input.length === 2 && input[1] === "list")) return { action: "projects.list" };
    if (input.length === 2 && input[1] === "sync") return { action: "projects.sync" };
    if (input.length === 3 && input[1] === "add" && input[2] !== undefined && isAbsolute(input[2])) {
      return { action: "projects.add", path: input[2] };
    }
    if (input.length === 4 && input[1] === "alias" && input[2] !== undefined && input[3] !== undefined) {
      return { action: "projects.alias", project: input[2], alias: input[3] };
    }
    if (input.length === 3 && (input[1] === "exclude" || input[1] === "restore") && input[2] !== undefined) {
      return { action: `projects.${input[1]}`, project: input[2] };
    }
    if (input.length === 3 && (input[1] === "activity" || input[1] === "review") && input[2] !== undefined) {
      return { action: `projects.${input[1]}`, project: input[2] };
    }
    return undefined;
  }
  if (input[0] === "run") {
    if (input.length >= 5 && input[1] === "--project" && input[2] !== undefined && input[3] === "--prompt") {
      const tail = input.slice(4);
      const worktreeFlag = tail.indexOf("--worktree");
      if (worktreeFlag >= 0) {
        const worktree = tail[worktreeFlag + 1];
        const prompt = tail.slice(0, worktreeFlag).join(" ").trim();
        if (worktreeFlag === tail.length - 2 && worktree !== undefined && worktree.trim() !== "" && prompt !== "") {
          return { action: "jobs.run", project: input[2], prompt, worktree };
        }
        return undefined;
      }
      const prompt = tail.join(" ").trim();
      if (prompt !== "") return { action: "jobs.run", project: input[2], prompt };
    }
    return undefined;
  }
  if (input[0] === "jobs") {
    if (input.length === 1 || (input.length === 2 && input[1] === "list")) return { action: "jobs.list" };
    if (input.length === 3 && ["show", "stop", "retry"].includes(input[1] ?? "") && input[2] !== undefined) {
      return { action: `jobs.${input[1]}`, jobId: input[2] };
    }
    if (input.length >= 4 && input[1] === "followup" && input[2] !== undefined
      && input.slice(3).join(" ").trim() !== "") {
      return { action: "jobs.followup", jobId: input[2], prompt: input.slice(3).join(" ") };
    }
  }
  return undefined;
}

function terminalUsage(selected: "ask" | "chat" | "watch" | "projects" | "run" | "jobs"): string {
  if (selected === "ask") return "사용법: hq ask [--session ID] <질문>";
  if (selected === "chat") return "사용법: hq chat [--session ID] [--progress-window=auto|off]";
  if (selected === "watch") return "사용법: hq watch --context ID [--viewer-instance ID --lease-token TOKEN]";
  if (selected === "projects") {
    return "사용법: hq projects [list|sync|add <절대경로>|alias <프로젝트> <별칭>|exclude <프로젝트>|restore <프로젝트>|activity <프로젝트>|review <프로젝트>]";
  }
  if (selected === "run") return "사용법: hq run --project <프로젝트> --prompt <요청> [--worktree <Orca 작업 공간 ID>]";
  return "사용법: hq jobs [list|show <ID>|stop <ID>|retry <ID>|followup <ID> <요청>]";
}

export async function runCli(input: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const output = dependencies.stdout ?? process.stdout;
  const host = dependencies.host ?? createMacosHostAdapters();
  const selected = command(input);
  if (selected === undefined) {
    write(output, `Usage: hq ${commandNames.join("|")}`);
    return 2;
  }
  let sessionId: string | undefined;
  let questionArguments = input.slice(1);
  let progressWindow: ProgressWindowMode = "auto";
  if (selected === "ask" && questionArguments[0] === "--session") {
    sessionId = questionArguments[1];
    if (sessionId === undefined || !validSessionId(sessionId)) { write(output, terminalUsage(selected)); return 2; }
    questionArguments = questionArguments.slice(2);
  }
  if (selected === "chat") {
    const seen = new Set<string>();
    for (let index = 0; index < questionArguments.length; index += 1) {
      const flag = questionArguments[index]!;
      if (flag === "--session" && !seen.has("session")) {
        seen.add("session"); sessionId = questionArguments[++index];
        if (sessionId !== undefined && validSessionId(sessionId)) continue;
      } else if ((flag.startsWith("--progress-window=") || flag === "--progress-window") && !seen.has("window")) {
        seen.add("window");
        const value = flag === "--progress-window" ? questionArguments[++index] : flag.slice("--progress-window=".length);
        if (value === "auto" || value === "off") { progressWindow = value; continue; }
      }
      write(output, terminalUsage(selected)); return 2;
    }
  }
  if (selected === "watch") {
    const flags = new Map<string, string>();
    for (let index = 1; index < input.length; index += 2) {
      const key = input[index]!;
      const value = input[index + 1];
      if (!["--context", "--viewer-instance", "--lease-token"].includes(key) || flags.has(key) || !validProgressIdentifier(value)) {
        write(output, terminalUsage(selected)); return 2;
      }
      flags.set(key, value);
    }
    const contextId = flags.get("--context");
    const viewerInstanceId = flags.get("--viewer-instance");
    const leaseToken = flags.get("--lease-token");
    if (contextId === undefined || (viewerInstanceId === undefined) !== (leaseToken === undefined)) {
      write(output, terminalUsage(selected)); return 2;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) process.on(signal, abort);
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    if (dependencies.signal?.aborted) abort();
    try {
      return (await runWatch({ client: dependencies.progress ?? createProgressClient(), contextId, output, signal: controller.signal,
        ...(viewerInstanceId === undefined || leaseToken === undefined ? {} : { viewer: { viewerInstanceId, leaseToken } }) })).exitCode;
    } catch {
      write(output, "진행 정보를 조회하지 못했습니다. 작업은 계속됩니다. `hq start`로 연결 상태를 확인하세요.");
      return 1;
    } finally {
      for (const signal of signals) process.removeListener(signal, abort);
      dependencies.signal?.removeEventListener("abort", abort);
    }
  }
  const controlFactory = dependencies.controlFactory
    ?? ((options: ControlClientOptions) => dependencies.control ?? createControlClient(options));
  if (selected === "chat") {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) process.on(signal, abort);
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    if (dependencies.signal?.aborted) abort();
    try {
      await runChat({ input: dependencies.stdin ?? process.stdin, output, progressWindow, signal: controller.signal,
        ...(dependencies.progress === undefined ? {} : { client: dependencies.progress }),
        ...(dependencies.progressWindows === undefined ? {} : { windows: dependencies.progressWindows }),
        ...(sessionId === undefined ? {} : { sessionId }) });
      return 0;
    } catch {
      write(output, "Orca HQ 게이트웨이에 연결하지 못했습니다. `hq start`로 상태를 확인하세요.");
      return 1;
    } finally {
      for (const signal of signals) process.removeListener(signal, abort);
      dependencies.signal?.removeEventListener("abort", abort);
    }
  }
  if (selected === "ask" || selected === "projects" || selected === "run" || selected === "jobs") {
    const naturalText = selected === "ask" ? questionArguments.join(" ").trim() : undefined;
    const structured = selected === "ask" ? undefined : structuredControlCommand(input);
    if ((selected === "ask" && naturalText === "") || (selected !== "ask" && structured === undefined)) {
      write(output, terminalUsage(selected));
      return 2;
    }
    try {
      const control = controlFactory(sessionId === undefined ? {} : { sessionId });
      const result = await control.send(naturalText ?? `/hq ${JSON.stringify(structured)}`);
      write(output, result.text);
      if (result.jobId !== undefined) write(output, `작업 ID: ${result.jobId}`);
      return 0;
    } catch {
      write(output, "Orca HQ 게이트웨이에 연결하지 못했습니다. `hq start`로 상태를 확인하세요.");
      return 1;
    }
  }
  if (selected === "doctor") {
    if (input.length !== 3 || input[1] !== "--format" || input[2] !== "json") {
      write(output, "Usage: hq doctor --format json");
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
  if (selected === "credential") {
    const account = input.length === 3 && input[1] === "--account" ? input[2] : undefined;
    if (account === undefined || !credentialAccounts.includes(account as (typeof credentialAccounts)[number])) {
      write(output, "사용법: hq credential --account slack-bot-token");
      return 2;
    }
    const machine = dependencies.credentialMachine ?? createNodeMachine();
    const configPath = configurationPath(machine);
    const credential = dependencies.credential ?? createCredentialCommand({
      configPath,
      readConfig: async () => machine.readText(configPath),
      writeConfig: async (text) => {
        await machine.createDirectory(dirname(configPath));
        await machine.writeText(configPath, text);
      },
      storeSecret: async (service, credentialAccount, value) => {
        await machine.storeKeychainSecret(service, credentialAccount, value);
      },
      prompt: dependencies.credentialPrompt ?? createSecretPrompt(),
      output: { write: (text) => write(output, text) }
    });
    return await credential.run(account) ? 0 : 1;
  }
  if (selected === "start" || selected === "stop" || selected === "status") {
    const launchd = dependencies.launchd
      ?? createLaunchdOperations(defaultLaunchdPaths(), createNodeLaunchdPort());
    let stopAfterFailedStart = false;
    try {
      if (selected === "start") {
        const before = await launchd.status();
        await launchd.install();
        stopAfterFailedStart = before.state !== "running";
        let current = await launchd.status();
        if (current.state !== "running") {
          await launchd.start();
          current = await launchd.status();
        }
        const processDeadline = Date.now() + 5000;
        while (current.state === "loaded" && Date.now() < processDeadline) {
          await new Promise<void>(resolve => setTimeout(resolve, 100));
          current = await launchd.status();
        }
        const pid = current.state === "running" ? current.pid : undefined;
        const readiness = dependencies.readiness ?? createHttpReadinessProbe();
        if (pid === undefined || !(await readiness.waitForRunning(pid)).ready) {
          if (stopAfterFailedStart) {
            try { await launchd.stop(); } catch { /* Preserve the readiness diagnostic. */ }
          }
          write(output, "Gateway application readiness verification failed.");
          return 1;
        }
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
      if (selected === "start" && stopAfterFailedStart) {
        try { await launchd.stop(); } catch { /* Preserve the operation diagnostic. */ }
      }
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
      write(output, error !== null
        && typeof error === "object"
        && (error as { code?: unknown }).code === "lifecycle_config_invalid"
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
