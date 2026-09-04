import { execFile } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export type LaunchdPaths = Readonly<{
  label: string;
  domain: string;
  plistPath: string;
  nodePath: string;
  gatewayEntryPath: string;
  workingDirectory: string;
  standardOutPath: string;
  standardErrorPath: string;
}>;

export type LaunchdStatus = Readonly<
  | { state: "running"; pid?: number }
  | { state: "loaded" }
  | { state: "stopped" }
>;

export interface LaunchdPort {
  createDirectory(path: string): Promise<void>;
  writeText(path: string, text: string, mode: number): Promise<void>;
  inspectPath(path: string): Promise<Readonly<{
    exists: boolean;
    file: boolean;
    readable: boolean;
    executable: boolean;
  }>>;
  command(
    executable: string,
    arguments_: readonly string[]
  ): Promise<Readonly<{ exitCode: number; stdout: string }>>;
}

export interface LaunchdOperations {
  install(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<LaunchdStatus>;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function validatePaths(paths: LaunchdPaths): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(paths.label)) {
    throw new TypeError("launchd label is invalid");
  }
  if (!/^(?:gui|user)\/\d+$/.test(paths.domain)) {
    throw new TypeError("launchd user domain is invalid");
  }
  for (const path of [
    paths.plistPath,
    paths.nodePath,
    paths.gatewayEntryPath,
    paths.workingDirectory,
    paths.standardOutPath,
    paths.standardErrorPath
  ]) {
    if (!isAbsolute(path) || path.includes("~") || path.includes("\0")) {
      throw new TypeError("launchd paths must be explicit absolute paths");
    }
  }
}

/** Renders a secret-free LaunchAgent definition using only explicit host paths. */
export function renderLaunchAgent(paths: LaunchdPaths): string {
  validatePaths(paths);
  const template = readFileSync(
    resolve(moduleDirectory, "../../../templates/com.orcahq.gateway.plist"),
    "utf8"
  );
  return template
    .replaceAll("{{LABEL}}", xml(paths.label))
    .replaceAll("{{NODE_PATH}}", xml(paths.nodePath))
    .replaceAll("{{GATEWAY_ENTRY_PATH}}", xml(paths.gatewayEntryPath))
    .replaceAll("{{WORKING_DIRECTORY}}", xml(paths.workingDirectory))
    .replaceAll("{{STANDARD_OUT_PATH}}", xml(paths.standardOutPath))
    .replaceAll("{{STANDARD_ERROR_PATH}}", xml(paths.standardErrorPath));
}

function target(paths: LaunchdPaths): string {
  return `${paths.domain}/${paths.label}`;
}

function operationError(operation: string): Error {
  return Object.assign(new Error(`Unable to ${operation} the Orca HQ gateway service.`), {
    code: "launchd_operation_failed"
  });
}

function pathUnavailableError(): Error {
  return Object.assign(new Error("A required Orca HQ gateway service path is unavailable."), {
    code: "launchd_path_unavailable"
  });
}

function definitionMismatchError(): Error {
  return Object.assign(new Error("The loaded Orca HQ gateway service definition differs from the requested definition."), {
    code: "launchd_definition_mismatch"
  });
}

function loadedDefinitionMatches(stdout: string, paths: LaunchdPaths): boolean {
  const program = /^\s*program\s*=\s*(.+?)\s*$/m.exec(stdout)?.[1];
  const block = /^\s*arguments\s*=\s*\{\s*$([\s\S]*?)^\s*\}\s*$/m.exec(stdout)?.[1];
  const arguments_ = block?.split("\n").map((line) => line.trim()).filter(Boolean);
  return program === paths.nodePath
    && arguments_?.length === 2
    && arguments_[0] === paths.nodePath
    && arguments_[1] === paths.gatewayEntryPath;
}

/** Provides exact-label launchctl operations; no shell, PID kill, or broad domain cleanup is used. */
export function createLaunchdOperations(
  paths: LaunchdPaths,
  port: LaunchdPort
): LaunchdOperations {
  validatePaths(paths);
  const run = async (operation: string, arguments_: readonly string[]): Promise<void> => {
    const result = await port.command("launchctl", arguments_);
    if (result.exitCode !== 0) throw operationError(operation);
  };
  return Object.freeze({
    async install() {
      const [node, gateway] = await Promise.all([
        port.inspectPath(paths.nodePath),
        port.inspectPath(paths.gatewayEntryPath)
      ]);
      if (!node.exists || !node.file || !node.readable || !node.executable
        || !gateway.exists || !gateway.file || !gateway.readable) {
        throw pathUnavailableError();
      }
      await Promise.all([
        port.createDirectory(dirname(paths.plistPath)),
        port.createDirectory(dirname(paths.standardOutPath)),
        port.createDirectory(dirname(paths.standardErrorPath))
      ]);
      await port.writeText(paths.plistPath, renderLaunchAgent(paths), 0o600);
      const result = await port.command("launchctl", ["bootstrap", paths.domain, paths.plistPath]);
      if (result.exitCode !== 0) {
        const existing = await port.command("launchctl", ["print", target(paths)]);
        if (existing.exitCode !== 0) throw operationError("install");
        if (!loadedDefinitionMatches(existing.stdout, paths)) throw definitionMismatchError();
      }
    },
    async start() {
      await run("start", ["kickstart", target(paths)]);
    },
    async stop() {
      await run("stop", ["bootout", target(paths)]);
    },
    async status() {
      const result = await port.command("launchctl", ["print", target(paths)]);
      if (result.exitCode !== 0) return Object.freeze({ state: "stopped" as const });
      const state = /^\s*state\s*=\s*(\S+)\s*$/m.exec(result.stdout)?.[1];
      const pidText = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(result.stdout)?.[1];
      const pid = pidText === undefined ? undefined : Number(pidText);
      if (state === "running") {
        return Object.freeze({ state: "running" as const, ...(pid === undefined ? {} : { pid }) });
      }
      return Object.freeze({ state: "loaded" as const });
    }
  });
}

export function createNodeLaunchdPort(): LaunchdPort {
  return {
    async createDirectory(path) {
      await mkdir(path, { recursive: true });
    },
    async writeText(path, text, mode) {
      await writeFile(path, text, { encoding: "utf8", mode });
    },
    async inspectPath(path) {
      try {
        const information = await stat(path);
        const [readable, executable] = await Promise.all([
          access(path, constants.R_OK).then(() => true, () => false),
          access(path, constants.X_OK).then(() => true, () => false)
        ]);
        return { exists: true, file: information.isFile(), readable, executable };
      } catch {
        return { exists: false, file: false, readable: false, executable: false };
      }
    },
    async command(executable, arguments_) {
      try {
        const result = await execFileAsync(executable, [...arguments_], {
          timeout: 10_000,
          maxBuffer: 64 * 1024
        });
        return { exitCode: 0, stdout: result.stdout };
      } catch (error) {
        const candidate = error as { code?: unknown; stdout?: unknown };
        return {
          exitCode: typeof candidate.code === "number" ? candidate.code : 1,
          stdout: typeof candidate.stdout === "string" ? candidate.stdout : ""
        };
      }
    }
  };
}

/** Resolves the source-distributed private-pilot layout without shell aliases or `~`. */
export function defaultLaunchdPaths(input: Readonly<{
  homeDirectory?: string;
  userId?: number;
  nodePath?: string;
  workspaceRoot?: string;
}> = {}): LaunchdPaths {
  const homeDirectory = resolve(input.homeDirectory ?? homedir());
  const workspaceRoot = resolve(input.workspaceRoot ?? join(moduleDirectory, "../../.."));
  const userId = input.userId ?? process.getuid?.();
  if (userId === undefined || !Number.isSafeInteger(userId) || userId < 0) {
    throw new TypeError("launchd user id is unavailable");
  }
  return Object.freeze({
    label: "com.orcahq.gateway",
    domain: `gui/${userId}`,
    plistPath: join(homeDirectory, "Library/LaunchAgents/com.orcahq.gateway.plist"),
    nodePath: resolve(input.nodePath ?? process.execPath),
    gatewayEntryPath: join(workspaceRoot, "apps/gateway/dist/entry.js"),
    workingDirectory: workspaceRoot,
    standardOutPath: join(homeDirectory, "Library/Logs/orca-hq/gateway.log"),
    standardErrorPath: join(homeDirectory, "Library/Logs/orca-hq/gateway.error.log")
  });
}
