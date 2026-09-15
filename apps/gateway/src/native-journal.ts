import type { openDatabase } from "@orca-hq/persistence";

export interface NativeJournal {
  get<T = Record<string, unknown>>(kind: string, id: string): T | undefined;
  list<T = Record<string, unknown>>(kind: string): T[];
  put(kind: string, id: string, value: unknown): void;
}
/** Shares the progress database and owner; never exposes the connection to callers. */
export function createNativeJournal(database: ReturnType<typeof openDatabase>, owner: string): NativeJournal {
  database.exec(`CREATE TABLE IF NOT EXISTS hq_native_journal (
    owner_key TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(owner_key, kind, id)
  )`);
  return {
    get<T>(kind: string, id: string): T | undefined {
      const row = database.prepare("SELECT body FROM hq_native_journal WHERE owner_key=? AND kind=? AND id=?").get(owner, kind, id) as { body: string } | undefined;
      return row ? JSON.parse(row.body) as T : undefined;
    },
    list<T>(kind: string): T[] {
      return (database.prepare("SELECT body FROM hq_native_journal WHERE owner_key=? AND kind=? ORDER BY rowid").all(owner, kind) as Array<{ body: string }>).map(row => JSON.parse(row.body) as T);
    },
    put(kind, id, value) {
      database.prepare("INSERT INTO hq_native_journal VALUES(?,?,?,?) ON CONFLICT(owner_key,kind,id) DO UPDATE SET body=excluded.body").run(owner, kind, id, JSON.stringify(value));
    }
  };
}
