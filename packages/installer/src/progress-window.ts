import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { validProgressIdentifier, type ProgressClient, type ViewerLeaseHolder } from "./progress-client.js";

export type ProgressWindowMode = "auto" | "off";
export type WindowOpenResult = "opened" | "reused" | "failed" | "uncertain";
export interface ProgressWindowManager { open(contextId: string): Promise<WindowOpenResult> }

export function canOpenProgressWindow(options: {
  readonly platform: string;
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): boolean {
  return options.platform === "darwin" && options.inputIsTTY && options.outputIsTTY
    && !options.env.SSH_CONNECTION && !options.env.SSH_CLIENT && !options.env.SSH_TTY;
}

/** No target window means Terminal creates a new window, independent of the selected tab. */
export const terminalWindowScript = `on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
end run`;

function quote(value: string): string {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error("window_argument_invalid");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildWatchCommand(options: {
  readonly nodePath: string;
  readonly cliPath: string;
  readonly contextId: string;
  readonly viewer: ViewerLeaseHolder;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string {
  for (const id of [options.contextId, options.viewer.viewerInstanceId, options.viewer.leaseToken]) {
    if (!validProgressIdentifier(id)) throw new Error("progress_identifier_invalid");
  }
  if (!isAbsolute(options.nodePath) || !isAbsolute(options.cliPath)) throw new Error("window_path_invalid");
  const environment = ["HOME", "XDG_CONFIG_HOME"].flatMap(key => {
    const value = options.env?.[key];
    return value === undefined ? [] : [`${key}=${value}`];
  });
  // Only local executable/config paths and validated opaque ids enter the command; titles and input never do.
  return `exec /usr/bin/env ${[...environment, options.nodePath, options.cliPath, "watch", "--context",
    options.contextId, "--viewer-instance", options.viewer.viewerInstanceId, "--lease-token", options.viewer.leaseToken]
    .map(quote).join(" ")}`;
}

export class WindowLaunchFailure extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}

export async function launchTerminalWindow(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", terminalWindowScript, "--", command], { timeout: 10_000, maxBuffer: 16_384 }, (error, _stdout, stderr) => {
      if (error === null) { resolve(); return; }
      // Permission denial/absent executable proves no viewer started. Other failures may lose a success receipt.
      const code = (error as NodeJS.ErrnoException).code;
      const definite = code === "ENOENT" || code === "EACCES" || stderr.includes("(-1743)");
      reject(new WindowLaunchFailure("progress_window_launch_failed", !definite));
    });
  });
}

export function createProgressWindowManager(options: {
  readonly client: ProgressClient;
  readonly launch?: (command: string) => Promise<void>;
  readonly nodePath?: string;
  readonly cliPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): ProgressWindowManager {
  const pending = new Map<string, Promise<WindowOpenResult>>();
  const launch = options.launch ?? launchTerminalWindow;
  async function open(contextId: string): Promise<WindowOpenResult> {
    if (!validProgressIdentifier(contextId)) return "failed";
    const viewerInstanceId = randomUUID();
    let lease;
    try { lease = await options.client.acquireViewerLease(contextId, viewerInstanceId); }
    catch { return "uncertain"; }
    if (!lease.acquired) return "reused";
    if (lease.leaseToken === undefined || lease.viewerInstanceId !== viewerInstanceId) return "uncertain";
    const viewer = { viewerInstanceId, leaseToken: lease.leaseToken };
    let command: string;
    try {
      command = buildWatchCommand({
        nodePath: options.nodePath ?? process.execPath,
        cliPath: options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url)),
        contextId, viewer, env: options.env ?? process.env
      });
    } catch {
      await options.client.releaseViewerLease(contextId, viewer).catch(() => undefined);
      return "failed";
    }
    try { await launch(command); return "opened"; }
    catch (error) {
      if (!(error instanceof WindowLaunchFailure) || error.uncertain) return "uncertain";
      await options.client.releaseViewerLease(contextId, viewer).catch(() => undefined);
      return "failed";
    }
  }
  return {
    open(contextId) {
      const existing = pending.get(contextId);
      if (existing !== undefined) return existing;
      const opening = open(contextId).finally(() => pending.delete(contextId));
      pending.set(contextId, opening);
      return opening;
    }
  };
}
