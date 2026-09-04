import { describe, expect, it } from "vitest";

import type { DoctorPorts } from "../src/doctor.js";
import {
  createDefaultLifecycleHostComposition,
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
      pilotConfiguration: pass, macosCpu: pass, nodePnpm: pass, orcaCapabilities: pass, codexAuthentication: pass,
      claudeAuthentication: pass, tailscaleTailnet: pass, slackSocketMode: pass,
      telegramAllowlistedChat: pass, openAiVoice: pass, keychain: pass, sqliteDirectory: pass,
      launchd: pass, projectDiscovery: pass
    },
    registry: { review: async () => ({ status: "pass", curatedProjects: 5 }) }
  };
}

function fixture(options: Readonly<{ migrationError?: Error }> = {}): Readonly<{
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
      async migrate(path, program) {
        calls.push(`sqlite:migrate:${path}:cwd=${program}`);
        if (options.migrationError !== undefined) throw options.migrationError;
      }
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
  it("uses one custom pilot database path for update and uninstall", async () => {
    // Break caught: the real CLI factory can ignore pilot.json and inspect the hard-coded control.sqlite instead.
    const subject = fixture();
    const databasePath = "/Users/pilot/Library/Application Support/orca-hq/custom.sqlite";
    const configPath = "/pilot/xdg/orca-hq/pilot.json";
    const composition = await createDefaultLifecycleHostComposition({
      configuration: {
        homeDirectory: () => "/Users/pilot",
        configDirectory: () => "/pilot/xdg",
        async readText(path) {
          expect(path).toBe(configPath);
          return JSON.stringify({
            schema: "orca-hq.private-pilot.v1",
            databasePath,
            projectRegistryPath: "/pilot/projects.yaml",
            credentialAccounts: []
          });
        }
      },
      program: subject.paths.program,
      machine: subject.machine,
      launchd: subject.launchd,
      doctor: passingDoctor(),
      now: () => new Date("2026-09-04T01:02:03.000Z")
    });

    await expect(composition.update.run({ revision: targetRevision })).resolves.toMatchObject({
      backup: { sourceRevision: previousRevision }
    });
    await composition.uninstall.run({
      removeData: false,
      confirmation: composition.uninstall.programConfirmationPhrase
    });

    expect(subject.calls.filter((call) => call.startsWith("sqlite:active:"))).toEqual([
      `sqlite:active:${databasePath}`,
      `sqlite:active:${databasePath}`,
      `sqlite:active:${databasePath}`
    ]);
  });

  it("fails closed before mutation when pilot database configuration is missing, malformed, or outside durable data", async () => {
    // Break caught: invalid canonical configuration can fall back to a guessed database and mutate source or launchd.
    for (const text of [
      undefined,
      "{not-json",
      JSON.stringify({
        schema: "orca-hq.private-pilot.v1",
        databasePath: "/tmp/not-orca-hq.sqlite",
        projectRegistryPath: "/pilot/projects.yaml",
        credentialAccounts: []
      })
    ]) {
      const subject = fixture();
      await expect(createDefaultLifecycleHostComposition({
        configuration: {
          homeDirectory: () => "/Users/pilot",
          configDirectory: () => "/pilot/xdg",
          readText: async () => text
        },
        program: subject.paths.program,
        machine: subject.machine,
        launchd: subject.launchd,
        doctor: passingDoctor()
      })).rejects.toMatchObject({ code: "lifecycle_config_invalid" });
      expect(subject.calls).toEqual([]);
    }
  });

  it("backs up and restores the XDG pilot config without selecting a stale fallback file", async () => {
    // Break caught: lifecycle backup can copy ~/.config/pilot.json while setup and doctor use XDG_CONFIG_HOME.
    const subject = fixture({ migrationError: new Error("migration failed") });
    const databasePath = "/Users/pilot/Library/Application Support/orca-hq/custom.sqlite";
    const configPath = "/pilot/xdg/orca-hq/pilot.json";
    const composition = await createDefaultLifecycleHostComposition({
      configuration: {
        homeDirectory: () => "/Users/pilot",
        configDirectory: () => "/pilot/xdg",
        readText: async () => JSON.stringify({
          schema: "orca-hq.private-pilot.v1",
          databasePath,
          projectRegistryPath: "/pilot/projects.yaml",
          credentialAccounts: []
        })
      },
      program: subject.paths.program,
      machine: subject.machine,
      launchd: subject.launchd,
      doctor: passingDoctor(),
      now: () => new Date("2026-09-04T01:02:03.000Z")
    });

    await expect(composition.update.run({ revision: targetRevision })).rejects.toMatchObject({
      code: "update_failed",
      stage: "migration"
    });

    const backupConfig = "/Users/pilot/Library/Application Support/orca-hq/backups/2026-09-04T01-02-03-000Z/pilot.json";
    expect(subject.calls).toContain(`copy:${configPath}:${backupConfig}`);
    expect(subject.calls).toContain(`copy:${backupConfig}:${configPath}`);
    expect(subject.calls.some((call) => call.includes("/Users/pilot/.config/orca-hq/pilot.json"))).toBe(false);
  });

  it("uses ~/.config as the lifecycle pilot config fallback", async () => {
    // Break caught: a shared config helper could honor XDG but lose the established default fallback.
    const subject = fixture();
    const expectedConfigPath = "/Users/pilot/.config/orca-hq/pilot.json";
    await createDefaultLifecycleHostComposition({
      configuration: {
        homeDirectory: () => "/Users/pilot",
        configDirectory: () => undefined,
        async readText(path) {
          expect(path).toBe(expectedConfigPath);
          return JSON.stringify({
            schema: "orca-hq.private-pilot.v1",
            databasePath: "/Users/pilot/Library/Application Support/orca-hq/control.sqlite",
            projectRegistryPath: "/pilot/projects.yaml",
            credentialAccounts: []
          });
        }
      },
      program: subject.paths.program,
      machine: subject.machine,
      launchd: subject.launchd,
      doctor: passingDoctor()
    });
  });

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

    await composition.uninstall.run({
      removeData: false,
      confirmation: composition.uninstall.programConfirmationPhrase
    });

    expect(subject.calls).toEqual([
      "sqlite:active:/pilot/data/control.sqlite",
      "launchd:uninstall",
      "remove:/pilot/program"
    ]);
  });
});
