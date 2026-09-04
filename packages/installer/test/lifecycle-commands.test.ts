import { describe, expect, it } from "vitest";

import {
  createBackupService,
  type BackupReceipt,
  type BackupServicePorts
} from "../src/backup.js";
import {
  createUninstall,
  dataRemovalConfirmationPhrase,
  programRemovalConfirmationPhrase
} from "../src/uninstall.js";
import {
  createUpdate,
  prepareUpdate,
  type GatewayUpdateStatus,
  type UpdateContext
} from "../src/update.js";

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
  statuses: GatewayUpdateStatus[];
  doctorResult: { ok: boolean };
  backupError?: Error;
  restoreRevisionError?: Error;
  statusError?: Error;
  migrationError?: Error;
} {
  const calls: string[] = [];
  const statuses: GatewayUpdateStatus[] = [{ activeOrUncertainDispatches: 0 }];
  const doctorResult = { ok: true };
  const fixture: UpdateContext & {
    calls: string[];
    statuses: GatewayUpdateStatus[];
    doctorResult: { ok: boolean };
    backupError?: Error;
    restoreRevisionError?: Error;
    statusError?: Error;
    migrationError?: Error;
  } = {
    calls,
    statuses,
    doctorResult,
    targetRevision: "rev-after",
    gateway: {
      async status() {
        calls.push("gateway:status");
        if (fixture.statusError !== undefined) throw fixture.statusError;
        return statuses.shift() ?? { activeOrUncertainDispatches: 0 };
      },
      async stop() { calls.push("gateway:stop"); },
      async start() { calls.push("gateway:start"); }
    },
    source: {
      async currentRevision() { calls.push("source:current"); return "rev-before"; },
      async verifyRevision(revision) { calls.push(`source:verify:${revision}`); return true; },
      async installRevision(options) {
        calls.push(`source:install:${options.revision}:frozen=${String(options.frozenLockfile)}`);
      },
      async restoreRevision(revision) {
        calls.push(`source:restore:${revision}`);
        if (fixture.restoreRevisionError !== undefined) throw fixture.restoreRevisionError;
      }
    },
    preflight: {
      async run(options) { calls.push(`preflight:readOnly=${String(options.readOnly)}`); return { ok: true }; }
    },
    backups: {
      async createOnlineBackup(options) {
        calls.push(`backup:create:config=${String(options.includeConfig)}:secrets=${String(options.includeSecrets)}`);
        if (fixture.backupError !== undefined) throw fixture.backupError;
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
    fixture.statuses[0] = { activeOrUncertainDispatches: 1 };

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({ code: "active_work" });

    expect(fixture.calls).toEqual(["gateway:status"]);
  });

  it.each([
    {},
    { activeOrUncertainDispatches: -1 },
    { activeOrUncertainDispatches: Number.NaN },
    { activeOrUncertainDispatches: 0, uncertainDispatches: 1 },
    { activeOrUncertainDispatches: 0, nonterminalDispatches: 1, uncertainDispatches: 0 }
  ] satisfies GatewayUpdateStatus[])("fails closed for malformed or contradictory gateway status %#", async (status) => {
    // Break caught: malformed or contradictory status must never be interpreted as an idle gateway.
    const fixture = updateFixture();
    fixture.statuses[0] = status;

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({ code: "active_work" });

    expect(fixture.calls).toEqual(["gateway:status"]);
  });

  it("normalizes gateway status rejection to active_work", async () => {
    // Break caught: an unavailable gateway status could leak an arbitrary provider error or permit maintenance.
    const fixture = updateFixture();
    fixture.statusError = new Error("provider token leaked");

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
    Object.assign(fixture.source, {
      verifyRevision: async (revision: string): Promise<boolean> => {
        fixture.calls.push(`source:verify:${revision}`);
        // Intentional unsafe fixture: a broken provider can omit a value despite the declared port contract.
        return undefined as unknown as boolean;
      }
    });

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
    Object.assign(fixture.preflight, {
      run: async (options: Readonly<{ readOnly: true }>): Promise<Readonly<{ ok: boolean }>> => {
        fixture.calls.push(`preflight:readOnly=${String(options.readOnly)}`);
        // Intentional unsafe fixture: runtime adapters can violate their static response contract.
        return undefined as unknown as { ok: boolean };
      }
    });

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({
      code: "update_failed",
      stage: "preflight",
      cause: { code: "preflight_failed" }
    });

    expect(fixture.calls).toEqual([
      "gateway:status",
      "source:current",
      "source:verify:rev-after",
      "source:install:rev-after:frozen=true",
      "preflight:readOnly=true",
      "source:restore:rev-before"
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
      "gateway:status",
      "gateway:stop",
      "backup:create:config=true:secrets=false",
      "migrations:run",
      "gateway:start",
      "doctor:json"
    ]);
  });

  it("restores the prior program when preflight fails before a backup exists", async () => {
    // Break caught: a preflight failure after installation can leave the new revision on disk without a receipt.
    const fixture = updateFixture();
    const cause = new Error("preflight rejected");
    Object.assign(fixture.preflight, {
      run: async (options: Readonly<{ readOnly: true }>): Promise<Readonly<{ ok: boolean }>> => {
        fixture.calls.push(`preflight:readOnly=${String(options.readOnly)}`);
        throw cause;
      }
    });

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({
      code: "update_failed",
      stage: "preflight",
      cause,
      rollbackComplete: true
    });

    expect(fixture.calls.slice(-2)).toEqual(["preflight:readOnly=true", "source:restore:rev-before"]);
  });

  it("restores the prior program when the second active-work check closes the maintenance window", async () => {
    // Break caught: work appearing after preflight can strand the newly installed revision on disk.
    const fixture = updateFixture();
    fixture.statuses.push({ activeOrUncertainDispatches: 1 });

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({
      code: "update_failed",
      stage: "second_active_work_check",
      rollbackComplete: true
    });

    expect(fixture.calls.slice(-2)).toEqual(["gateway:status", "source:restore:rev-before"]);
    expect(fixture.calls).not.toContain("gateway:stop");
  });

  it("restores and restarts the prior program when backup creation fails after stop", async () => {
    // Break caught: stop-before-backup can leave both the new source and gateway in a failed maintenance state.
    const fixture = updateFixture();
    const cause = new Error("online backup failed");
    fixture.backupError = cause;

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({
      code: "update_failed",
      stage: "backup",
      cause,
      rollbackComplete: true
    });

    expect(fixture.calls.slice(-4)).toEqual([
      "gateway:stop",
      "backup:create:config=true:secrets=false",
      "source:restore:rev-before",
      "gateway:start"
    ]);
  });

  it("restores program, config, and database before restarting after migration failure", async () => {
    // Break caught: a failed migration can leave the new process running on an incompatible database.
    const fixture = updateFixture();
    fixture.migrationError = new Error("migration broke");

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({
      code: "update_failed",
      backup: receipt,
      stage: "migration",
      cause: fixture.migrationError
    });

    expect(fixture.calls.slice(-5)).toEqual([
      "migrations:run",
      "gateway:stop",
      "source:restore:rev-before",
      "backup:restore:2026-09-04T01-02-03-000Z:config=true:secrets=false",
      "gateway:start"
    ]);
  });

  it("marks rollback incomplete when a production restore stage fails and still attempts the remainder", async () => {
    // Break caught: one failed rollback action could be hidden or prevent compatible data and gateway recovery.
    const fixture = updateFixture();
    fixture.migrationError = new Error("migration broke");
    fixture.restoreRevisionError = new Error("source restore broke");

    await expect(createUpdate(fixture).run()).rejects.toMatchObject({
      code: "update_failed",
      stage: "migration",
      rollbackComplete: false
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
    const status: { current: GatewayUpdateStatus } = { current: { activeOrUncertainDispatches: 0 } };
    let statusError: Error | undefined;
    const uninstall = createUninstall({
      paths,
      protectedPaths: ["/Users/pilot"],
      gateway: {
        async status() {
          calls.push("gateway:status");
          if (statusError !== undefined) throw statusError;
          return status.current;
        }
      },
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
    return {
      calls, existing, paths, status, uninstall,
      rejectStatus(error: Error) { statusError = error; }
    };
  }

  it("rejects a program path nested inside durable data", () => {
    // Break caught: a misconfigured program target could point at the database and erase it during default uninstall.
    expect(() => createUninstall({
      paths: {
        program: "/Users/pilot/Library/Application Support/orca-hq/runtime.sqlite",
        data: "/Users/pilot/Library/Application Support/orca-hq",
        database: "/Users/pilot/Library/Application Support/orca-hq/runtime.sqlite"
      },
      gateway: { async status() { return { activeOrUncertainDispatches: 0 }; } },
      launchd: { async uninstall() {} },
      files: { async removeProgram() {}, async removeData() {} }
    })).toThrow("Program and durable data paths are not safely separated.");
  });

  it("preserves Application Support data on default uninstall", async () => {
    // Break caught: uninstalling only the program could recursively include durable user state.
    const subject = fixture();

    await subject.uninstall.run({
      removeData: false,
      confirmation: programRemovalConfirmationPhrase(subject.paths.program)
    });

    expect(subject.existing.has(subject.paths.database)).toBe(true);
    expect(subject.existing.has(subject.paths.config)).toBe(true);
    expect(subject.existing.has(subject.paths.data)).toBe(true);
    expect(subject.existing.has(subject.paths.program)).toBe(false);
    expect(subject.calls).toEqual([
      "gateway:status",
      "launchd:uninstall",
      `files:remove-program:${subject.paths.program}`
    ]);
  });

  it.each([
    { activeOrUncertainDispatches: 1 },
    {},
    { activeOrUncertainDispatches: 0, nonterminalDispatches: 1 }
  ] satisfies GatewayUpdateStatus[])("refuses uninstall for active, malformed, or contradictory status %#", async (status) => {
    // Break caught: uninstall must not remove launchd or program state while work may still be active.
    const subject = fixture();
    subject.status.current = status;

    await expect(subject.uninstall.run({
      removeData: false,
      confirmation: programRemovalConfirmationPhrase(subject.paths.program)
    })).rejects.toMatchObject({ code: "active_work" });

    expect(subject.calls).toEqual(["gateway:status"]);
    expect(subject.existing.has(subject.paths.program)).toBe(true);
  });

  it("refuses uninstall when gateway status is unavailable", async () => {
    // Break caught: status transport failure must fail closed before launchd or filesystem mutation.
    const subject = fixture();
    subject.rejectStatus(new Error("status unavailable"));

    await expect(subject.uninstall.run({
      removeData: false,
      confirmation: programRemovalConfirmationPhrase(subject.paths.program)
    })).rejects.toMatchObject({ code: "active_work" });

    expect(subject.calls).toEqual(["gateway:status"]);
  });

  it("rejects an inexact data-removal phrase before making any change", async () => {
    // Break caught: a boolean flag or near-match could remove all durable state without path-specific intent.
    const subject = fixture();

    await expect(subject.uninstall.run({ removeData: true, confirmation: "REMOVE DATA" }))
      .rejects.toMatchObject({ code: "confirmation_required" });

    expect(subject.calls).toEqual(["gateway:status"]);
    expect(subject.existing.has(subject.paths.program)).toBe(true);
    expect(subject.existing.has(subject.paths.database)).toBe(true);
  });

  it("rejects missing or inexact program confirmation before launchd or filesystem mutation", async () => {
    // Break caught: default uninstall can remove the program tree with no path-specific confirmation.
    for (const confirmation of [undefined, "REMOVE ORCA HQ PROGRAM"]) {
      const subject = fixture();
      await expect(subject.uninstall.run({
        removeData: false,
        ...(confirmation === undefined ? {} : { confirmation })
      }))
        .rejects.toMatchObject({ code: "confirmation_required" });
      expect(subject.calls).toEqual(["gateway:status"]);
      expect(subject.existing.has(subject.paths.program)).toBe(true);
    }
  });

  it.each([
    "/",
    "/Users",
    "/Users/pilot",
    "/Users/pilot/source/orca-hq/../..",
    "/usr",
    "/pilot/unsafe\nprogram"
  ])("rejects dangerous program target %s", (program) => {
    // Break caught: normalization can resolve a configured program target to home, an ancestor, or a top-level directory.
    expect(() => createUninstall({
      paths: {
        program,
        data: "/Users/pilot/Library/Application Support/orca-hq",
        database: "/Users/pilot/Library/Application Support/orca-hq/control.sqlite"
      },
      protectedPaths: ["/Users/pilot"],
      gateway: { async status() { return { activeOrUncertainDispatches: 0 }; } },
      launchd: { async uninstall() {} },
      files: { async removeProgram() {}, async removeData() {} }
    })).toThrow();
  });

  it("removes only the configured data path after the exact generated phrase", async () => {
    // Break caught: confirmed removal could target a parent directory or use a phrase unrelated to the actual path.
    const subject = fixture();

    await subject.uninstall.run({
      removeData: true,
      confirmation: dataRemovalConfirmationPhrase(subject.paths.program, subject.paths.data)
    });

    expect(subject.calls).toEqual([
      "gateway:status",
      "launchd:uninstall",
      `files:remove-program:${subject.paths.program}`,
      `files:remove-data:${subject.paths.data}`
    ]);
    expect(subject.existing.has(subject.paths.database)).toBe(false);
  });
});
