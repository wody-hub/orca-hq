import { describe, expect, it } from "vitest";

import type { DoctorPorts } from "../src/doctor.js";
import {
  createLifecycleHostComposition,
  type LifecycleHostMachinePort,
  type LifecycleHostPaths
} from "../src/lifecycle-host.js";
import type { LaunchdOperations, LaunchdStatus } from "../src/launchd.js";

const previousRevision = "b".repeat(40);
const targetRevision = "a".repeat(40);

function passingDoctor(): DoctorPorts {
  const pass = async () => "pass" as const;
  return {
    checks: {
      macosCpu: pass, nodePnpm: pass, orcaCapabilities: pass, codexAuthentication: pass,
      claudeAuthentication: pass, tailscaleTailnet: pass, slackSocketMode: pass,
      telegramAllowlistedChat: pass, openAiVoice: pass, keychain: pass, sqliteDirectory: pass,
      launchd: pass, projectDiscovery: pass
    },
    registry: { review: async () => ({ status: "pass", curatedProjects: 5 }) }
  };
}

function fixture(): Readonly<{
  calls: string[];
  paths: LifecycleHostPaths;
  machine: LifecycleHostMachinePort;
  launchd: LaunchdOperations;
}> {
  const calls: string[] = [];
  let installedRevision = previousRevision;
  const paths: LifecycleHostPaths = {
    program: "/pilot/program",
    data: "/pilot/data",
    database: "/pilot/data/control.sqlite",
    config: "/pilot/config/pilot.json",
    backups: "/pilot/data/backups"
  };
  const machine: LifecycleHostMachinePort = {
    async command(executable, arguments_, options) {
      calls.push(`command:${executable}:${arguments_.join(" ")}:cwd=${options.cwd}`);
      if (arguments_.includes("rev-parse") && arguments_.includes("HEAD")) {
        return { exitCode: 0, stdout: `${installedRevision}\n` };
      }
      if (arguments_.includes("rev-parse")) return { exitCode: 0, stdout: `${targetRevision}\n` };
      if (arguments_.includes("checkout")) installedRevision = arguments_.at(-1) ?? installedRevision;
      return { exitCode: 0, stdout: "" };
    },
    async createDirectory(path) { calls.push(`mkdir:${path}`); },
    async copyFile(source, destination) { calls.push(`copy:${source}:${destination}`); },
    async writeText(path) { calls.push(`write:${path}`); },
    async removeDirectory(path) { calls.push(`remove:${path}`); },
    database: {
      async backup(source, destination) { calls.push(`sqlite:backup:${source}:${destination}`); },
      async schemaVersion(path) { calls.push(`sqlite:schema:${path}`); return 2; },
      async nonterminalDispatches(path) { calls.push(`sqlite:active:${path}`); return 0; },
      async migrate(path, program) { calls.push(`sqlite:migrate:${path}:cwd=${program}`); }
    }
  };
  let status: LaunchdStatus = { state: "running", pid: 42 };
  const launchd: LaunchdOperations = {
    async install() { calls.push("launchd:install"); status = { state: "running", pid: 43 }; },
    async start() { calls.push("launchd:start"); status = { state: "running", pid: 43 }; },
    async stop() { calls.push("launchd:stop"); status = { state: "stopped" }; },
    async status() { calls.push("launchd:status"); return status; },
    async uninstall() { calls.push("launchd:uninstall"); status = { state: "stopped" }; }
  };
  return { calls, paths, machine, launchd };
}

describe("production lifecycle host composition", () => {
  it("uses exact source, frozen install, read-only preflight, online SQLite, schema, and launchd ports", async () => {
    // Break caught: the production composition can silently omit one of the host safety boundaries required by update.
    const subject = fixture();
    const composition = createLifecycleHostComposition({
      paths: subject.paths,
      machine: subject.machine,
      launchd: subject.launchd,
      doctor: passingDoctor(),
      now: () => new Date("2026-09-04T01:02:03.000Z")
    });

    await expect(composition.update.run({ revision: targetRevision })).resolves.toMatchObject({
      previousRevision,
      revision: targetRevision,
      backup: { schemaVersion: 2, sourceRevision: previousRevision }
    });

    expect(subject.calls).toContain(`command:git:-C /pilot/program rev-parse --verify ${targetRevision}^{commit}:cwd=/pilot/program`);
    expect(subject.calls).toContain(`command:git:-C /pilot/program checkout --detach ${targetRevision}:cwd=/pilot/program`);
    expect(subject.calls).toContain("command:pnpm:install --frozen-lockfile:cwd=/pilot/program");
    expect(subject.calls).toContain("command:pnpm:typecheck:cwd=/pilot/program");
    expect(subject.calls).toContain("sqlite:active:/pilot/data/control.sqlite");
    expect(subject.calls).toContain("sqlite:schema:/pilot/data/control.sqlite");
    expect(subject.calls).toContain("sqlite:backup:/pilot/data/control.sqlite:/pilot/data/backups/2026-09-04T01-02-03-000Z/runtime.sqlite");
    expect(subject.calls).toContain("sqlite:migrate:/pilot/data/control.sqlite:cwd=/pilot/program");
    expect(subject.calls.indexOf("launchd:stop"))
      .toBeLessThan(subject.calls.indexOf("sqlite:backup:/pilot/data/control.sqlite:/pilot/data/backups/2026-09-04T01-02-03-000Z/runtime.sqlite"));
  });

  it("routes uninstall through status, exact launchd removal, and exact filesystem paths", async () => {
    // Break caught: production uninstall can bypass active-work status or delete a broader host path.
    const subject = fixture();
    const composition = createLifecycleHostComposition({
      paths: subject.paths,
      machine: subject.machine,
      launchd: subject.launchd,
      doctor: passingDoctor()
    });

    await composition.uninstall.run({ removeData: false });

    expect(subject.calls).toEqual([
      "sqlite:active:/pilot/data/control.sqlite",
      "launchd:uninstall",
      "remove:/pilot/program"
    ]);
  });
});
