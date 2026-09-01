import { randomUUID } from "node:crypto";

import {
  CommandEnvelopeSchema,
  type CommandEnvelope
} from "@orca-hq/core";
import type Database from "better-sqlite3";
import { z } from "zod";

const JsonObjectSchema = z.record(z.unknown());

const InboxEventSchema = z.object({
  id: z.string().min(1),
  commandId: z.string().min(1),
  eventType: z.string().min(1),
  provider: z.string().min(1),
  providerEventId: z.string().min(1),
  payload: CommandEnvelopeSchema,
  createdAt: z.string().datetime()
}).strict();

const EnqueueOutboxMessageSchema = z.object({
  id: z.string().min(1),
  commandId: z.string().min(1).optional(),
  channel: z.enum(["slack", "telegram", "tailscale-web"]),
  destination: z.string().min(1),
  template: z.string().min(1),
  payload: JsonObjectSchema,
  nextAttemptAt: z.string().datetime()
}).strict();

const OutboxMessageSchema = EnqueueOutboxMessageSchema.extend({
  state: z.enum(["pending", "claimed", "delivered", "failed"]),
  attempts: z.number().int().nonnegative(),
  claimedBy: z.string().min(1).nullable(),
  claimedAt: z.string().datetime().nullable(),
  providerMessageId: z.string().min(1).nullable(),
  lastError: JsonObjectSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const AppendAuditEventSchema = z.object({
  id: z.string().min(1).optional(),
  subjectId: z.string().min(1),
  eventType: z.string().min(1),
  data: JsonObjectSchema
}).strict();

const AuditEventSchema = AppendAuditEventSchema.extend({
  id: z.string().min(1),
  createdAt: z.string().datetime()
}).strict();

export type InboxEvent = z.infer<typeof InboxEventSchema>;
export type EnqueueOutboxMessage = z.infer<typeof EnqueueOutboxMessageSchema>;
export type OutboxMessage = z.infer<typeof OutboxMessageSchema>;
export type AppendAuditEvent = z.infer<typeof AppendAuditEventSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;

interface CommandRow {
  payload_json: string;
}

interface InboxEventRow {
  id: string;
  command_id: string;
  event_type: string;
  provider: string;
  provider_event_id: string;
  payload_json: string;
  created_at: string;
}

interface OutboxMessageRow {
  id: string;
  command_id: string | null;
  channel: string;
  destination: string;
  template: string;
  payload_json: string;
  state: string;
  attempts: number;
  next_attempt_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  provider_message_id: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
}

interface AuditEventRow {
  id: string;
  subject_id: string;
  event_type: string;
  data_json: string;
  created_at: string;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function outboxMessageFromRow(row: OutboxMessageRow): OutboxMessage {
  const candidate = {
    id: row.id,
    ...(row.command_id === null ? {} : { commandId: row.command_id }),
    channel: row.channel,
    destination: row.destination,
    template: row.template,
    payload: parseJson(row.payload_json),
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    providerMessageId: row.provider_message_id,
    lastError: row.last_error_json === null ? null : parseJson(row.last_error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  return OutboxMessageSchema.parse(candidate);
}

export class ControlStore {
  constructor(private readonly database: Database.Database) {}

  insertCommand(commandInput: CommandEnvelope): "inserted" | "duplicate" {
    const command = CommandEnvelopeSchema.parse(commandInput);

    return this.database.transaction(() => {
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        INSERT INTO commands (
          id, idempotency_key, channel, external_message_id, external_thread_id,
          principal_id, received_at, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(
        command.commandId,
        command.idempotencyKey,
        command.channel,
        command.externalMessageId,
        command.externalThreadId ?? null,
        command.principalId,
        command.receivedAt,
        JSON.stringify(command),
        now
      );

      if (result.changes === 0) return "duplicate";

      this.database.prepare(`
        INSERT INTO principals (id, payload_json, created_at, updated_at)
        VALUES (?, '{}', ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(command.principalId, now, now);

      this.database.prepare(`
        INSERT INTO inbox_events (
          id, command_id, event_type, provider, provider_event_id, payload_json, created_at
        ) VALUES (?, ?, 'command_received', ?, ?, ?, ?)
      `).run(
        `${command.commandId}:command_received`,
        command.commandId,
        command.channel,
        command.externalMessageId,
        JSON.stringify(command),
        now
      );

      this.appendAudit({
        subjectId: command.commandId,
        eventType: "command.accepted",
        data: {}
      });
      return "inserted";
    })();
  }

  listCommands(): CommandEnvelope[] {
    const rows = this.database.prepare(
      "SELECT payload_json FROM commands ORDER BY created_at, id"
    ).all() as CommandRow[];
    return rows.map((row) => CommandEnvelopeSchema.parse(parseJson(row.payload_json)));
  }

  listInboxEvents(): InboxEvent[] {
    const rows = this.database.prepare(`
      SELECT id, command_id, event_type, provider, provider_event_id, payload_json, created_at
      FROM inbox_events
      ORDER BY created_at, id
    `).all() as InboxEventRow[];
    return rows.map((row) => InboxEventSchema.parse({
      id: row.id,
      commandId: row.command_id,
      eventType: row.event_type,
      provider: row.provider,
      providerEventId: row.provider_event_id,
      payload: parseJson(row.payload_json),
      createdAt: row.created_at
    }));
  }

  enqueueOutbox(messageInput: EnqueueOutboxMessage): "inserted" | "duplicate" {
    const message = EnqueueOutboxMessageSchema.parse(messageInput);
    const now = new Date().toISOString();
    const nextAttemptAt = new Date(message.nextAttemptAt).toISOString();
    const result = this.database.prepare(`
      INSERT INTO outbox_messages (
        id, command_id, channel, destination, template, payload_json, state,
        attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      message.id,
      message.commandId ?? null,
      message.channel,
      message.destination,
      message.template,
      JSON.stringify(message.payload),
      nextAttemptAt,
      now,
      now
    );
    return result.changes === 0 ? "duplicate" : "inserted";
  }

  claimOutbox(nowInput: string, workerId = "control-store"): OutboxMessage | undefined {
    const now = new Date(z.string().datetime().parse(nowInput)).toISOString();
    const claimant = z.string().min(1).parse(workerId);
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        UPDATE outbox_messages
        SET state = 'claimed', attempts = attempts + 1,
            claimed_by = ?, claimed_at = ?, updated_at = ?
        WHERE id = (
          SELECT id
          FROM outbox_messages
          WHERE state = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at, id
          LIMIT 1
        )
          AND state = 'pending'
        RETURNING *
      `).get(claimant, now, now, now) as OutboxMessageRow | undefined;
      if (row === undefined) return undefined;
      return outboxMessageFromRow(row);
    })();
  }

  appendAudit(eventInput: AppendAuditEvent): AuditEvent {
    const event = AppendAuditEventSchema.parse(eventInput);
    const id = event.id ?? randomUUID();
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO audit_events (id, subject_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, event.subjectId, event.eventType, JSON.stringify(event.data), createdAt);
    return AuditEventSchema.parse({ ...event, id, createdAt });
  }

  listAuditEvents(): AuditEvent[] {
    const rows = this.database.prepare(`
      SELECT id, subject_id, event_type, data_json, created_at
      FROM audit_events
      ORDER BY created_at, id
    `).all() as AuditEventRow[];
    return rows.map((row) => AuditEventSchema.parse({
      id: row.id,
      subjectId: row.subject_id,
      eventType: row.event_type,
      data: parseJson(row.data_json),
      createdAt: row.created_at
    }));
  }
}
