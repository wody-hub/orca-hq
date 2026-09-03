import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalService,
  type ApprovalConfirmation,
  type CommandEnvelope,
  type ExecutionProposal,
  type PersistedApprovalRequest,
  type PrincipalBinding
} from "@orca-hq/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  ControlStore,
  WorkerCompletionConflictError,
  migrate,
  openDatabase,
  type JsonValue
} from "../src/index.js";
import { initialMigration } from "../src/migrations/001-initial.js";

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

const approvalOwner = {
  principalId: "owner-1",
  slackUserIds: ["U1"],
  telegramUserIds: [],
  telegramChatIds: [],
  tailscaleLoginNames: ["owner@example.test"],
  roles: ["owner"]
} satisfies PrincipalBinding;

function approvalProposal(overrides: Partial<ExecutionProposal> = {}): ExecutionProposal {
  return {
    proposalId: "proposal-approval-service",
    commandId: command.commandId,
    selectedProjectKey: "project-a",
    routeCandidates: [{ projectKey: "project-a", score: 1, evidence: ["explicit"] }],
    baseRef: "main",
    allowedScope: ["src/**"],
    prohibitedEffects: ["delete_data"],
    acceptanceCommands: ["pnpm test"],
    riskLevel: "L3",
    tasks: [{ localId: "implement", title: "Implement", dependsOn: [], role: "implement", preferredAgent: "codex" }],
    ...overrides
  };
}

function persistExecutionProposal(database: Database.Database, proposal: ExecutionProposal): void {
  database.prepare(`
    INSERT INTO execution_proposals (
      id, command_id, project_registry_entry_id, state, payload_json, created_at, updated_at
    ) VALUES (?, ?, NULL, 'proposed', '{}', ?, ?)
  `).run(proposal.proposalId, proposal.commandId, "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z");
}

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
  it("converts an unpersisted approval proposal into a stable domain error", () => {
    // Break caught: an ordinary proposal-save ordering error leaks a raw SQLite foreign-key error from request().
    const database = openDatabase(temporaryDatabasePath());
    openDatabases.push(database);
    const store = new ControlStore(database);
    const service = new ApprovalService(store);

    let thrown: unknown;
    try {
      service.request({
        approvalId: "approval-unpersisted-proposal",
        proposal: approvalProposal({ proposalId: "proposal-not-yet-persisted", riskLevel: "L2" }),
        operation: "create_pull_request",
        commandDigest: "a".repeat(64),
        channel: "slack",
        allowedChannels: ["slack"]
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "ApprovalRequestPersistenceError",
      code: "proposal_not_persisted",
      message: "approval request requires a persisted execution proposal"
    });
    expect(thrown).not.toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" });
    expect(store.findApproval("approval-unpersisted-proposal")).toBeUndefined();
  });

  it("confirms and consumes a JSON-round-tripped L3 approval through ControlStore", () => {
    // Break caught: JSON serialization changes a valid request and makes ApprovalService reject it as tampered.
    const database = openDatabase(temporaryDatabasePath());
    openDatabases.push(database);
    const store = new ControlStore(database);
    store.insertCommand(command);
    const proposal = approvalProposal();
    persistExecutionProposal(database, proposal);
    const service = new ApprovalService(store);

    const request = service.request({
      approvalId: "approval-service-durable",
      proposal,
      operation: "deploy_production",
      commandDigest: "a".repeat(64),
      channel: "slack",
      allowedChannels: ["slack"]
    });
    const confirmation = service.confirm(
      request,
      approvalOwner,
      new Date("2026-09-01T10:00:00.000Z"),
      request.operationPhrase
    );

    expect(confirmation).toEqual({ kind: "approved", id: request.approvalId });
    expect(service.validate(request.approvalId, request.digest, new Date("2026-09-01T10:01:00.000Z")))
      .toEqual({ kind: "approved" });
    expect(store.findApproval(request.approvalId)).toEqual(expect.objectContaining({ state: "consumed" }));
    expect(store.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: request.approvalId, eventType: "approval.requested", data: {} }),
      expect.objectContaining({ subjectId: request.approvalId, eventType: "approval.confirmed", data: {} }),
      expect.objectContaining({ subjectId: request.approvalId, eventType: "approval.consumed", data: {} })
    ]));
  });

  it("durably persists a redacted pending approval request across a restart", () => {
    // Break caught: an approval request only exists in process memory until it is confirmed.
    const path = temporaryDatabasePath();
    const firstDatabase = openDatabase(path);
    const firstStore = new ControlStore(firstDatabase);
    firstStore.insertCommand(command);
    firstDatabase.prepare(`
      INSERT INTO execution_proposals (
        id, command_id, project_registry_entry_id, state, payload_json, created_at, updated_at
      ) VALUES (?, ?, NULL, 'proposed', '{}', ?, ?)
    `).run("proposal-pending", command.commandId, "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z");
    const request = {
      approvalId: "approval-pending",
      proposal: {
        proposalId: "proposal-pending",
        commandId: command.commandId,
        selectedProjectKey: "project-a",
        routeCandidates: [{ projectKey: "project-a", score: 1, evidence: ["explicit"] }],
        baseRef: "main",
        allowedScope: ["src/**"],
        prohibitedEffects: ["delete_data"],
        acceptanceCommands: ["pnpm test"],
        riskLevel: "L3",
        tasks: [{ localId: "implement", title: "Implement", dependsOn: [], role: "implement", preferredAgent: "codex" }]
      },
      operation: "deploy_production",
      commandDigest: "a".repeat(64),
      diffSha256: "b".repeat(64),
      targetEnvironment: "production",
      channel: "slack",
      allowedChannels: ["slack", "tailscale-web"],
      proposalDigest: "c".repeat(64),
      digest: "d".repeat(64),
      riskLevel: "L3",
      typedPhraseDigest: "e".repeat(64)
    } satisfies PersistedApprovalRequest;

    firstStore.persistApprovalRequest(request);
    expect(firstStore.findApproval(request.approvalId)).toEqual({
      request,
      state: "pending"
    });
    expect(firstDatabase.prepare("SELECT payload_json FROM approvals WHERE id = ?").get(request.approvalId))
      .not.toEqual(expect.objectContaining({ payload_json: expect.stringContaining("APPROVE ") }));
    firstDatabase.close();

    const reopened = openDatabase(path);
    openDatabases.push(reopened);
    expect(new ControlStore(reopened).findApproval(request.approvalId)).toEqual({ request, state: "pending" });
  });

  it("persists, consumes, and audits an invalidated approval without persisting its phrase", () => {
    // Break caught: a changed operation can retain an active approval or its L3 phrase in SQLite.
    const database = openDatabase(temporaryDatabasePath());
    openDatabases.push(database);
    const store = new ControlStore(database);
    store.insertCommand(command);
    database.prepare(`
      INSERT INTO execution_proposals (
        id, command_id, project_registry_entry_id, state, payload_json, created_at, updated_at
      ) VALUES (?, ?, NULL, 'proposed', '{}', ?, ?)
    `).run("proposal-approval", command.commandId, "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z");
    const approval = {
      approvalId: "approval-1",
      proposalDigest: "a".repeat(64),
      operationDigest: "b".repeat(64),
      principalId: "owner-1",
      channel: "tailscale-web",
      approvedAt: "2026-09-01T10:00:00.000Z",
      expiresAt: "2026-09-01T10:15:00.000Z",
      typedPhraseDigest: "c".repeat(64),
      executionProposalId: "proposal-approval"
    } satisfies ApprovalConfirmation;
    store.persistApprovalRequest({
      approvalId: approval.approvalId,
      proposal: {
        proposalId: approval.executionProposalId,
        commandId: command.commandId,
        selectedProjectKey: "project-a",
        routeCandidates: [{ projectKey: "project-a", score: 1, evidence: ["explicit"] }],
        baseRef: "main",
        allowedScope: ["src/**"],
        prohibitedEffects: ["delete_data"],
        acceptanceCommands: ["pnpm test"],
        riskLevel: "L3",
        tasks: [{ localId: "implement", title: "Implement", dependsOn: [], role: "implement", preferredAgent: "codex" }]
      },
      operation: "deploy_production",
      commandDigest: "d".repeat(64),
      diffSha256: "e".repeat(64),
      targetEnvironment: "production",
      channel: approval.channel,
      allowedChannels: ["slack", "tailscale-web"],
      proposalDigest: approval.proposalDigest,
      digest: approval.operationDigest,
      riskLevel: "L3",
      typedPhraseDigest: approval.typedPhraseDigest
    } satisfies PersistedApprovalRequest);

    expect(store.confirmApproval(approval)).toEqual(
      expect.objectContaining({ approvalId: approval.approvalId, typedPhraseDigest: approval.typedPhraseDigest })
    );
    expect(store.findApproval(approval.approvalId)).toEqual(expect.objectContaining({
      approval: expect.objectContaining({ approvalId: approval.approvalId }),
      state: "approved"
    }));
    expect(store.consumeApproval(approval.approvalId)).toBe(true);
    expect(store.consumeApproval(approval.approvalId)).toBe(false);

    const changed = { ...approval, approvalId: "approval-changed" } satisfies ApprovalConfirmation;
    store.persistApprovalRequest({
      approvalId: changed.approvalId,
      proposal: {
        proposalId: changed.executionProposalId,
        commandId: command.commandId,
        selectedProjectKey: "project-a",
        routeCandidates: [{ projectKey: "project-a", score: 1, evidence: ["explicit"] }],
        baseRef: "main",
        allowedScope: ["src/**"],
        prohibitedEffects: ["delete_data"],
        acceptanceCommands: ["pnpm test"],
        riskLevel: "L3",
        tasks: [{ localId: "implement", title: "Implement", dependsOn: [], role: "implement", preferredAgent: "codex" }]
      },
      operation: "deploy_production",
      commandDigest: "d".repeat(64),
      diffSha256: "e".repeat(64),
      targetEnvironment: "production",
      channel: changed.channel,
      allowedChannels: ["slack", "tailscale-web"],
      proposalDigest: changed.proposalDigest,
      digest: changed.operationDigest,
      riskLevel: "L3",
      typedPhraseDigest: changed.typedPhraseDigest
    } satisfies PersistedApprovalRequest);
    store.confirmApproval(changed);
    expect(store.invalidateApproval(changed.approvalId, "digest_changed")).toBe(true);
    expect(store.findApproval(changed.approvalId)).toEqual(expect.objectContaining({
      approval: expect.objectContaining({ approvalId: changed.approvalId }),
      state: "invalidated"
    }));
    expect(store.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subjectId: changed.approvalId,
        eventType: "approval.invalidated",
        data: { reason: "digest_changed" }
      })
    ]));
    const storedPayload = database.prepare("SELECT payload_json FROM approvals WHERE id = ?")
      .get(changed.approvalId) as { payload_json: string };
    expect(storedPayload.payload_json).not.toContain("APPROVE ");
  });

  it("keeps one command, inbox event, and audit for an exact composite redelivery", () => {
    const store = testStore();
    const redelivery = { ...command, commandId: "cmd-redelivered" };

    expect(store.insertCommand(command)).toBe("inserted");
    expect(store.insertCommand(redelivery)).toBe("duplicate");
    expect(store.listCommands()).toHaveLength(1);
    expect(store.listInboxEvents()).toEqual([
      expect.objectContaining({ providerEventId: command.idempotencyKey })
    ]);
    expect(store.listAuditEvents()).toHaveLength(1);
  });

  it("persists identical raw provider message IDs from different composite scopes", () => {
    const database = openDatabase(temporaryDatabasePath());
    openDatabases.push(database);
    const store = new ControlStore(database);
    const otherScope = {
      ...command,
      commandId: "cmd-other-scope",
      idempotencyKey: "slack:T999:171.001",
      principalId: "other-owner"
    };

    expect(store.insertCommand(command)).toBe("inserted");
    expect(store.insertCommand(otherScope)).toBe("inserted");
    expect(store.listCommands()).toEqual([command, otherScope]);
    expect(store.listInboxEvents().map(({ providerEventId }) => providerEventId)).toEqual([
      command.idempotencyKey,
      otherScope.idempotencyKey
    ]);
    expect(store.listAuditEvents()).toHaveLength(2);
    expect(database.prepare("SELECT id FROM principals ORDER BY id").all()).toEqual([
      { id: otherScope.principalId },
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

  it("round-trips every JSON value shape through real outbox and audit rows", () => {
    const store = testStore();
    const nestedJson = {
      string: "value",
      number: 1.25,
      boolean: false,
      nil: null,
      array: [1, "two", true, null, { nested: ["ok"] }]
    };

    expect(store.enqueueOutbox({
      ...outboxMessage,
      id: "outbox-json",
      payload: nestedJson
    })).toBe("inserted");
    expect(store.claimOutbox(outboxMessage.nextAttemptAt)).toMatchObject({
      id: "outbox-json",
      payload: nestedJson
    });

    const auditValues = [
      null,
      true,
      42.5,
      "text",
      [1, null, "three"],
      nestedJson
    ] satisfies JsonValue[];
    for (const [index, data] of auditValues.entries()) {
      store.appendAudit({
        id: `audit-json-${index}`,
        subjectId: command.commandId,
        eventType: "json.roundtrip",
        data
      });
    }
    expect(store.listAuditEvents().map(({ data }) => data)).toEqual(auditValues);
  });

  it("rejects non-JSON outbox payloads and audit data before SQLite persistence", () => {
    const store = testStore();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidValues = [
      undefined,
      () => undefined,
      Symbol("invalid"),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      { nested: undefined },
      [undefined],
      cyclic
    ];

    for (const [index, invalid] of invalidValues.entries()) {
      expect(() => store.enqueueOutbox({
        ...outboxMessage,
        id: `outbox-invalid-${index}`,
        payload: invalid
      } as never)).toThrow(ZodError);
      expect(() => store.appendAudit({
        id: `audit-invalid-${index}`,
        subjectId: command.commandId,
        eventType: "json.rejected",
        data: invalid
      } as never)).toThrow(ZodError);
    }

    expect(store.listAuditEvents()).toEqual([]);
    expect(store.claimOutbox(outboxMessage.nextAttemptAt)).toBeUndefined();
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

    database.prepare("UPDATE outbox_messages SET payload_json = '1e400' WHERE id = ?").run(outboxMessage.id);
    expect(() => store.claimOutbox(outboxMessage.nextAttemptAt)).toThrow(ZodError);

    database.prepare("UPDATE audit_events SET data_json = '1e400' WHERE id = ?").run("audit-corrupt");
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
      { version: 1, name: "initial" },
      { version: 2, name: "worktree-lock-reservations" }
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

  it("preserves existing leases while allowing pre-Dispatch reservations", () => {
    // Break caught: rebuilding the v1 lock table can lose active leases or retain the ordering-invalid Dispatch FK.
    const database = new Database(temporaryDatabasePath());
    openDatabases.push(database);
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    initialMigration.up(database);
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (1, 'initial', '2026-09-01T00:00:00.000Z')
    `).run();
    const store = new ControlStore(database);
    store.insertCommand(command);
    store.saveRun({
      id: "run-lock-migration",
      proposalId: "proposal-lock-migration",
      commandId: command.commandId,
      state: "active"
    });
    store.saveTask({
      id: "task-lock-migration",
      runId: "run-lock-migration",
      title: "Migrate lock",
      role: "implement",
      preferredAgent: "codex",
      dependsOn: [],
      state: "running"
    });
    store.saveDispatch({
      id: "dispatch-lock-migration",
      taskId: "task-lock-migration",
      state: "running"
    });
    const existingLease = {
      lockKey: "repo:existing",
      commandId: command.commandId,
      taskId: "task-lock-migration",
      projectKey: "project-a",
      worktreePath: "/srv/worktrees/existing",
      branch: "dispatch/existing",
      dispatchId: "dispatch-lock-migration",
      acquiredAt: "2026-09-01T00:00:00.000Z",
      heartbeatAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:05:00.000Z"
    };
    store.acquireWorktreeLock(existingLease);

    migrate(database);

    expect(store.getWorktreeLock(existingLease.lockKey)).toEqual(existingLease);
    expect(database.pragma("foreign_key_list(worktree_locks)")).toEqual([]);
    expect(store.acquireWorktreeLock({
      ...existingLease,
      lockKey: "repo:future",
      worktreePath: "/srv/worktrees/future",
      branch: "dispatch/future",
      dispatchId: "dispatch-not-persisted"
    })).toMatchObject({ kind: "acquired", lease: { dispatchId: "dispatch-not-persisted" } });
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

  it("deduplicates worker_done by Dispatch completion identity across fresh message IDs and rejects conflicts", () => {
    // Break caught: message-ID-only dedupe makes an equivalent transport redelivery fail after the Dispatch is terminal.
    const store = testStore();
    store.insertCommand(command);
    store.saveRun({
      id: "run-worker-done",
      proposalId: "proposal-worker-done",
      commandId: command.commandId,
      objective: "exercise durable completion identity",
      state: "active"
    });
    store.saveTask({
      id: "task-worker-done",
      runId: "run-worker-done",
      localId: "verify",
      title: "Verify",
      role: "verify",
      preferredAgent: "codex",
      dependsOn: [],
      state: "running"
    });
    store.saveDispatch({
      id: "dispatch-worker-done",
      taskId: "task-worker-done",
      attempt: 1,
      state: "running",
      orcaDispatchId: "orca-dispatch-worker-done"
    });
    const commit = (messageId: string, summary: string) => store.commitWorkerDone({
      message: {
        kind: "worker_done",
        messageId,
        dispatchId: "orca-dispatch-worker-done",
        outcome: "completed",
        summary
      },
      dispatch: {
        id: "dispatch-worker-done",
        taskId: "task-worker-done",
        attempt: 1,
        state: "worker_done",
        orcaDispatchId: "orca-dispatch-worker-done",
        workerCompletion: {
          dispatchId: "orca-dispatch-worker-done",
          outcome: "completed",
          summary
        },
        workerCompletionAuditReference: "worker-message:completion-message-1"
      },
      task: {
        id: "task-worker-done",
        runId: "run-worker-done",
        localId: "verify",
        title: "Verify",
        role: "verify",
        preferredAgent: "codex",
        dependsOn: [],
        state: "worker_done"
      },
      transitions: [
        {
          entity: "dispatch",
          entityId: "dispatch-worker-done",
          from: "running",
          to: "worker_done",
          at: "2026-09-01T00:00:01.000Z"
        },
        {
          entity: "task",
          entityId: "task-worker-done",
          from: "running",
          to: "worker_done",
          at: "2026-09-01T00:00:01.000Z"
        }
      ]
    });

    expect(commit("completion-message-1", "implementation complete")).toBe("inserted");
    expect(commit("completion-message-2", "implementation complete")).toBe("duplicate");
    expect(store.listAuditEvents().filter(({ eventType }) => eventType === "worker.worker_done"))
      .toHaveLength(1);
    store.saveTask({
      id: "task-worker-done",
      runId: "run-worker-done",
      localId: "verify",
      title: "Verify",
      role: "verify",
      preferredAgent: "codex",
      dependsOn: [],
      state: "verified_success"
    });
    expect(commit("completion-message-after-terminal-advance", "implementation complete"))
      .toBe("duplicate");
    store.saveTask({
      id: "task-worker-done",
      runId: "run-worker-done",
      localId: "verify",
      title: "Verify",
      role: "verify",
      preferredAgent: "codex",
      dependsOn: [],
      state: "running"
    });
    expect(() => commit("completion-message-incoherent-task", "implementation complete"))
      .toThrowError(WorkerCompletionConflictError);
    store.saveTask({
      id: "task-worker-done",
      runId: "run-worker-done",
      localId: "verify",
      title: "Verify",
      role: "verify",
      preferredAgent: "codex",
      dependsOn: [],
      state: "worker_done"
    });
    expect(() => commit("completion-message-3", "different immutable summary"))
      .toThrowError(expect.objectContaining({ code: "worker_completion_conflict" }));
    expect(store.listAuditEvents().filter(({ eventType }) => eventType === "worker.worker_done"))
      .toHaveLength(1);
  });

  it("rejects worker_done when the persisted Dispatch has no exact Orca identity", () => {
    // Break caught: caller-shaped completion identity must not bind a Dispatch that never persisted its Orca ID.
    const store = testStore();
    store.insertCommand(command);
    store.saveRun({
      id: "run-unbound-worker-done",
      proposalId: "proposal-unbound-worker-done",
      commandId: command.commandId,
      objective: "reject unbound completion",
      state: "active"
    });
    store.saveTask({
      id: "task-unbound-worker-done",
      runId: "run-unbound-worker-done",
      state: "running"
    });
    store.saveDispatch({
      id: "dispatch-unbound-worker-done",
      taskId: "task-unbound-worker-done",
      attempt: 1,
      state: "running"
    });

    expect(() => store.commitWorkerDone({
      message: {
        kind: "worker_done",
        messageId: "completion-unbound",
        dispatchId: "orca-dispatch-unbound",
        outcome: "completed",
        summary: "caller claims completion"
      },
      dispatch: {
        id: "dispatch-unbound-worker-done",
        taskId: "task-unbound-worker-done",
        attempt: 1,
        state: "worker_done",
        workerCompletion: {
          dispatchId: "orca-dispatch-unbound",
          outcome: "completed",
          summary: "caller claims completion"
        },
        workerCompletionAuditReference: "worker-message:completion-unbound"
      },
      task: {
        id: "task-unbound-worker-done",
        runId: "run-unbound-worker-done",
        state: "worker_done"
      },
      transitions: [
        {
          entity: "dispatch",
          entityId: "dispatch-unbound-worker-done",
          from: "running",
          to: "worker_done",
          at: "2026-09-01T00:00:01.000Z"
        },
        {
          entity: "task",
          entityId: "task-unbound-worker-done",
          from: "running",
          to: "worker_done",
          at: "2026-09-01T00:00:01.000Z"
        }
      ]
    })).toThrowError(WorkerCompletionConflictError);
  });

  it("fails closed when an Orca Dispatch lookup key owns more than one Run graph", () => {
    // Break caught: LIMIT 1 silently hydrates an arbitrary Run when persisted Orca IDs collide.
    const store = testStore();
    store.insertCommand(command);
    for (const suffix of ["a", "b"] as const) {
      store.saveRun({
        id: `run-ambiguous-${suffix}`,
        proposalId: `proposal-ambiguous-${suffix}`,
        commandId: command.commandId,
        state: "active"
      });
      store.saveTask({
        id: `task-ambiguous-${suffix}`,
        runId: `run-ambiguous-${suffix}`,
        state: "running"
      });
      store.saveDispatch({
        id: `dispatch-ambiguous-${suffix}`,
        taskId: `task-ambiguous-${suffix}`,
        state: "running",
        orcaDispatchId: "orca-dispatch-ambiguous"
      });
    }

    expect(() => store.loadRunGraphForDispatch("orca-dispatch-ambiguous"))
      .toThrow("Dispatch lookup orca-dispatch-ambiguous is ambiguous");
  });

  it("indexes composite idempotency keys without raw provider-message uniqueness", () => {
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
    expect(commandIndexes).not.toContainEqual(expect.objectContaining({
      name: "commands_provider_message_unique"
    }));
    expect(inboxIndexes).toContainEqual(expect.objectContaining({
      name: "inbox_provider_event_unique",
      unique: 1
    }));
  });
});
