import type Database from "better-sqlite3";

export const initialMigration = {
  version: 1,
  name: "initial",
  up(database: Database.Database): void {
    database.exec(`
      CREATE TABLE principals (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE principal_bindings (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE commands (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        channel TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        external_thread_id TEXT,
        principal_id TEXT NOT NULL REFERENCES principals(id) DEFERRABLE INITIALLY DEFERRED,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX commands_idempotency_key_unique
        ON commands(idempotency_key);

      CREATE TABLE command_payloads (
        id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_registry_entries (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE project_aliases (
        id TEXT PRIMARY KEY,
        project_registry_entry_id TEXT NOT NULL REFERENCES project_registry_entries(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE execution_proposals (
        id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL REFERENCES commands(id),
        project_registry_entry_id TEXT REFERENCES project_registry_entries(id),
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        execution_proposal_id TEXT NOT NULL REFERENCES execution_proposals(id),
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL REFERENCES commands(id),
        execution_proposal_id TEXT REFERENCES execution_proposals(id),
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE dispatches (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE worktree_locks (
        id TEXT PRIMARY KEY,
        dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE channel_cursors (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE inbox_events (
        id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX inbox_provider_event_unique
        ON inbox_events(provider, provider_event_id);

      CREATE TABLE outbox_messages (
        id TEXT PRIMARY KEY,
        command_id TEXT REFERENCES commands(id),
        channel TEXT NOT NULL,
        destination TEXT NOT NULL,
        template TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        claimed_by TEXT,
        claimed_at TEXT,
        provider_message_id TEXT,
        last_error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX outbox_claim_index
        ON outbox_messages(state, next_attempt_at);

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }
} as const;
