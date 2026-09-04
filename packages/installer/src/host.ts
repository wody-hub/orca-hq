import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";

import {
  defaultPilotDatabasePath,
  inspectPilotConfigText,
  pilotConfigurationPath,
  type PilotConfigInspection
} from "@orca-hq/core";
import { parse } from "yaml";

import type { ConfigFilePort } from "./config-files.js";
import type { DoctorPorts, CheckStatus } from "./doctor.js";
import { ORCA_HQ_KEYCHAIN_SERVICE, type KeychainPort } from "./keychain.js";
import type { SetupAnswers, SetupOutputPort, SetupPorts } from "./setup.js";

const execFileAsync = promisify(execFile);

export type HostCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  options: Readonly<{ timeout?: number; maxBuffer: number }>
) => Promise<Readonly<{ stdout: string }>>;

export interface HostReadPort {
  platform(): string;
  architecture(): string;
  nodeVersion(): string;
  homeDirectory(): string;
  configDirectory(): string | undefined;
  command(executable: string, arguments_: readonly string[]): Promise<Readonly<{ ok: boolean; stdout: string }>>;
  readText(path: string): Promise<string | undefined>;
  directoryWritable(path: string): Promise<boolean>;
}

export interface HostMutationPort {
  createDirectory(path: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  storeKeychainSecret(service: string, account: string, value: string): Promise<void>;
}

export type HostMachinePort = HostReadPort & HostMutationPort;

export interface HostAdapters {
  readonly doctor: DoctorPorts;
  setup(output: SetupOutputPort, confirm: () => Promise<boolean>, pending: SetupAnswers): SetupPorts;
}

export function configurationPath(machine: Pick<HostReadPort, "homeDirectory" | "configDirectory">): string {
  return pilotConfigurationPath({
    homeDirectory: machine.homeDirectory(),
    configDirectory: machine.configDirectory()
  });
}

async function configuration(machine: HostReadPort): Promise<PilotConfigInspection> {
  const text = await machine.readText(configurationPath(machine));
  return inspectPilotConfigText(text);
}

function readableConfig(snapshot: PilotConfigInspection) {
  return snapshot.status === "current" || snapshot.status === "legacy" ? snapshot.config : undefined;
}

function configurationStatus(snapshot: PilotConfigInspection): CheckStatus {
  return snapshot.status === "current" ? "pass" : snapshot.status === "legacy" ? "warn" : "fail";
}

async function commandPass(machine: HostReadPort, executable: string, arguments_: readonly string[]): Promise<CheckStatus> {
  return (await machine.command(executable, arguments_)).ok ? "pass" : "fail";
}

async function keychainAccountExists(machine: HostReadPort, account: string): Promise<boolean> {
  return (await machine.command("security", ["find-generic-password", "-s", ORCA_HQ_KEYCHAIN_SERVICE, "-a", account])).ok;
}

async function credentialReady(
  machine: HostReadPort,
  accounts: readonly string[],
  inspected?: PilotConfigInspection
): Promise<CheckStatus> {
  const snapshot = readableConfig(inspected ?? await configuration(machine));
  if (snapshot === undefined || !accounts.every((account) => snapshot.credentialAccounts.includes(account))) return "fail";
  return (await Promise.all(accounts.map((account) => keychainAccountExists(machine, account)))).every(Boolean) ? "pass" : "fail";
}

async function registryReview(machine: HostReadPort): Promise<Readonly<{ status: CheckStatus; curatedProjects: number }>> {
  const snapshot = readableConfig(await configuration(machine));
  if (snapshot === undefined) return { status: "fail", curatedProjects: 0 };
  return registryReviewAt(machine, snapshot.projectRegistryPath);
}

async function registryReviewAt(machine: HostReadPort, registryPath: string): Promise<Readonly<{ status: CheckStatus; curatedProjects: number }>> {
  const text = await machine.readText(registryPath);
  if (text === undefined) return { status: "fail", curatedProjects: 0 };
  try {
    const parsed: unknown = parse(text);
    const projects = parsed !== null && typeof parsed === "object"
      ? (parsed as { projects?: unknown }).projects
      : undefined;
    return Array.isArray(projects)
      ? { status: projects.length === 5 ? "pass" : "warn", curatedProjects: projects.length }
      : { status: "fail", curatedProjects: 0 };
  } catch {
    return { status: "fail", curatedProjects: 0 };
  }
}

async function pendingCredentialReady(
  machine: HostReadPort,
  pending: SetupAnswers,
  accounts: readonly string[],
  inspected: PilotConfigInspection
): Promise<CheckStatus> {
  // Pending values have not been persisted yet. They are sufficient for preflight, but remain a warning until setup stores them.
  if (accounts.every((account) => (pending.credentials[account]?.length ?? 0) > 0)) return "warn";
  return credentialReady(machine, accounts, inspected);
}

/** Builds concrete macOS adapters. Doctor receives only the read-only half of this boundary. */
export function createMacosHostAdapters(machine: HostMachinePort = createNodeMachine()): HostAdapters {
  const configPath = configurationPath(machine);
  const databasePath = defaultPilotDatabasePath(machine.homeDirectory());
  const doctor: DoctorPorts = {
    checks: {
      pilotConfiguration: async () => configurationStatus(await configuration(machine)),
      macosCpu: async () => machine.platform() === "darwin" && ["arm64", "x64"].includes(machine.architecture()) ? "pass" : "fail",
      nodePnpm: async () => machine.nodeVersion().startsWith("v22.") && (await commandPass(machine, "pnpm", ["--version"])) === "pass" ? "pass" : "fail",
      orcaCapabilities: async () => (await Promise.all([
        commandPass(machine, "orca", ["--version"]), commandPass(machine, "orca", ["capabilities", "--format", "json"])
      ])).every((status) => status === "pass") ? "pass" : "fail",
      codexAuthentication: async () => commandPass(machine, "codex", ["login", "status"]),
      claudeAuthentication: async () => commandPass(machine, "claude", ["auth", "status"]),
      tailscaleTailnet: async () => commandPass(machine, "tailscale", ["status", "--json"]),
      slackSocketMode: async () => credentialReady(machine, ["slack-app-token", "slack-channel-id"]),
      telegramAllowlistedChat: async () => credentialReady(machine, ["telegram-bot-token", "telegram-allowed-chat-id"]),
      openAiVoice: async () => credentialReady(machine, ["openai-api-key"]),
      keychain: async () => commandPass(machine, "security", ["list-keychains"]),
      sqliteDirectory: async () => await machine.directoryWritable(dirname(dirname(configPath))) ? "pass" : "fail",
      launchd: async () => commandPass(machine, "launchctl", ["print-disabled", `user/${process.getuid?.() ?? 0}`]),
      projectDiscovery: async () => commandPass(machine, "orca", ["projects", "list", "--format", "json"])
    },
    registry: { review: async () => registryReview(machine) }
  };
  return {
    doctor,
    setup(output, confirm, pending) {
      const inspected = configuration(machine);
      const configFile: ConfigFilePort = {
        path: configPath,
        preview: async () => undefined,
        write: async (text) => {
          await machine.createDirectory(dirname(configPath));
          await machine.writeText(configPath, text);
        }
      };
      const keychain: KeychainPort = {
        set: async (service, account, value) => machine.storeKeychainSecret(service, account, value)
      };
      return {
        ...doctor,
        databasePath,
        checks: {
          ...doctor.checks,
          pilotConfiguration: async () => {
            const snapshot = await inspected;
            return snapshot.status === "missing" ? "warn" : configurationStatus(snapshot);
          },
          slackSocketMode: async () => pendingCredentialReady(machine, pending, ["slack-app-token", "slack-channel-id"], await inspected),
          telegramAllowlistedChat: async () => pendingCredentialReady(machine, pending, ["telegram-bot-token", "telegram-allowed-chat-id"], await inspected),
          openAiVoice: async () => pendingCredentialReady(machine, pending, ["openai-api-key"], await inspected)
        },
        registry: {
          review: async () => {
            const existing = readableConfig(await inspected);
            const path = pending.registryPath.trim().length > 0
              ? pending.registryPath
              : existing?.projectRegistryPath ?? pending.registryPath;
            return registryReviewAt(machine, path);
          }
        },
        existingConfig: async () => readableConfig(await inspected),
        keychain,
        configFile,
        output,
        confirm
      };
    }
  };
}

export function createNodeMachine(
  runCommand: HostCommandRunner = async (executable, arguments_, options) => {
    const result = await execFileAsync(executable, [...arguments_], options);
    return { stdout: result.stdout };
  }
): HostMachinePort {
  return {
    platform,
    architecture: arch,
    nodeVersion: () => process.version,
    homeDirectory: homedir,
    configDirectory: () => process.env.XDG_CONFIG_HOME,
    async command(executable, arguments_) {
      try {
        const result = await runCommand(executable, arguments_, { timeout: 5_000, maxBuffer: 64 * 1024 });
        return { ok: true, stdout: result.stdout };
      } catch {
        return { ok: false, stdout: "" };
      }
    },
    async readText(path) {
      try { return await readFile(path, "utf8"); } catch { return undefined; }
    },
    async directoryWritable(path) {
      try { await access(path, constants.W_OK); return true; } catch { return false; }
    },
    async createDirectory(path) { await mkdir(path, { recursive: true }); },
    async writeText(path, text) { await writeFile(path, text, { encoding: "utf8", mode: 0o600 }); },
    async storeKeychainSecret(service, account, value) {
      try {
        await runCommand("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value], { maxBuffer: 64 * 1024 });
      } catch {
        throw new Error("Unable to store credential in macOS Keychain.");
      }
    }
  };
}
