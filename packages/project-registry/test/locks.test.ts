import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ControlStore,
  openDatabase
} from "../../persistence/src/index.js";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  WorktreeLockService,
  type Clock,
  type WorktreeLeaseRequest
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];

class TestClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  set(instant: string): void {
    this.current = new Date(instant);
  }
}

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

function lease(
  lockKey: string,
  dispatchId: string,
  overrides: Partial<WorktreeLeaseRequest> = {}
): WorktreeLeaseRequest {
  return {
    lockKey,
    commandId: `command:${dispatchId}`,
    taskId: `task:${dispatchId}`,
    projectKey: "project-a",
    worktreePath: `/srv/worktrees/${dispatchId}`,
    branch: `dispatch/${dispatchId}`,
    dispatchId,
    ...overrides
  };
}

function setup(...dispatchIds: string[]): {
  database: Database.Database;
  locks: WorktreeLockService;
  clock: TestClock;
} {
  const database = createDatabase();
  const clock = new TestClock(new Date("2026-09-01T10:00:00.000Z"));
  for (const dispatchId of dispatchIds) seedDispatch(database, dispatchId);
  return {
    database,
    locks: new WorktreeLockService(new ControlStore(database), clock),
    clock
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

  it("heartbeats only the owning dispatch", () => {
    const { locks } = setup("dispatch:1", "dispatch:2");
    locks.acquire(lease("repo:a", "dispatch:1"));

    expect(locks.heartbeat({
      lockKey: "repo:a",
      dispatchId: "dispatch:2"
    })).toMatchObject({ kind: "conflict" });
  });

  it("extends a lease by the fixed duration from authoritative clock time", () => {
    const { database, locks, clock } = setup("dispatch:1");
    locks.acquire(lease("repo:a", "dispatch:1"));
    clock.set("2026-09-01T10:01:00.000Z");

    expect(locks.heartbeat({
      lockKey: "repo:a",
      dispatchId: "dispatch:1"
    })).toMatchObject({
      kind: "heartbeated",
      lease: {
        heartbeatAt: "2026-09-01T10:01:00.000Z",
        expiresAt: "2026-09-01T10:06:00.000Z"
      }
    });

    expect(new WorktreeLockService(new ControlStore(database), clock).get("repo:a")).toMatchObject({
      heartbeatAt: "2026-09-01T10:01:00.000Z"
    });
  });

  it("does not revive an expired lease when its owner sends a late heartbeat", () => {
    const { locks, clock } = setup("dispatch:1");
    const acquired = locks.acquire(lease("repo:a", "dispatch:1"));
    clock.set("2026-09-01T10:05:00.001Z");

    expect(locks.heartbeat({
      lockKey: "repo:a",
      dispatchId: "dispatch:1"
    })).toMatchObject({
      kind: "review_required",
      reason: "expired_lease_requires_reconciliation"
    });
    expect(locks.get("repo:a")).toEqual(acquired.kind === "acquired" ? acquired.lease : undefined);
  });

  it("rejects a non-monotonic authoritative heartbeat without updating SQLite", () => {
    const { locks, clock } = setup("dispatch:1");
    locks.acquire(lease("repo:a", "dispatch:1"));
    clock.set("2026-09-01T10:01:00.000Z");
    const firstHeartbeat = locks.heartbeat({ lockKey: "repo:a", dispatchId: "dispatch:1" });
    clock.set("2026-09-01T10:00:30.000Z");

    expect(locks.heartbeat({
      lockKey: "repo:a",
      dispatchId: "dispatch:1"
    })).toMatchObject({
      kind: "review_required",
      reason: "non_monotonic_heartbeat"
    });
    expect(locks.get("repo:a")).toEqual(
      firstHeartbeat.kind === "heartbeated" ? firstHeartbeat.lease : undefined
    );
  });

  it("releases only the owning dispatch and allows a later acquisition", () => {
    const { locks, clock } = setup("dispatch:1", "dispatch:2");
    locks.acquire(lease("repo:a", "dispatch:1"));
    clock.set("2026-09-01T10:02:00.000Z");

    expect(locks.release({
      lockKey: "repo:a",
      dispatchId: "dispatch:2"
    })).toMatchObject({ kind: "conflict" });
    expect(locks.release({
      lockKey: "repo:a",
      dispatchId: "dispatch:1"
    })).toEqual({ kind: "released" });
    expect(locks.acquire(lease("repo:a", "dispatch:2")))
      .toMatchObject({ kind: "acquired", lease: { dispatchId: "dispatch:2" } });
  });

  it("fails closed when an existing lease expired until reconciliation releases it", () => {
    const { locks, clock } = setup("dispatch:1", "dispatch:2");
    locks.acquire(lease("repo:a", "dispatch:1"));
    clock.set("2026-09-01T10:05:00.000Z");

    expect(locks.acquire(lease("repo:a", "dispatch:2"))).toMatchObject({
      kind: "review_required",
      reason: "expired_lease_requires_reconciliation",
      lease: { dispatchId: "dispatch:1" }
    });
  });

  it("stores authoritative timestamps in canonical ISO form", () => {
    const { locks, clock } = setup("dispatch:1");
    clock.set("2026-09-01T10:00:00.100Z");

    expect(locks.acquire(lease("repo:a", "dispatch:1"))).toMatchObject({
      kind: "acquired",
      lease: {
        acquiredAt: "2026-09-01T10:00:00.100Z",
        heartbeatAt: "2026-09-01T10:00:00.100Z",
        expiresAt: "2026-09-01T10:05:00.100Z"
      }
    });
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
    const competingLocks = new WorktreeLockService(
      new ControlStore(competingDatabase),
      new TestClock(new Date("2026-09-01T10:00:00.000Z"))
    );

    const results = [
      locks.acquire(lease("repo:a", "dispatch:1")),
      competingLocks.acquire(lease("repo:a", "dispatch:2"))
    ];

    expect(results.map(({ kind }) => kind)).toEqual(["acquired", "conflict"]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM worktree_locks WHERE state = 'active'").get())
      .toEqual({ count: 1 });
  });
});
