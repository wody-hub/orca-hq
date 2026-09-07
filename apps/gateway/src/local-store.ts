import { z } from 'zod';
import type { openDatabase } from '@orca-hq/persistence';

export const LocalTextMessageSchema = z.object({
  id: z.string().min(1).max(512),
  channel: z.enum(['slack', 'telegram']),
  destination: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
  text: z.string().min(1).max(8000),
  receivedAt: z.string().datetime(),
  threadId: z.string().min(1).max(128).optional()
}).strict();
export type LocalTextMessage = z.infer<typeof LocalTextMessageSchema>;
interface WorkRow { message_json: string; response: string | null; attempts: number }
export interface LocalTextWork { message: LocalTextMessage; response?: string; attempts: number }

/** Durable, idempotent inbox/outbox for the deliberately read-only local runtime. */
export class LocalTextStore {
  constructor(private readonly db: ReturnType<typeof openDatabase>) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_text_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        message_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed')),
        response TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS local_text_cursors (
        channel TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `);
  }
  accept(input: LocalTextMessage): boolean {
    const message = LocalTextMessageSchema.parse(input);
    if (this.db.prepare('SELECT 1 FROM local_text_messages WHERE id=?').get(message.id)) return false;
    const pending = this.db.prepare("SELECT count(*) AS n FROM local_text_messages WHERE state IN ('queued','running')").get() as { n: number };
    if (pending.n >= 100) throw new Error('local_text_queue_full');
    return this.db.prepare("INSERT OR IGNORE INTO local_text_messages(id,message_json,state) VALUES (?,?,'queued')").run(message.id, JSON.stringify(message)).changes === 1;
  }
  recover(): void { this.db.prepare("UPDATE local_text_messages SET state='queued',next_attempt=0 WHERE state='running'").run(); }
  claim(now: number): LocalTextWork | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT id,message_json,response,attempts FROM local_text_messages WHERE state='queued' AND next_attempt<=? ORDER BY sequence LIMIT 1").get(now) as (WorkRow & { id: string }) | undefined;
      if (row === undefined) return undefined;
      this.db.prepare("UPDATE local_text_messages SET state='running' WHERE id=?").run(row.id);
      return { message: LocalTextMessageSchema.parse(JSON.parse(row.message_json)), attempts: row.attempts, ...(row.response === null ? {} : { response: row.response }) };
    }).immediate();
  }
  saveResponse(id: string, response: string): void {
    if (!response.trim() || response.length > 16000) throw new Error('local_text_response_invalid');
    this.db.prepare('UPDATE local_text_messages SET response=? WHERE id=?').run(response, id);
  }
  retry(id: string, nextAttempt: number): void {
    this.db.prepare("UPDATE local_text_messages SET state=CASE WHEN attempts>=4 THEN 'failed' ELSE 'queued' END, attempts=attempts+1,next_attempt=? WHERE id=?").run(nextAttempt, id);
  }
  delivered(id: string): void { this.db.prepare("UPDATE local_text_messages SET state='delivered' WHERE id=?").run(id); }
  loadCursor(channel: 'slack' | 'telegram'): string | number | undefined {
    const row = this.db.prepare('SELECT value_json FROM local_text_cursors WHERE channel=?').get(channel) as { value_json: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value_json) as string | number;
  }
  saveCursor(channel: 'slack' | 'telegram', cursor: string | number): void {
    if (channel === 'telegram') z.number().int().nonnegative().parse(cursor);
    else z.string().min(1).max(128).parse(cursor);
    this.db.prepare('INSERT INTO local_text_cursors(channel,value_json) VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET value_json=excluded.value_json').run(channel, JSON.stringify(cursor));
  }
  summary(): { queued: number; running: number; delivered: number; failed: number } {
    const result = { queued: 0, running: 0, delivered: 0, failed: 0 };
    const rows = this.db.prepare('SELECT state,count(*) AS n FROM local_text_messages GROUP BY state').all() as Array<{ state: keyof typeof result; n: number }>;
    for (const row of rows) result[row.state] = row.n;
    return result;
  }
}
