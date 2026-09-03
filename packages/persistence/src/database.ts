import Database from "better-sqlite3";

import { initialMigration } from "./migrations/001-initial.js";
import { worktreeLockReservationsMigration } from "./migrations/002-worktree-lock-reservations.js";

const migrations = [initialMigration, worktreeLockReservationsMigration] as const;

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const record = database.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
  );

  for (const migration of migrations) {
    const applyMigration = database.transaction(() => {
      if (applied.get(migration.version) !== undefined) return;
      migration.up(database);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    applyMigration.immediate();
  }
}

export function openDatabase(path: string): Database.Database {
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  migrate(database);
  return database;
}
