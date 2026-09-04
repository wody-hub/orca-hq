import { describe, expect, it } from "vitest";

import {
  createLaunchdOperations,
  renderLaunchAgent,
  type LaunchdPaths,
  type LaunchdPort
} from "../src/launchd.js";

const paths: LaunchdPaths = {
  label: "com.orcahq.gateway",
  domain: "gui/501",
  plistPath: "/Users/pilot/Library/LaunchAgents/com.orcahq.gateway.plist",
  nodePath: "/opt/homebrew/bin/node",
  gatewayEntryPath: "/Users/pilot/orca-hq/apps/gateway/dist/entry.js",
  workingDirectory: "/Users/pilot/orca-hq",
  standardOutPath: "/Users/pilot/Library/Logs/orca-hq/gateway.log",
  standardErrorPath: "/Users/pilot/Library/Logs/orca-hq/gateway.error.log"
};

class FakeLaunchd implements LaunchdPort {
  readonly calls: Array<Readonly<{ executable: string; arguments: readonly string[] }>> = [];
  readonly directories: string[] = [];
  readonly removedFiles: string[] = [];
  readonly writes: Array<Readonly<{ path: string; text: string; mode: number }>> = [];
  printResult: Readonly<{ exitCode: number; stdout: string }> = { exitCode: 0, stdout: "state = running\n\tpid = 428" };
  bootstrapExitCode = 0;
  readonly pathInspections = new Map<string, Readonly<{
    exists: boolean;
    file: boolean;
    readable: boolean;
    executable: boolean;
  }>>([
    [paths.nodePath, { exists: true, file: true, readable: true, executable: true }],
    [paths.gatewayEntryPath, { exists: true, file: true, readable: true, executable: false }]
  ]);

  async createDirectory(path: string): Promise<void> {
    this.directories.push(path);
  }

  async writeText(path: string, text: string, mode: number): Promise<void> {
    this.writes.push({ path, text, mode });
  }

  async removeFile(path: string): Promise<void> {
    this.removedFiles.push(path);
  }

  async inspectPath(path: string) {
    return this.pathInspections.get(path)
      ?? { exists: false, file: false, readable: false, executable: false };
  }

  async command(executable: string, arguments_: readonly string[]) {
    this.calls.push({ executable, arguments: [...arguments_] });
    if (arguments_[0] === "print") return this.printResult;
    if (arguments_[0] === "bootstrap") return { exitCode: this.bootstrapExitCode, stdout: "" };
    return { exitCode: 0, stdout: "" };
  }
}

describe("launchd supervision", () => {
  it("renders a user LaunchAgent with explicit paths and restart policy", () => {
    // Break caught: crash-only supervision leaves the central gateway stopped after a normal non-zero exit.
    const plist = renderLaunchAgent(paths);

    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).not.toContain("<key>Crashed</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>/Users/pilot/orca-hq/apps/gateway/dist/entry.js</string>");
    expect(plist).not.toContain("~");
    expect(plist).not.toContain("TOKEN");
  });

  it("installs and controls only the exact user-domain LaunchAgent", async () => {
    // Break caught: service commands can fall back to a system domain or an inexact process kill.
    const fake = new FakeLaunchd();
    const launchd = createLaunchdOperations(paths, fake);

    await launchd.install();
    await launchd.start();
    await launchd.stop();

    expect(fake.writes).toEqual([{
      path: paths.plistPath,
      text: renderLaunchAgent(paths),
      mode: 0o600
    }]);
    expect(fake.calls).toEqual([
      { executable: "launchctl", arguments: ["bootstrap", "gui/501", paths.plistPath] },
      { executable: "launchctl", arguments: ["kickstart", "gui/501/com.orcahq.gateway"] },
      { executable: "launchctl", arguments: ["bootout", "gui/501/com.orcahq.gateway"] }
    ]);
  });

  it("reports running and stopped status from a fake launchctl boundary", async () => {
    // Break caught: `hq status` treats an unloaded service as a command exception or exposes raw launchctl output.
    const fake = new FakeLaunchd();
    const launchd = createLaunchdOperations(paths, fake);

    await expect(launchd.status()).resolves.toEqual({ state: "running", pid: 428 });
    fake.printResult = { exitCode: 3, stdout: "credential=must-not-escape" };
    await expect(launchd.status()).resolves.toEqual({ state: "stopped" });
  });

  it("uninstalls only the exact user-domain service and plist", async () => {
    // Break caught: lifecycle uninstall can leave an auto-restarting plist or remove a broader launchd target.
    const fake = new FakeLaunchd();
    const launchd = createLaunchdOperations(paths, fake);

    await launchd.uninstall();

    expect(fake.calls).toEqual([
      { executable: "launchctl", arguments: ["bootout", "gui/501/com.orcahq.gateway"] }
    ]);
    expect(fake.removedFiles).toEqual([paths.plistPath]);
  });

  it("treats an already loaded exact LaunchAgent as an idempotent install", async () => {
    // Break caught: a second `hq start` fails only because bootstrap reports that this exact label is already loaded.
    const fake = new FakeLaunchd();
    fake.bootstrapExitCode = 5;
    fake.printResult = {
      exitCode: 0,
      stdout: `program = ${paths.nodePath}\narguments = {\n\t${paths.nodePath}\n\t${paths.gatewayEntryPath}\n}\n`
    };
    const launchd = createLaunchdOperations(paths, fake);

    await expect(launchd.install()).resolves.toBeUndefined();

    expect(fake.calls.slice(-2)).toEqual([
      { executable: "launchctl", arguments: ["bootstrap", "gui/501", paths.plistPath] },
      { executable: "launchctl", arguments: ["print", "gui/501/com.orcahq.gateway"] }
    ]);
  });

  it("rejects an already loaded LaunchAgent whose executable definition differs", async () => {
    // Break caught: install can report success while launchd still holds an older node/entry definition.
    const fake = new FakeLaunchd();
    fake.bootstrapExitCode = 5;
    fake.printResult = {
      exitCode: 0,
      stdout: `program = /old/node\narguments = {\n\t/old/node\n\t/old/gateway.js\n}\n`
    };

    await expect(createLaunchdOperations(paths, fake).install()).rejects.toMatchObject({
      code: "launchd_definition_mismatch"
    });
  });

  it("refuses installation before writing a plist when the gateway entry is unavailable", async () => {
    // Break caught: a missing source-build entry can be installed under KeepAlive and crash-loop forever.
    const fake = new FakeLaunchd();
    fake.pathInspections.set(paths.gatewayEntryPath, {
      exists: false,
      file: false,
      readable: false,
      executable: false
    });

    await expect(createLaunchdOperations(paths, fake).install()).rejects.toMatchObject({
      code: "launchd_path_unavailable"
    });
    expect(fake.writes).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("refuses installation when the pinned Node executable is not executable", async () => {
    // Break caught: an obsolete version-manager Node path can be persisted into a crash-only LaunchAgent.
    const fake = new FakeLaunchd();
    fake.pathInspections.set(paths.nodePath, {
      exists: true,
      file: true,
      readable: true,
      executable: false
    });

    await expect(createLaunchdOperations(paths, fake).install()).rejects.toMatchObject({
      code: "launchd_path_unavailable"
    });
  });
});
