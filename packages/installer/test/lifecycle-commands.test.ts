import { describe, expect, it } from "vitest";

import {
  createBackupService,
  type BackupReceipt,
  type BackupServicePorts
} from "../src/backup.js";
import { createUninstall, dataRemovalConfirmationPhrase } from "../src/uninstall.js";
import { createUpdate, prepareUpdate, type UpdateContext } from "../src/update.js";

const receipt: BackupReceipt = {
  id: "2026-09-04T01-02-03-000Z",
  path: "/pilot/backups/2026-09-04T01-02-03-000Z",
  databasePath: "/pilot/backups/2026-09-04T01-02-03-000Z/runtime.sqlite",
  configPath: "/pilot/backups/2026-09-04T01-02-03-000Z/pilot.json",
  createdAt: "2026-09-04T01:02:03.000Z",
  sourceRevision: "rev-before",
  schemaVersion: 4,
  includesConfig: true,
  includesSecrets: false
};

function updateFixture(): UpdateContext & {
  calls: string[];
  status: { activeOrUncertainDispatches: number };
  doctorResult: { ok: boolean };
  migrationError?: Error;
} {
  const calls: string[] = [];
  const status = { activeOrUncertainDispatches: 0 };
  const doctorResult = { ok: true };
  const fixture: UpdateContext & {
    calls: string[];
    status: { activeOrUncertainDispatches: number };
    doctorResult: { ok: boolean };
    migrationError?: Error;
  } = {
    calls,
    status,
    doctorResult,
    targetRevision: "rev-after",
    gateway: {
      async status() { calls.push("gateway:status"); return status; },
      async stop() { calls.push("gateway:stop"); },
      async start() { calls.push("gateway:start"); }
    },
    source: {
      async currentRevision() { calls.push("source:current"); return "rev-before"; },
      async verifyRevision(revision) { calls.push(`source:verify:${revision}`); return true; },
      async installRevision(options) {
        calls.push(`source:install:${options.revision}:frozen=${String(options.frozenLockfile)}`);
      },
      async restoreRevision(revision) { calls.push(`source:restore:${revision}`); }
    },
    preflight: {
      async run(options) { calls.push(`preflight:readOnly=${String(options.readOnly)}`); return { ok: true }; }
    },
    backups: {
      async createOnlineBackup(options) {
        calls.push(`backup:create:config=${String(options.includeConfig)}:secrets=${String(options.includeSecrets)}`);
        return receipt;
      },
      async restore(backup, options) {
        calls.push(`backup:restore:${backup.id}:config=${String(options.includeConfig)}:secrets=${String(options.includeSecrets)}`);
      }
    },
    migrations: {
      async run() {
        calls.push("migrations:run");
        if (fixture.migrationError !== undefined) throw fixture.migrationError;
      }
    },
    doctor: {
      async run(options) {
        calls.push(`doctor:${options.format}`);
        return doctorResult;
      }
    }
  };
  return fixture;
}

describe("backup lifecycle", () => {
  it("creates a timestamped SQLite backup with config and no secret surface", async () => {
    // Break caught: backups can be ambiguous, use an unsafe file copy, or accidentally acquire Keychain secrets.
    const calls: string[] = [];
    const ports: BackupServicePorts = {
      paths: {
        backupDirectory: "/pilot/backups",
        configPath: "/pilot/config/pilot.json"
      },
      database: {
        async backupTo(path) { calls.push(`database:backup:${path}`); },
        async restoreFrom(path) { calls.push(`database:restore:${path}`); }
      },
      files: {
        async createDirectory(path) { calls.push(`files:mkdir:${path}`); },
        async copyFile(source, destination) { calls.push(`files:copy:${source}:${destination}`); },
        async writeText(path, _text) { calls.push(`files:write:${path}`); }
      },
      metadata: {
        async schemaVersion() { return 4; },
        async sourceRevision() { return "rev-before"; }
      },
      now: () => new Date("2026-09-04T01:02:03.000Z")
    };

    const result = await createBackupService(ports).createOnlineBackup({
      includeConfig: true,
      includeSecrets: false
    });

    expect(result).toEqual(receipt);
    expect(calls).toEqual([
      "files:mkdir:/pilot/backups/2026-09-04T01-02-03-000Z",
      "database:backup:/pilot/backups/2026-09-04T01-02-03-000Z/runtime.sqlite",
      "files:copy:/pilot/config/pilot.json:/pilot/backups/2026-09-04T01-02-03-000Z/pilot.json",
      "files:write:/pilot/backups/2026-09-04T01-02-03-000Z/manifest.json"
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("restores the database and config from the receipt without a secret input", async () => {
    // Break caught: rollback could restore only SQLite or copy config in the wrong direction.
    const calls: string[] = [];
    const service = createBackupService({
      paths: {
        backupDirectory: "/pilot/backups",
        configPath: "/pilot/config/pilot.json"
      },
      database: {
        async backupTo() {},
        async restoreFrom(path) { calls.push(`database:restore:${path}`); }
      },
      files: {
        async createDirectory() {},
        async copyFile(source, destination) { calls.push(`files:copy:${source}:${destination}`); },
        async writeText() {}
      },
      metadata: {
        async schemaVersion() { return 4; },
        async sourceRevision() { return "rev-before"; }
      }
    });

    await service.restore(receipt, { includeConfig: true, includeSecrets: false });

    expect(calls).toEqual([
      "database:restore:/pilot/backups/2026-09-04T01-02-03-000Z/runtime.sqlite",
      "files:copy:/pilot/backups/2026-09-04T01-02-03-000Z/pilot.json:/pilot/config/pilot.json"
    ]);
  });
});

describe("guarded source update", () => {
  it("refuses update while worker state is active or uncertain", async () => {
    // Break caught: an update could interrupt or duplicate a live/unknown Orca worker.
    const fixture = updateFixture();
    fixture.status.activeOrUncertainDispatches = 1;

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({ code: "active_work" });

    expect(fixture.calls).toEqual(["gateway:status"]);
  });

  it("prepares a stopped gateway backup without including secrets", async () => {
    // Break caught: the low-level preparation gate can back up or stop without first proving worker quiescence.
    const fixture = updateFixture();

    await expect(prepareUpdate(fixture)).resolves.toEqual(receipt);

    expect(fixture.calls).toEqual([
      "gateway:status",
      "gateway:stop",
      "backup:create:config=true:secrets=false"
    ]);
  });

  it("requires explicit revision verification success", async () => {
    // Break caught: an adapter that forgets to return its verification result could install an unverified revision.
    const fixture = updateFixture();
    fixture.source.verifyRevision = async (revision) => {
      fixture.calls.push(`source:verify:${revision}`);
      return undefined;
    };

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({ code: "revision_mismatch" });

    expect(fixture.calls).toEqual([
      "gateway:status",
      "source:current",
      "source:verify:rev-after"
    ]);
  });

  it("requires explicit read-only preflight success", async () => {
    // Break caught: a missing preflight result could be mistaken for approval and enter the maintenance window.
    const fixture = updateFixture();
    fixture.preflight.run = async (options) => {
      fixture.calls.push(`preflight:readOnly=${String(options.readOnly)}`);
      return undefined;
    };

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({ code: "preflight_failed" });

    expect(fixture.calls).toEqual([
      "gateway:status",
      "source:current",
      "source:verify:rev-after",
      "source:install:rev-after:frozen=true",
      "preflight:readOnly=true"
    ]);
  });

  it("verifies, installs, preflights, backs up, migrates, starts, and diagnoses in order", async () => {
    // Break caught: the active program can be stopped before a safe target and rollback point are established.
    const fixture = updateFixture();

    await expect(createUpdate(fixture).run()).resolves.toEqual({
      previousRevision: "rev-before",
      revision: "rev-after",
      backup: receipt
    });

    expect(fixture.calls).toEqual([
      "gateway:status",
      "source:current",
      "source:verify:rev-after",
      "source:install:rev-after:frozen=true",
      "preflight:readOnly=true",
      "backup:create:config=true:secrets=false",
      "gateway:status",
      "gateway:stop",
      "migrations:run",
      "gateway:start",
      "doctor:json"
    ]);
  });

  it("restores program, config, and database before restarting after migration failure", async () => {
    // Break caught: a failed migration can leave the new process running on an incompatible database.
    const fixture = updateFixture();
    fixture.migrationError = new Error("migration broke");

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({
      code: "update_failed",
      backup: receipt
    });

    expect(fixture.calls.slice(-5)).toEqual([
      "migrations:run",
      "gateway:stop",
      "source:restore:rev-before",
      "backup:restore:2026-09-04T01-02-03-000Z:config=true:secrets=false",
      "gateway:start"
    ]);
  });
});

describe("safe uninstall", () => {
  function fixture() {
    const paths = {
      program: "/pilot/source/orca-hq",
      data: "/Users/pilot/Library/Application Support/orca-hq",
      database: "/Users/pilot/Library/Application Support/orca-hq/runtime.sqlite",
      config: "/Users/pilot/Library/Application Support/orca-hq/pilot.json"
    };
    const existing = new Set([paths.program, paths.data, paths.database, paths.config]);
    const calls: string[] = [];
    const uninstall = createUninstall({
      paths,
      launchd: {
        async uninstall() { calls.push("launchd:uninstall"); }
      },
      files: {
        async removeProgram(path) { calls.push(`files:remove-program:${path}`); existing.delete(path); },
        async removeData(path) {
          calls.push(`files:remove-data:${path}`);
          existing.delete(path);
          existing.delete(paths.database);
        }
      }
    });
    return { calls, existing, paths, uninstall };
  }

  it("rejects a program path nested inside durable data", () => {
    // Break caught: a misconfigured program target could point at the database and erase it during default uninstall.
    expect(() => createUninstall({
      paths: {
        program: "/Users/pilot/Library/Application Support/orca-hq/runtime.sqlite",
        data: "/Users/pilot/Library/Application Support/orca-hq",
        database: "/Users/pilot/Library/Application Support/orca-hq/runtime.sqlite"
      },
      launchd: { async uninstall() {} },
      files: { async removeProgram() {}, async removeData() {} }
    })).toThrow("Program and durable data paths are not safely separated.");
  });

  it("preserves Application Support data on default uninstall", async () => {
    // Break caught: uninstalling only the program could recursively include durable user state.
    const subject = fixture();

    await subject.uninstall.run({ removeData: false });

    expect(subject.existing.has(subject.paths.database)).toBe(true);
    expect(subject.existing.has(subject.paths.config)).toBe(true);
    expect(subject.existing.has(subject.paths.data)).toBe(true);
    expect(subject.existing.has(subject.paths.program)).toBe(false);
    expect(subject.calls).toEqual([
      "launchd:uninstall",
      `files:remove-program:${subject.paths.program}`
    ]);
  });

  it("rejects an inexact data-removal phrase before making any change", async () => {
    // Break caught: a boolean flag or near-match could remove all durable state without path-specific intent.
    const subject = fixture();

    await expect(subject.uninstall.run({ removeData: true, confirmation: "REMOVE DATA" }))
      .rejects.toMatchObject({ code: "confirmation_required" });

    expect(subject.calls).toEqual([]);
    expect(subject.existing.has(subject.paths.program)).toBe(true);
    expect(subject.existing.has(subject.paths.database)).toBe(true);
  });

  it("removes only the configured data path after the exact generated phrase", async () => {
    // Break caught: confirmed removal could target a parent directory or use a phrase unrelated to the actual path.
    const subject = fixture();

    await subject.uninstall.run({
      removeData: true,
      confirmation: dataRemovalConfirmationPhrase(subject.paths.data)
    });

    expect(subject.calls).toEqual([
      "launchd:uninstall",
      `files:remove-program:${subject.paths.program}`,
      `files:remove-data:${subject.paths.data}`
    ]);
    expect(subject.existing.has(subject.paths.database)).toBe(false);
  });
});
