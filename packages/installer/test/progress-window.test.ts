import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createProgressWindowManager, buildWatchCommand, canOpenProgressWindow, terminalWindowScript, WindowLaunchFailure } from "../src/progress-window.js";
import type { ProgressClient } from "../src/progress-client.js";

function fixture() {
  const leases = new Set<string>();
  const client = {
    acquireViewerLease: vi.fn(async (id: string, viewerInstanceId: string) => {
      if (leases.has(id)) return { acquired: false, viewerInstanceId, expiresAt: "later" };
      leases.add(id);
      return { acquired: true, viewerInstanceId, leaseToken: "token", expiresAt: "later" };
    }),
    releaseViewerLease: vi.fn(async (id: string) => { leases.delete(id); })
  } as unknown as ProgressClient;
  const launch = vi.fn(async (_command: string) => undefined);
  const manager = createProgressWindowManager({ client, launch, nodePath: "/node", cliPath: "/hq/cli.js", env: {} });
  return { client, launch, manager, leases };
}

describe("progress windows", () => {
  it("opens different contexts and reuses a live lease even across concurrent open calls", async () => {
    const f = fixture();
    await Promise.all([f.manager.open("ctx_a"), f.manager.open("ctx_a"), f.manager.open("ctx_b")]);
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(await f.manager.open("ctx_a")).toBe("reused");
    f.leases.delete("ctx_a"); // Closing watch releases its lease; only a new explicit input opens again.
    expect(await f.manager.open("ctx_a")).toBe("opened");
    expect(f.launch).toHaveBeenCalledTimes(3);
  });
  it("releases a definitely failed open but retains the lease after an uncertain launch", async () => {
    const f = fixture();
    f.launch.mockRejectedValueOnce(new WindowLaunchFailure("denied", false));
    expect(await f.manager.open("ctx_a")).toBe("failed");
    expect(f.client.releaseViewerLease).toHaveBeenCalledTimes(1);
    f.launch.mockRejectedValueOnce(new WindowLaunchFailure("timeout", true));
    expect(await f.manager.open("ctx_a")).toBe("uncertain");
    expect(f.client.releaseViewerLease).toHaveBeenCalledTimes(1);
    expect(await f.manager.open("ctx_a")).toBe("reused");
    expect(f.launch).toHaveBeenCalledTimes(2);
  });
  it("passes paths and config as literal shell arguments and never interpolates AppleScript", () => {
    const path = "/tmp/space ' quote $(echo INJECTED) `echo injected`";
    const directory = mkdtempSync(join(tmpdir(), "hq-window-"));
    const cliPath = join(directory, "space ' quote $(echo INJECTED) `echo injected`.cjs");
    try {
      writeFileSync(cliPath, "process.stdout.write(JSON.stringify({args:process.argv.slice(2),config:process.env.XDG_CONFIG_HOME}))");
      const command = buildWatchCommand({ nodePath: process.execPath, cliPath, contextId: "ctx_a", viewer: { viewerInstanceId: "viewer", leaseToken: "token" }, env: { XDG_CONFIG_HOME: path } });
      const result = JSON.parse(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }));
      expect(result).toEqual({ config: path, args: ["watch", "--context", "ctx_a", "--viewer-instance", "viewer", "--lease-token", "token"] });
    } finally { rmSync(directory, { recursive: true, force: true }); }
    expect(terminalWindowScript).toContain("do script (item 1 of argv)");
    expect(terminalWindowScript).not.toContain("in front window");
    expect(() => buildWatchCommand({ nodePath: path, cliPath: path, contextId: "ctx; touch /tmp/pwn", viewer: { viewerInstanceId: "v", leaseToken: "t" } })).toThrow();
  });
  it.each([
    { platform: "linux", inputIsTTY: true, outputIsTTY: true, env: {} },
    { platform: "darwin", inputIsTTY: false, outputIsTTY: true, env: {} },
    { platform: "darwin", inputIsTTY: true, outputIsTTY: false, env: {} },
    { platform: "darwin", inputIsTTY: true, outputIsTTY: true, env: { SSH_CONNECTION: "remote" } },
    { platform: "darwin", inputIsTTY: true, outputIsTTY: true, env: { SSH_TTY: "/dev/tty" } }
  ])("disables automatic GUI in unsupported environments: %j", options => {
    expect(canOpenProgressWindow(options)).toBe(false);
  });
  it("allows only local interactive macOS auto windows", () => {
    expect(canOpenProgressWindow({ platform: "darwin", inputIsTTY: true, outputIsTTY: true, env: {} })).toBe(true);
  });
});
