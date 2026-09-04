import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import {
  defaultPilotDataDirectory,
  parsePilotConfigText,
  pilotConfigurationPath
} from "@orca-hq/core";

import { createBackupService } from "./backup.js";
import { createDoctor, type DoctorPorts } from "./doctor.js";
import { createMacosHostAdapters } from "./host.js";
import {
  createLaunchdOperations,
  createNodeLaunchdPort,
  defaultLaunchdPaths,
  type LaunchdOperations
} from "./launchd.js";
import { createUninstall } from "./uninstall.js";
import { createUpdate } from "./update.js";

const execFileAsync = promisify(execFile);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const terminalDispatchStates = ["worker_done", "launch_failed", "intervention_required"] as const;

export interface LifecycleHostPaths {
  readonly program: string;
  readonly data: string;
  readonly database: string;
  readonly config: string;
  readonly backups: string;
}

export interface LifecycleHostMachinePort {
  command(
    executable: string,
    arguments_: readonly string[],
    options: Readonly<{ cwd: string }>
  ): Promise<Readonly<{ exitCode: number; stdout: string }>>;
  createDirectory(path: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  readonly database: Readonly<{
    backup(source: string, destination: string): Promise<void>;
    schemaVersion(path: string): Promise<number>;
    nonterminalDispatches(path: string): Promise<number>;
    migrate(path: string, program: string): Promise<void>;
  }>;
}

export interface LifecycleComposition {
  readonly update: ReturnType<typeof createUpdate>;
  readonly uninstall: ReturnType<typeof createUninstall>;
}

export interface LifecycleHostCompositionOptions {
  readonly paths: LifecycleHostPaths;
  readonly protectedPaths?: readonly string[];
  readonly machine?: LifecycleHostMachinePort;
  readonly launchd?: LaunchdOperations;
  readonly doctor?: DoctorPorts;
  readonly now?: () => Date;
}

export interface LifecycleConfigurationPort {
  homeDirectory(): string;
  configDirectory(): string | undefined;
  readText(path: string): Promise<string | undefined>;
}

export interface DefaultLifecycleHostCompositionOptions extends Omit<LifecycleHostCompositionOptions, "paths"> {
  readonly configuration?: LifecycleConfigurationPort;
  readonly program?: string;
}

function commandError(operation: string): Error {
  return Object.assign(new Error(`Lifecycle host operation failed during ${operation}.`), {
    code: "lifecycle_host_failed"
  });
}

async function requireCommand(
  machine: LifecycleHostMachinePort,
  paths: LifecycleHostPaths,
  executable: string,
  arguments_: readonly string[],
  operation: string
): Promise<string> {
  const result = await machine.command(executable, arguments_, { cwd: paths.program });
  if (result.exitCode !== 0) throw commandError(operation);
  return result.stdout.trim();
}

function exactRevision(revision: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision);
}

export function defaultLifecycleHostPaths(input: Readonly<{
  readonly homeDirectory: string;
  readonly configDirectory?: string | undefined;
  readonly databasePath: string;
  readonly program?: string;
}>): LifecycleHostPaths {
  const home = resolve(input.homeDirectory);
  const program = resolve(input.program ?? join(moduleDirectory, "../../.."));
  const data = defaultPilotDataDirectory(home);
  return Object.freeze({
    program,
    data,
    database: resolve(input.databasePath),
    config: pilotConfigurationPath({ homeDirectory: home, configDirectory: input.configDirectory }),
    backups: join(data, "backups")
  });
}

function lifecycleConfigError(): Error {
  return Object.assign(new Error("Lifecycle configuration is missing or invalid."), {
    code: "lifecycle_config_invalid"
  });
}

function createNodeLifecycleConfiguration(): LifecycleConfigurationPort {
  return {
    homeDirectory: homedir,
    configDirectory: () => process.env.XDG_CONFIG_HOME,
    async readText(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    }
  };
}

/** Loads the secret-free pilot config used by setup, doctor, gateway, and lifecycle before composing mutations. */
export async function createDefaultLifecycleHostComposition(
  options: DefaultLifecycleHostCompositionOptions = {}
): Promise<LifecycleComposition> {
  const configuration = options.configuration ?? createNodeLifecycleConfiguration();
  const homeDirectory = resolve(configuration.homeDirectory());
  const configDirectory = configuration.configDirectory();
  const configPath = pilotConfigurationPath({ homeDirectory, configDirectory });
  const text = await configuration.readText(configPath);
  if (text === undefined) throw lifecycleConfigError();
  try {
    const config = parsePilotConfigText(text);
    return createLifecycleHostComposition({
      ...options,
      protectedPaths: [homeDirectory],
      paths: defaultLifecycleHostPaths({
        homeDirectory,
        configDirectory,
        databasePath: config.databasePath,
        ...(options.program === undefined ? {} : { program: options.program })
      })
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === "lifecycle_config_invalid") throw error;
    throw lifecycleConfigError();
  }
}

/** Concrete Node/macOS filesystem, process, and SQLite boundary for lifecycle commands. */
export function createNodeLifecycleHostMachine(): LifecycleHostMachinePort {
  const openReadOnly = (path: string): Database.Database => new Database(path, { readonly: true, fileMustExist: true });
  return {
    async command(executable, arguments_, options) {
      try {
        const result = await execFileAsync(executable, [...arguments_], {
          cwd: options.cwd,
          timeout: 120_000,
          maxBuffer: 256 * 1024
        });
        return { exitCode: 0, stdout: result.stdout };
      } catch (error) {
        const candidate = error as { code?: unknown; stdout?: unknown };
        return {
          exitCode: typeof candidate.code === "number" ? candidate.code : 1,
          stdout: typeof candidate.stdout === "string" ? candidate.stdout : ""
        };
      }
    },
    async createDirectory(path) { await mkdir(path, { recursive: true }); },
    async copyFile(source, destination) { await copyFile(source, destination); },
    async writeText(path, text) { await writeFile(path, text, { encoding: "utf8", mode: 0o600 }); },
    async removeDirectory(path) { await rm(path, { recursive: true, force: true }); },
    database: {
      async backup(source, destination) {
        const database = openReadOnly(source);
        try {
          await database.backup(destination);
        } finally {
          database.close();
        }
      },
      async schemaVersion(path) {
        const database = openReadOnly(path);
        try {
          const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: unknown };
          if (!Number.isSafeInteger(row.version) || (row.version as number) < 0) throw commandError("schema_version");
          return row.version as number;
        } finally {
          database.close();
        }
      },
      async nonterminalDispatches(path) {
        const database = openReadOnly(path);
        try {
          const placeholders = terminalDispatchStates.map(() => "?").join(", ");
          const row = database.prepare(
            `SELECT COUNT(*) AS count FROM dispatches WHERE state NOT IN (${placeholders})`
          ).get(...terminalDispatchStates) as { count?: unknown };
          if (!Number.isSafeInteger(row.count) || (row.count as number) < 0) throw commandError("gateway_status");
          return row.count as number;
        } finally {
          database.close();
        }
      },
      async migrate(path, program) {
        const commandOptions = { cwd: program, timeout: 120_000, maxBuffer: 256 * 1024 };
        await execFileAsync("pnpm", ["--filter", "@orca-hq/persistence", "build"], commandOptions);
        const migrationProgram = [
          "const { openDatabase } = await import('./packages/persistence/dist/index.js');",
          "openDatabase(process.argv[1]).close();"
        ].join(" ");
        await execFileAsync(
          process.execPath,
          ["--input-type=module", "--eval", migrationProgram, path],
          commandOptions
        );
      }
    }
  };
}

/** Wires production lifecycle services while allowing tests to fake every external boundary. */
export function createLifecycleHostComposition(
  options: LifecycleHostCompositionOptions
): LifecycleComposition {
  const paths = options.paths;
  const machine = options.machine ?? createNodeLifecycleHostMachine();
  const launchd = options.launchd ?? createLaunchdOperations(
    defaultLaunchdPaths({ homeDirectory: dirname(dirname(dirname(paths.data))), workspaceRoot: paths.program }),
    createNodeLaunchdPort()
  );
  const doctorPorts = options.doctor ?? createMacosHostAdapters().doctor;
  const gateway = {
    async status() {
      return { activeOrUncertainDispatches: await machine.database.nonterminalDispatches(paths.database) };
    },
    async stop() { await launchd.stop(); },
    async start() {
      await launchd.install();
      if ((await launchd.status()).state !== "running") await launchd.start();
    }
  };
  let compatibleBackupRevision: string | undefined;
  const readCurrentRevision = async (): Promise<string> => {
    const revision = await requireCommand(machine, paths, "git", ["-C", paths.program, "rev-parse", "HEAD"], "current_revision");
    if (!exactRevision(revision)) throw commandError("current_revision");
    return revision;
  };
  const source = {
    async currentRevision() {
      const revision = await readCurrentRevision();
      compatibleBackupRevision = revision;
      return revision;
    },
    async verifyRevision(revision: string) {
      if (!exactRevision(revision)) return false;
      const resolved = await machine.command(
        "git",
        ["-C", paths.program, "rev-parse", "--verify", `${revision}^{commit}`],
        { cwd: paths.program }
      );
      return resolved.exitCode === 0 && resolved.stdout.trim().toLowerCase() === revision.toLowerCase();
    },
    async installRevision(input: Readonly<{ revision: string; frozenLockfile: true }>) {
      await requireCommand(machine, paths, "git", ["-C", paths.program, "checkout", "--detach", input.revision], "install_revision");
      await requireCommand(machine, paths, "pnpm", ["install", "--frozen-lockfile"], "frozen_install");
    },
    async restoreRevision(revision: string) {
      await requireCommand(machine, paths, "git", ["-C", paths.program, "checkout", "--detach", revision], "restore_revision");
      await requireCommand(machine, paths, "pnpm", ["install", "--frozen-lockfile"], "restore_dependencies");
    }
  };
  const backups = createBackupService({
    paths: { backupDirectory: paths.backups, configPath: paths.config },
    database: {
      backupTo: async (destination) => machine.database.backup(paths.database, destination),
      restoreFrom: async (sourcePath) => machine.database.backup(sourcePath, paths.database)
    },
    files: {
      createDirectory: async (path) => machine.createDirectory(path),
      copyFile: async (sourcePath, destination) => machine.copyFile(sourcePath, destination),
      writeText: async (path, text) => machine.writeText(path, text)
    },
    metadata: {
      schemaVersion: async () => machine.database.schemaVersion(paths.database),
      sourceRevision: async () => {
        const revision = compatibleBackupRevision ?? await readCurrentRevision();
        compatibleBackupRevision = undefined;
        return revision;
      }
    },
    ...(options.now === undefined ? {} : { now: options.now })
  });
  return Object.freeze({
    update: createUpdate({
      gateway,
      source,
      preflight: {
        async run() {
          const result = await machine.command("pnpm", ["typecheck"], { cwd: paths.program });
          return { ok: result.exitCode === 0 };
        }
      },
      backups,
      migrations: { async run() { await machine.database.migrate(paths.database, paths.program); } },
      doctor: { async run() { return createDoctor(doctorPorts).run({ format: "json" }); } }
    }),
    uninstall: createUninstall({
      paths,
      ...(options.protectedPaths === undefined ? {} : { protectedPaths: options.protectedPaths }),
      gateway,
      launchd: { uninstall: async () => launchd.uninstall() },
      files: {
        removeProgram: async (path) => machine.removeDirectory(path),
        removeData: async (path) => machine.removeDirectory(path)
      }
    })
  });
}
