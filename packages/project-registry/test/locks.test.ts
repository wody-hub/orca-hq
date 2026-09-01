import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ControlStore,
  openDatabase,
  type WorktreeLease
} from "../../persistence/src/index.js";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { WorktreeLockService } from "../src/index.js";

const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), "orca-hq-locks-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "control.sqlite"));
  databases.push(database);
  return database;
}

function seedDispatch(database: Database.Database, dispatchId: string): void {
  const now = "2026-09-01T10:00:00.000Z";
  const commandId = `command:${dispatchId}`;
  const runId = `run:${dispatchId}`;
  const taskId = `task:${dispatchId}`;
  database.prepare(`
    INSERT INTO principals (id, payload_json, created_at, updated_at)
    VALUES (?, '{}', ?, ?)
  `).run(`principal:${dispatchId}`, now, now);
  database.prepare(`
    INSERT INTO commands (
      id, idempotency_key, channel, external_message_id, principal_id,
      received_at, payload_json, created_at
    ) VALUES (?, ?, 'slack', ?, ?, ?, '{}', ?)
  `).run(commandId, `key:${dispatchId}`, `external:${dispatchId}`, `principal:${dispatchId}`, now, now);
  database.prepare(`
    INSERT INTO runs (id, command_id, state, payload_json, created_at, updated_at)
    VALUES (?, ?, 'active', '{}', ?, ?)
  `).run(runId, commandId, now, now);
  database.prepare(`
    INSERT INTO tasks (id, run_id, state, payload_json, created_at, updated_at)
    VALUES (?, ?, 'active', '{}', ?, ?)
  `).run(taskId, runId, now, now);
  database.prepare(`
    INSERT INTO dispatches (id, task_id, state, payload_json, created_at, updated_at)
    VALUES (?, ?, 'active', '{}', ?, ?)
  `).run(dispatchId, taskId, now, now);
}

function lease(lockKey: string, dispatchId: string, overrides: Partial<WorktreeLease> = {}): WorktreeLease {
  return {
    lockKey,
    commandId: `command:${dispatchId}`,
    taskId: `task:${dispatchId}`,
    projectKey: "project-a",
    worktreePath: `/srv/worktrees/${dispatchId}`,
    branch: `dispatch/${dispatchId}`,
    dispatchId,
    acquiredAt: "2026-09-01T10:00:00.000Z",
    heartbeatAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2026-09-01T10:05:00.000Z",
    ...overrides
  };
}

function setup(...dispatchIds: string[]): {
  database: Database.Database;
  locks: WorktreeLockService;
} {
  const database = createDatabase();
  for (const dispatchId of dispatchIds) seedDispatch(database, dispatchId);
  return {
    database,
    locks: new WorktreeLockService(new ControlStore(database))
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorktreeLockService", () => {
  it("allows only one editing lease per lock key", () => {
    const { locks } = setup("dispatch:1", "dispatch:2");

    expect(locks.acquire(lease("repo:a", "dispatch:1"))).toMatchObject({ kind: "acquired" });
    expect(locks.acquire(lease("repo:a", "dispatch:2"))).toMatchObject({
      kind: "conflict",
      lease: { dispatchId: "dispatch:1" }
    });
  });

  it("returns the existing lease for an idempotent owner acquire", () => {
    const { locks } = setup("dispatch:1");
    const first = locks.acquire(lease("repo:a", "dispatch:1"));

    expect(locks.acquire(lease("repo:a", "dispatch:1", {
      worktreePath: "/different/path"
    }))).toEqual(first);
  });

  it("heartbeats only the owning dispatch and persists across reopen", () => {
    const { database, locks } = setup("dispatch:1", "dispatch:2");
    locks.acquire(lease("repo:a", "dispatch:1"));

    expect(locks.heartbeat({
      lockKey: "repo:a",
      dispatchId: "dispatch:2",
      heartbeatAt: "2026-09-01T10:01:00.000Z",
      expiresAt: "2026-09-01T10:06:00.000Z"
    })).toMatchObject({ kind: "conflict" });
    expect(locks.heartbeat({
      lockKey: "repo:a",
      dispatchId: "dispatch:1",
      heartbeatAt: "2026-09-01T10:01:00.000Z",
      expiresAt: "2026-09-01T10:06:00.000Z"
    })).toMatchObject({
      kind: "heartbeated",
      lease: {
        heartbeatAt: "2026-09-01T10:01:00.000Z",
        expiresAt: "2026-09-01T10:06:00.000Z"
      }
    });

    expect(new WorktreeLockService(new ControlStore(database)).get("repo:a")).toMatchObject({
      heartbeatAt: "2026-09-01T10:01:00.000Z"
    });
  });

  it("releases only the owning dispatch and allows a later acquisition", () => {
    const { locks } = setup("dispatch:1", "dispatch:2");
    locks.acquire(lease("repo:a", "dispatch:1"));

    expect(locks.release({
      lockKey: "repo:a",
      dispatchId: "dispatch:2",
      releasedAt: "2026-09-01T10:02:00.000Z"
    })).toMatchObject({ kind: "conflict" });
    expect(locks.release({
      lockKey: "repo:a",
      dispatchId: "dispatch:1",
      releasedAt: "2026-09-01T10:02:00.000Z"
    })).toEqual({ kind: "released" });
    expect(locks.acquire(lease("repo:a", "dispatch:2", {
      acquiredAt: "2026-09-01T10:02:01.000Z",
      heartbeatAt: "2026-09-01T10:02:01.000Z",
      expiresAt: "2026-09-01T10:07:01.000Z"
    }))).toMatchObject({ kind: "acquired", lease: { dispatchId: "dispatch:2" } });
  });

  it("fails closed when an existing lease expired until reconciliation releases it", () => {
    const { locks } = setup("dispatch:1", "dispatch:2");
    locks.acquire(lease("repo:a", "dispatch:1"));

    expect(locks.acquire(lease("repo:a", "dispatch:2", {
      acquiredAt: "2026-09-01T10:05:00Z",
      heartbeatAt: "2026-09-01T10:05:00Z",
      expiresAt: "2026-09-01T10:10:00Z"
    }))).toMatchObject({
      kind: "review_required",
      reason: "expired_lease_requires_reconciliation",
      lease: { dispatchId: "dispatch:1" }
    });
  });

  it("uses parsed timestamps instead of lexical mixed-precision ordering", () => {
    const { locks } = setup("dispatch:1", "dispatch:2");
    locks.acquire(lease("repo:a", "dispatch:1", {
      expiresAt: "2026-09-01T10:00:00.100Z"
    }));

    expect(locks.acquire(lease("repo:a", "dispatch:2", {
      acquiredAt: "2026-09-01T10:00:00Z",
      heartbeatAt: "2026-09-01T10:00:00Z",
      expiresAt: "2026-09-01T10:05:00Z"
    }))).toMatchObject({ kind: "conflict" });
  });

  it("rolls back an immediate acquire transaction when persistence fails", () => {
    const { database, locks } = setup("dispatch:1");
    database.exec(`
      CREATE TRIGGER reject_lock_insert
      BEFORE INSERT ON worktree_locks
      BEGIN
        SELECT RAISE(ABORT, 'forced lock failure');
      END
    `);

    expect(() => locks.acquire(lease("repo:a", "dispatch:1"))).toThrow("forced lock failure");
    expect(database.prepare("SELECT COUNT(*) AS count FROM worktree_locks").get())
      .toEqual({ count: 0 });
  });

  it("resolves sequential transaction contenders to one acquisition and one conflict", () => {
    const { database, locks } = setup("dispatch:1", "dispatch:2");
    const competingDatabase = openDatabase(database.name);
    databases.push(competingDatabase);
    const competingLocks = new WorktreeLockService(new ControlStore(competingDatabase));

    const results = [
      locks.acquire(lease("repo:a", "dispatch:1")),
      competingLocks.acquire(lease("repo:a", "dispatch:2"))
    ];

    expect(results.map(({ kind }) => kind)).toEqual(["acquired", "conflict"]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM worktree_locks WHERE state = 'active'").get())
      .toEqual({ count: 1 });
  });
});
