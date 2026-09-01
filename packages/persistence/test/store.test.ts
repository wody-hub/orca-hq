import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandEnvelope } from "@orca-hq/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { ControlStore, migrate, openDatabase } from "../src/index.js";

const command = {
  commandId: "cmd-1",
  idempotencyKey: "slack:T123:171.001",
  channel: "slack",
  externalMessageId: "171.001",
  externalThreadId: "171.001",
  principalId: "owner",
  receivedAt: "2026-09-01T00:00:00.000Z",
  text: "Ship the foundation"
} satisfies CommandEnvelope;

const outboxMessage = {
  id: "outbox-1",
  channel: "slack" as const,
  destination: "C123",
  template: "command_received",
  payload: { commandId: command.commandId },
  nextAttemptAt: "2026-09-01T00:00:00.000Z"
};

const temporaryDirectories: string[] = [];
const openDatabases: Array<{ close(): void }> = [];

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "orca-hq-persistence-"));
  temporaryDirectories.push(directory);
  return join(directory, "control.sqlite");
}

function createStore(path = temporaryDatabasePath()): ControlStore {
  const database = openDatabase(path);
  openDatabases.push(database);
  return new ControlStore(database);
}

function testStore(): ControlStore {
  return createStore();
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ControlStore", () => {
  it("inserts one command and one inbox event for duplicate delivery", () => {
    const store = testStore();

    expect(store.insertCommand(command)).toBe("inserted");
    expect(store.insertCommand(command)).toBe("duplicate");
    expect(store.listCommands()).toHaveLength(1);
    expect(store.listInboxEvents()).toHaveLength(1);
    expect(store.listAuditEvents()).toHaveLength(1);
  });

  it("deduplicates a provider event even when its command identifiers change", () => {
    const database = openDatabase(temporaryDatabasePath());
    openDatabases.push(database);
    const store = new ControlStore(database);
    const replay = {
      ...command,
      commandId: "cmd-replayed",
      idempotencyKey: "incorrectly-changed-idempotency-key",
      principalId: "unrelated-principal"
    };

    expect(store.insertCommand(command)).toBe("inserted");
    expect(store.insertCommand(replay)).toBe("duplicate");
    expect(store.listCommands()).toEqual([command]);
    expect(store.listInboxEvents()).toHaveLength(1);
    expect(database.prepare("SELECT id FROM principals ORDER BY id").all()).toEqual([
      { id: command.principalId }
    ]);
  });

  it("rolls back the command, inbox event, principal, and audit when inbox insertion fails", () => {
    const database = openDatabase(temporaryDatabasePath());
    openDatabases.push(database);
    database.exec(`
      CREATE TRIGGER force_inbox_failure
      BEFORE INSERT ON inbox_events
      BEGIN
        SELECT RAISE(ABORT, 'forced inbox failure');
      END
    `);
    const store = new ControlStore(database);

    expect(() => store.insertCommand(command)).toThrow("forced inbox failure");
    expect(store.listCommands()).toEqual([]);
    expect(store.listInboxEvents()).toEqual([]);
    expect(store.listAuditEvents()).toEqual([]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM principals").get()
    ).toEqual({ count: 0 });
  });

  it("does not lose an outbox message across reopen", () => {
    const path = temporaryDatabasePath();
    const firstDatabase = openDatabase(path);
    new ControlStore(firstDatabase).enqueueOutbox(outboxMessage);
    firstDatabase.close();

    const reopenedDatabase = openDatabase(path);
    openDatabases.push(reopenedDatabase);
    const claimed = new ControlStore(reopenedDatabase).claimOutbox(
      "2026-09-01T00:00:00.000Z"
    );

    expect(claimed).toMatchObject({ id: outboxMessage.id });
  });

  it("claims only due pending outbox messages and increments attempts", () => {
    const store = testStore();
    expect(store.enqueueOutbox(outboxMessage)).toBe("inserted");
    expect(store.enqueueOutbox(outboxMessage)).toBe("duplicate");

    expect(store.claimOutbox("2026-08-31T23:59:59.999Z", "worker-1")).toBeUndefined();
    expect(store.claimOutbox(outboxMessage.nextAttemptAt, "worker-1")).toMatchObject({
      id: outboxMessage.id,
      state: "claimed",
      attempts: 1,
      claimedBy: "worker-1",
      claimedAt: outboxMessage.nextAttemptAt
    });
    expect(store.claimOutbox(outboxMessage.nextAttemptAt, "worker-2")).toBeUndefined();
  });

  it("does not claim a mixed-precision timestamp that is still in the future", () => {
    const store = testStore();
    store.enqueueOutbox({
      ...outboxMessage,
      id: "outbox-mixed-precision",
      nextAttemptAt: "2026-09-01T00:00:00.100Z"
    });

    expect(store.claimOutbox("2026-09-01T00:00:00Z")).toBeUndefined();
    expect(store.claimOutbox("2026-09-01T00:00:00.100Z")).toMatchObject({
      id: "outbox-mixed-precision",
      nextAttemptAt: "2026-09-01T00:00:00.100Z"
    });
  });

  it("does not lose an audit event across reopen", () => {
    const path = temporaryDatabasePath();
    const firstDatabase = openDatabase(path);
    new ControlStore(firstDatabase).appendAudit({
      id: "audit-1",
      subjectId: command.commandId,
      eventType: "command.accepted",
      data: { route: "foundation-control-plane" }
    });
    firstDatabase.close();

    const reopenedDatabase = openDatabase(path);
    openDatabases.push(reopenedDatabase);
    const events = new ControlStore(reopenedDatabase).listAuditEvents();

    expect(events).toEqual([
      expect.objectContaining({
        id: "audit-1",
        subjectId: command.commandId,
        eventType: "command.accepted",
        data: { route: "foundation-control-plane" }
      })
    ]);
  });

  it("rejects malformed command, outbox, and audit JSON read from storage", () => {
    const database = openDatabase(temporaryDatabasePath());
    openDatabases.push(database);
    const store = new ControlStore(database);
    store.insertCommand(command);
    store.enqueueOutbox(outboxMessage);
    store.appendAudit({
      id: "audit-corrupt",
      subjectId: command.commandId,
      eventType: "command.accepted",
      data: {}
    });

    database.prepare("UPDATE commands SET payload_json = '{}' WHERE id = ?").run(command.commandId);
    expect(() => store.listCommands()).toThrow(ZodError);

    database.prepare("UPDATE inbox_events SET payload_json = '{}' WHERE command_id = ?").run(command.commandId);
    expect(() => store.listInboxEvents()).toThrow(ZodError);

    database.prepare("UPDATE outbox_messages SET payload_json = '[]' WHERE id = ?").run(outboxMessage.id);
    expect(() => store.claimOutbox(outboxMessage.nextAttemptAt)).toThrow(ZodError);

    database.prepare("UPDATE audit_events SET data_json = '[]' WHERE id = ?").run("audit-corrupt");
    expect(() => store.listAuditEvents()).toThrow(ZodError);
  });
});

describe("SQLite migrations", () => {
  it("creates every logical table and remains idempotent", () => {
    const database = openDatabase(temporaryDatabasePath());
    openDatabases.push(database);

    migrate(database);
    migrate(database);

    const tables = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "approvals",
      "audit_events",
      "channel_cursors",
      "command_payloads",
      "commands",
      "dispatches",
      "execution_proposals",
      "inbox_events",
      "outbox_messages",
      "principal_bindings",
      "principals",
      "project_aliases",
      "project_registry_entries",
      "runs",
      "schema_migrations",
      "tasks",
      "worktree_locks"
    ]);
    expect(database.prepare("SELECT version, name FROM schema_migrations").all()).toEqual([
      { version: 1, name: "initial" }
    ]);
  });

  it("rolls back a migration that cannot complete", () => {
    const database = new Database(temporaryDatabasePath());
    openDatabases.push(database);
    database.exec("CREATE TABLE commands (collision TEXT)");

    expect(() => migrate(database)).toThrow("table commands already exists");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'principals'").get()
    ).toBeUndefined();
  });

  it("opens databases in WAL mode with foreign keys enabled", () => {
    const database = openDatabase(temporaryDatabasePath());
    openDatabases.push(database);

    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);

    expect(() => database.prepare(`
      INSERT INTO inbox_events (
        id, command_id, event_type, provider, provider_event_id, payload_json, created_at
      ) VALUES ('invalid', 'missing-command', 'command_received', 'slack', 'event-1', '{}', ?)
    `).run("2026-09-01T00:00:00.000Z")).toThrow("FOREIGN KEY constraint failed");
  });

  it("indexes command idempotency, provider inbox IDs, and due outbox claims", () => {
    const database = openDatabase(temporaryDatabasePath());
    openDatabases.push(database);

    const commandIndex = database.pragma("index_info(commands_idempotency_key_unique)") as Array<{
      name: string;
    }>;
    const inboxIndex = database.pragma("index_info(inbox_provider_event_unique)") as Array<{
      name: string;
    }>;
    const outboxIndex = database.pragma("index_info(outbox_claim_index)") as Array<{
      name: string;
    }>;
    const commandIndexes = database.pragma("index_list(commands)") as Array<{
      name: string;
      unique: number;
    }>;
    const inboxIndexes = database.pragma("index_list(inbox_events)") as Array<{
      name: string;
      unique: number;
    }>;

    expect(commandIndex.map(({ name }) => name)).toEqual(["idempotency_key"]);
    expect(inboxIndex.map(({ name }) => name)).toEqual(["provider", "provider_event_id"]);
    expect(outboxIndex.map(({ name }) => name)).toEqual(["state", "next_attempt_at"]);
    expect(commandIndexes).toContainEqual(expect.objectContaining({
      name: "commands_idempotency_key_unique",
      unique: 1
    }));
    expect(inboxIndexes).toContainEqual(expect.objectContaining({
      name: "inbox_provider_event_unique",
      unique: 1
    }));
  });
});
