import { describe, expect, it } from "vitest";

import {
  createLaunchdOperations,
  type LaunchdPaths,
  type LaunchdPort
} from "../../../packages/installer/src/launchd.js";
import { reconcileStartup } from "../src/reconcile.js";

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

class FakeLoginLaunchd implements LaunchdPort {
  plist = "";
  loaded = false;
  running = false;
  processStarts = 0;

  async createDirectory(): Promise<void> {}

  async writeText(_path: string, text: string): Promise<void> {
    this.plist = text;
  }

  async inspectPath(path: string) {
    return {
      exists: path === paths.nodePath || path === paths.gatewayEntryPath,
      file: true,
      readable: true,
      executable: path === paths.nodePath
    };
  }

  async command(_executable: string, arguments_: readonly string[]) {
    if (arguments_[0] === "bootstrap") {
      this.loaded = true;
      this.#startAtLoad();
      return { exitCode: 0, stdout: "" };
    }
    if (arguments_[0] === "kickstart") {
      if (!this.running) this.#start();
      return { exitCode: 0, stdout: "" };
    }
    if (arguments_[0] === "print") {
      return this.loaded
        ? { exitCode: 0, stdout: `state = ${this.running ? "running" : "waiting"}\n` }
        : { exitCode: 3, stdout: "" };
    }
    if (arguments_[0] === "bootout") {
      this.loaded = false;
      this.running = false;
      return { exitCode: 0, stdout: "" };
    }
    return { exitCode: 1, stdout: "" };
  }

  login(): void {
    this.loaded = this.plist.length > 0;
    this.#startAtLoad();
  }

  killProcess(): void {
    this.running = false;
    if (this.plist.includes("<key>Crashed</key>")) this.#start();
  }

  logout(): void {
    this.loaded = false;
    this.running = false;
  }

  #startAtLoad(): void {
    if (this.loaded && this.plist.includes("<key>RunAtLoad</key>")) this.#start();
  }

  #start(): void {
    this.running = true;
    this.processStarts += 1;
  }
}

describe("deterministic private-pilot restart fixture", () => {
  it("bootstraps at Mac login and reconciles a killed process without duplicate dispatch or release", async () => {
    // Break caught: login/restart recovery can omit bootstrap, duplicate uncertain work, or release its worker.
    const launchctl = new FakeLoginLaunchd();
    const operations = createLaunchdOperations(paths, launchctl);
    await operations.install();
    expect(launchctl.processStarts).toBe(1);

    launchctl.logout();
    launchctl.login();
    expect(launchctl.processStarts).toBe(2);

    launchctl.killProcess();
    expect(launchctl.processStarts).toBe(3);

    const fakeOrca = {
      duplicateDispatches: 0,
      uncertainWorkerReleases: 0,
      async inspectDispatch() { return { kind: "unknown" as const }; },
      async dispatchWorker() { this.duplicateDispatches += 1; },
      async releaseWorker() { this.uncertainWorkerReleases += 1; }
    };
    const report = await reconcileStartup({
      store: {
        async recoverOutboxClaims() {},
        async listNonterminalDispatches() {
          return [{
            dispatchId: "dispatch-uncertain",
            receiptId: "orca-dispatch-uncertain",
            receipt: "orca-dispatch-uncertain"
          }];
        }
      },
      channels: { async resumeCursors() {} },
      orca: fakeOrca,
      locks: { async reviewExpired() {} },
      outbox: { async drain() {} },
      audit: { async record() {} }
    });

    expect(report).toEqual([{
      dispatchId: "dispatch-uncertain",
      receiptId: "orca-dispatch-uncertain",
      state: "review_required"
    }]);
    expect({
      duplicateDispatches: fakeOrca.duplicateDispatches,
      uncertainWorkerReleases: fakeOrca.uncertainWorkerReleases
    }).toEqual({ duplicateDispatches: 0, uncertainWorkerReleases: 0 });
  });
});
