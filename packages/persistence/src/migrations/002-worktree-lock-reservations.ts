import type Database from "better-sqlite3";

/**
 * Editing authority is reserved before ExecutionLifecycle persists its
 * Dispatch. Keep the dispatch identity in the lease payload, but do not make
 * the lease depend on a row that is deliberately created later.
 */
export const worktreeLockReservationsMigration = {
  version: 2,
  name: "worktree-lock-reservations",
  up(database: Database.Database): void {
    database.exec(`
      CREATE TABLE worktree_locks_next (
        id TEXT PRIMARY KEY,
        dispatch_id TEXT NOT NULL,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO worktree_locks_next (
        id, dispatch_id, state, payload_json, created_at, updated_at
      )
      SELECT id, dispatch_id, state, payload_json, created_at, updated_at
      FROM worktree_locks;

      DROP TABLE worktree_locks;
      ALTER TABLE worktree_locks_next RENAME TO worktree_locks;
    `);
  }
} as const;
