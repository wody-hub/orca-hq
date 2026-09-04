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
  readonly writes: Array<Readonly<{ path: string; text: string; mode: number }>> = [];
  printResult: Readonly<{ exitCode: number; stdout: string }> = { exitCode: 0, stdout: "state = running\n\tpid = 428" };
  bootstrapExitCode = 0;

  async createDirectory(path: string): Promise<void> {
    this.directories.push(path);
  }

  async writeText(path: string, text: string, mode: number): Promise<void> {
    this.writes.push({ path, text, mode });
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
    // Break caught: a login-started gateway can depend on shell expansion or leak a credential into its plist.
    const plist = renderLaunchAgent(paths);

    expect(plist).toContain("<key>KeepAlive</key>");
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
      { executable: "launchctl", arguments: ["kickstart", "-k", "gui/501/com.orcahq.gateway"] },
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

  it("treats an already loaded exact LaunchAgent as an idempotent install", async () => {
    // Break caught: a second `hq start` fails only because bootstrap reports that this exact label is already loaded.
    const fake = new FakeLaunchd();
    fake.bootstrapExitCode = 5;
    const launchd = createLaunchdOperations(paths, fake);

    await expect(launchd.install()).resolves.toBeUndefined();

    expect(fake.calls.slice(-2)).toEqual([
      { executable: "launchctl", arguments: ["bootstrap", "gui/501", paths.plistPath] },
      { executable: "launchctl", arguments: ["print", "gui/501/com.orcahq.gateway"] }
    ]);
  });
});
