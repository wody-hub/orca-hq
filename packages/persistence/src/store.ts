import { randomUUID } from "node:crypto";

import {
  ChannelMessageJsonSchema,
  CommandEnvelopeSchema,
  type ChannelMessageJson,
  type CommandEnvelope,
  type CommandIngress
} from "@orca-hq/core";
import type Database from "better-sqlite3";
import { z } from "zod";

export type JsonValue = ChannelMessageJson;
export const JsonValueSchema = ChannelMessageJsonSchema;

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
  payload: JsonValueSchema,
  nextAttemptAt: z.string().datetime()
}).strict();

const OutboxMessageSchema = EnqueueOutboxMessageSchema.extend({
  state: z.enum(["pending", "claimed", "delivered", "failed"]),
  attempts: z.number().int().nonnegative(),
  claimedBy: z.string().min(1).nullable(),
  claimedAt: z.string().datetime().nullable(),
  providerMessageId: z.string().min(1).nullable(),
  lastError: JsonValueSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const AppendAuditEventSchema = z.object({
  id: z.string().min(1).optional(),
  subjectId: z.string().min(1),
  eventType: z.string().min(1),
  data: JsonValueSchema
}).strict();

const AuditEventSchema = AppendAuditEventSchema.extend({
  id: z.string().min(1),
  createdAt: z.string().datetime()
}).strict();

const WorktreeLeaseSchema = z.object({
  lockKey: z.string().min(1),
  commandId: z.string().min(1),
  taskId: z.string().min(1),
  projectKey: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  dispatchId: z.string().min(1),
  acquiredAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict().superRefine((lease, context) => {
  const acquiredAt = new Date(lease.acquiredAt).getTime();
  const heartbeatAt = new Date(lease.heartbeatAt).getTime();
  const expiresAt = new Date(lease.expiresAt).getTime();
  if (heartbeatAt < acquiredAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "heartbeat precedes acquisition" });
  }
  if (expiresAt <= heartbeatAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "expiry must follow heartbeat" });
  }
});

const WorktreeHeartbeatUpdateSchema = z.object({
  lockKey: z.string().min(1),
  dispatchId: z.string().min(1),
  heartbeatAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict().refine(
  (heartbeat) => new Date(heartbeat.expiresAt).getTime() > new Date(heartbeat.heartbeatAt).getTime(),
  { message: "expiry must follow heartbeat" }
);

const WorktreeReleaseUpdateSchema = z.object({
  lockKey: z.string().min(1),
  dispatchId: z.string().min(1),
  releasedAt: z.string().datetime()
}).strict();

export type InboxEvent = z.infer<typeof InboxEventSchema>;
export type EnqueueOutboxMessage = z.infer<typeof EnqueueOutboxMessageSchema>;
export type OutboxMessage = z.infer<typeof OutboxMessageSchema>;
export type AppendAuditEvent = z.infer<typeof AppendAuditEventSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type WorktreeLease = z.infer<typeof WorktreeLeaseSchema>;
export type WorktreeHeartbeatUpdate = z.infer<typeof WorktreeHeartbeatUpdateSchema>;
export type WorktreeReleaseUpdate = z.infer<typeof WorktreeReleaseUpdateSchema>;

export type WorktreeAcquireResult =
  | Readonly<{ kind: "acquired"; lease: WorktreeLease }>
  | Readonly<{ kind: "conflict"; lease: WorktreeLease }>
  | Readonly<{
      kind: "review_required";
      reason: "expired_lease_requires_reconciliation";
      lease: WorktreeLease;
    }>;

export type WorktreeHeartbeatResult =
  | Readonly<{ kind: "heartbeated"; lease: WorktreeLease }>
  | Readonly<{ kind: "conflict"; lease: WorktreeLease }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{
      kind: "review_required";
      reason: "expired_lease_requires_reconciliation" | "non_monotonic_heartbeat";
      lease: WorktreeLease;
    }>;

export type WorktreeReleaseResult =
  | Readonly<{ kind: "released" }>
  | Readonly<{ kind: "conflict"; lease: WorktreeLease }>
  | Readonly<{ kind: "not_found" }>;

export type TaskRecord = Readonly<{
  id: string;
  state: string;
}>;

const StoredGeneratedTaskSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  title: z.string().min(1),
  role: z.enum(["investigate", "implement", "verify", "summarize"]),
  preferredAgent: z.enum(["codex", "claude"]),
  cycle: z.number().int().min(0).max(2)
}).passthrough();

const StoredTaskPayloadSchema = z.object({
  id: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  runId: z.string().min(1),
  title: z.string().min(1),
  role: z.enum(["investigate", "implement", "verify", "summarize"]),
  preferredAgent: z.enum(["codex", "claude"]),
  cycle: z.number().int().min(0).max(2).optional()
}).passthrough().refine(
  (task) => task.id !== undefined || task.taskId !== undefined,
  { message: "persisted Task payload requires an identity" }
);

const VerificationReportStoreSchema = z.object({
  reportId: z.string().min(1),
  runId: z.string().min(1),
  verificationTaskId: z.string().min(1),
  implementationTaskId: z.string().min(1),
  implementationDispatchId: z.string().min(1),
  cycle: z.number().int().min(0).max(2),
  verdict: z.enum(["pass", "fail"]),
  projectRoute: z.object({
    projectKey: z.string().min(1),
    orcaProjectId: z.string().min(1),
    repositoryPath: z.string().min(1)
  }).strict(),
  changedFiles: z.array(z.string().min(1)),
  diffSummary: z.string().min(1),
  commands: z.array(z.object({
    command: z.string().min(1),
    exitCode: z.number().int(),
    result: z.string().min(1),
    auditReference: z.string().min(1)
  }).strict()).min(1),
  implementationProvider: z.enum(["codex", "claude"]),
  verifierProvider: z.enum(["codex", "claude"]),
  findings: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
  auditReferences: z.array(z.string().min(1)).min(1),
  verifierEffects: z.object({
    filesModified: z.literal(false),
    committed: z.literal(false),
    pushed: z.literal(false),
    pullRequestChanged: z.literal(false),
    merged: z.literal(false),
    deployed: z.literal(false),
    secretsAccessed: z.literal(false),
    productionAccessed: z.literal(false)
  }).strict()
}).strict().superRefine((report, context) => {
  if (report.implementationProvider === report.verifierProvider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verifierProvider"],
      message: "verification must use the opposite model family"
    });
  }
  if (report.verdict === "pass" && (
    report.evidence.length === 0
    || report.commands.some(({ exitCode }) => exitCode !== 0)
    || report.commands.some(({ auditReference }) => !report.evidence.includes(auditReference))
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "passing verification requires passing command evidence"
    });
  }
  if (report.verdict === "fail" && report.findings.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["findings"],
      message: "failed verification requires findings"
    });
  }
});

const VerificationDecisionStoreSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("verified_success"),
    evidence: z.array(z.string().min(1)).min(1)
  }).strict(),
  z.object({
    kind: z.literal("create_fix_task"),
    findings: z.array(z.string().min(1)).min(1),
    nextCycle: z.number().int().min(1).max(2)
  }).strict(),
  z.object({
    kind: z.literal("intervention_required"),
    findings: z.array(z.string().min(1)).min(1)
  }).strict()
]);

const VerificationAuditDataStoreSchema = z.object({
  reportId: z.string().min(1),
  runId: z.string().min(1),
  verificationTaskId: z.string().min(1),
  implementationTaskId: z.string().min(1),
  implementationDispatchId: z.string().min(1),
  cycle: z.number().int().min(0).max(2),
  verdict: z.enum(["pass", "fail"]),
  projectKey: z.string().min(1),
  implementationProvider: z.enum(["codex", "claude"]),
  verifierProvider: z.enum(["codex", "claude"]),
  commandAuditReferences: z.array(z.string().min(1)),
  auditReferences: z.array(z.string().min(1)),
  evidenceReferences: z.array(z.string().min(1)),
  findingCount: z.number().int().nonnegative()
}).strict();

const FixTaskStoreSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  sourceVerificationTaskId: z.string().min(1),
  implementationTaskId: z.string().min(1),
  title: z.string().min(1),
  role: z.literal("implement"),
  preferredAgent: z.enum(["codex", "claude"]),
  dependsOn: z.array(z.string().min(1)).length(1),
  cycle: z.number().int().min(1).max(2),
  findings: z.array(z.string().min(1)).min(1),
  requestedScope: z.array(z.string().min(1)),
  prohibitedEffects: z.array(z.string().min(1)),
  permissions: z.literal("read-write"),
  nestedWorkers: z.literal("forbidden")
}).strict();

const VerificationCommitStoreSchema = z.object({
  report: VerificationReportStoreSchema,
  decision: VerificationDecisionStoreSchema,
  audit: z.object({
    subjectId: z.string().min(1),
    eventType: z.enum([
      "verification.passed",
      "verification.failed",
      "verification.intervention_required"
    ]),
    data: VerificationAuditDataStoreSchema
  }).strict(),
  fixTask: FixTaskStoreSchema.optional(),
  outboxMessage: z.object({
    id: z.string().min(1),
    template: z.enum(["success", "intervention_required"]),
    payload: JsonValueSchema,
    commandId: z.string().min(1).optional(),
    channel: z.enum(["slack", "telegram", "tailscale-web"]),
    destination: z.string().min(1),
    nextAttemptAt: z.string().datetime()
  }).strict().optional()
}).strict();

export type StoredTaskRecord = Readonly<{
  id: string;
  taskId: string;
  runId: string;
  state: string;
  title: string;
  role: "investigate" | "implement" | "verify" | "summarize";
  preferredAgent: "codex" | "claude";
  cycle?: number | undefined;
  payload: JsonValue;
}>;

interface CommandRow {
  payload_json: string;
}

interface CommandIdentityRow {
  id: string;
}

type CommandInsertResult = Readonly<{
  kind: "accepted" | "duplicate";
  commandId: string;
}>;

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

interface WorktreeLockRow {
  state: string;
  payload_json: string;
}

interface TaskRow {
  id: string;
  state: string;
}

interface StoredTaskRow extends TaskRow {
  run_id: string;
  payload_json: string;
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

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function normalizeLease(leaseInput: WorktreeLease): WorktreeLease {
  const lease = WorktreeLeaseSchema.parse(leaseInput);
  return WorktreeLeaseSchema.parse({
    ...lease,
    acquiredAt: normalizeTimestamp(lease.acquiredAt),
    heartbeatAt: normalizeTimestamp(lease.heartbeatAt),
    expiresAt: normalizeTimestamp(lease.expiresAt)
  });
}

function worktreeLeaseFromRow(row: WorktreeLockRow): WorktreeLease {
  return normalizeLease(WorktreeLeaseSchema.parse(parseJson(row.payload_json)));
}

export class ControlStore implements CommandIngress {
  constructor(private readonly database: Database.Database) {}

  async accept(input: CommandEnvelope): Promise<Readonly<{
    kind: "accepted" | "duplicate";
    commandId: string;
  }>> {
    const command = CommandEnvelopeSchema.parse(input);
    return this.#insertCommand(command);
  }

  insertCommand(commandInput: CommandEnvelope): "inserted" | "duplicate" {
    const command = CommandEnvelopeSchema.parse(commandInput);
    return this.#insertCommand(command).kind === "accepted" ? "inserted" : "duplicate";
  }

  #insertCommand(command: CommandEnvelope): CommandInsertResult {
    const insert = this.database.transaction((): CommandInsertResult => {
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        INSERT INTO commands (
          id, idempotency_key, channel, external_message_id, external_thread_id,
          principal_id, received_at, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
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

      if (result.changes === 0) {
        const existing = this.database.prepare(`
          SELECT id
          FROM commands
          WHERE idempotency_key = ?
        `).get(command.idempotencyKey) as CommandIdentityRow | undefined;
        if (existing === undefined) throw new Error("Command idempotency conflict could not be resolved");
        return Object.freeze({ kind: "duplicate", commandId: existing.id });
      }

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
        command.idempotencyKey,
        JSON.stringify(command),
        now
      );

      this.appendAudit({
        subjectId: command.commandId,
        eventType: "command.accepted",
        data: {}
      });
      return Object.freeze({ kind: "accepted", commandId: command.commandId });
    });
    return insert.immediate();
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

  getOutbox(idInput: string): OutboxMessage | undefined {
    const id = z.string().min(1).parse(idInput);
    const row = this.database.prepare(`
      SELECT *
      FROM outbox_messages
      WHERE id = ?
    `).get(id) as OutboxMessageRow | undefined;
    return row === undefined ? undefined : outboxMessageFromRow(row);
  }

  listOutbox(): OutboxMessage[] {
    const rows = this.database.prepare(`
      SELECT *
      FROM outbox_messages
      ORDER BY created_at, id
    `).all() as OutboxMessageRow[];
    return rows.map(outboxMessageFromRow);
  }

  getTask(idInput: string): TaskRecord | undefined {
    const id = z.string().min(1).parse(idInput);
    const row = this.database.prepare(`
      SELECT id, state
      FROM tasks
      WHERE id = ?
    `).get(id) as TaskRow | undefined;
    return row === undefined ? undefined : Object.freeze({ id: row.id, state: row.state });
  }

  saveVerificationTask(taskInput: unknown): void {
    const payload = JsonValueSchema.parse(taskInput);
    const task = StoredGeneratedTaskSchema.parse(payload);
    if (task.role !== "verify") throw new TypeError("verification Task must have verify role");
    const now = new Date().toISOString();
    const existing = this.database.prepare(`
      SELECT run_id, state, payload_json
      FROM tasks
      WHERE id = ?
    `).get(task.taskId) as Omit<StoredTaskRow, "id"> | undefined;
    if (existing !== undefined) {
      if (
        existing.run_id !== task.runId
        || existing.state !== "planned"
        || existing.payload_json !== JSON.stringify(payload)
      ) {
        throw new Error(`Task ${task.taskId} already exists with different verification inputs`);
      }
      return;
    }
    this.database.prepare(`
      INSERT INTO tasks (id, run_id, state, payload_json, created_at, updated_at)
      VALUES (?, ?, 'planned', ?, ?, ?)
    `).run(task.taskId, task.runId, JSON.stringify(payload), now, now);
  }

  listTasks(): StoredTaskRecord[] {
    const rows = this.database.prepare(`
      SELECT id, run_id, state, payload_json
      FROM tasks
      ORDER BY created_at, id
    `).all() as StoredTaskRow[];
    return rows.map((row) => {
      const payload = JsonValueSchema.parse(parseJson(row.payload_json));
      const task = StoredTaskPayloadSchema.parse(payload);
      const payloadTaskId = task.taskId ?? task.id;
      if (payloadTaskId !== row.id || task.runId !== row.run_id) {
        throw new TypeError("persisted Task identity does not match its payload");
      }
      return Object.freeze({
        id: row.id,
        taskId: row.id,
        runId: task.runId,
        state: row.state,
        title: task.title,
        role: task.role,
        preferredAgent: task.preferredAgent,
        ...(task.cycle === undefined ? {} : { cycle: task.cycle }),
        payload
      });
    });
  }

  commitVerification(commitInput: unknown): void {
    const commit = VerificationCommitStoreSchema.parse(JsonValueSchema.parse(commitInput));
    const { report, decision, audit, fixTask, outboxMessage } = commit;
    if (report.implementationProvider === report.verifierProvider) {
      throw new TypeError("verification report must use the opposite model family");
    }
    const expectedAuditEvent = decision.kind === "verified_success"
      ? "verification.passed"
      : decision.kind === "intervention_required"
        ? "verification.intervention_required"
        : "verification.failed";
    if (
      audit.subjectId !== report.verificationTaskId
      || audit.eventType !== expectedAuditEvent
      || audit.data.reportId !== report.reportId
      || audit.data.runId !== report.runId
      || audit.data.verificationTaskId !== report.verificationTaskId
      || audit.data.implementationTaskId !== report.implementationTaskId
      || audit.data.implementationDispatchId !== report.implementationDispatchId
      || audit.data.cycle !== report.cycle
      || audit.data.verdict !== report.verdict
      || audit.data.implementationProvider !== report.implementationProvider
      || audit.data.verifierProvider !== report.verifierProvider
      || audit.data.projectKey !== report.projectRoute.projectKey
      || audit.data.findingCount !== report.findings.length
      || JSON.stringify(audit.data.commandAuditReferences)
        !== JSON.stringify(report.commands.map(({ auditReference }) => auditReference))
      || JSON.stringify(audit.data.auditReferences) !== JSON.stringify(report.auditReferences)
      || JSON.stringify(audit.data.evidenceReferences) !== JSON.stringify(report.evidence)
    ) {
      throw new TypeError("verification audit does not match its report");
    }
    const passing = report.verdict === "pass" && decision.kind === "verified_success";
    const fixing = report.verdict === "fail" && decision.kind === "create_fix_task";
    const intervening = report.verdict === "fail" && decision.kind === "intervention_required";
    if (!passing && !fixing && !intervening) {
      throw new TypeError("verification decision does not match its verdict");
    }
    if (
      (decision.kind === "verified_success"
        && JSON.stringify(decision.evidence) !== JSON.stringify(report.evidence))
      || (decision.kind !== "verified_success"
        && JSON.stringify(decision.findings) !== JSON.stringify(report.findings))
    ) {
      throw new TypeError("verification decision evidence does not match its report");
    }
    if (
      (passing && (fixTask !== undefined || outboxMessage?.template !== "success"))
      || (fixing && (fixTask === undefined || outboxMessage !== undefined))
      || (intervening && (fixTask !== undefined || outboxMessage?.template !== "intervention_required"))
    ) {
      throw new TypeError("verification side effects do not match the completion decision");
    }
    if (outboxMessage !== undefined) {
      const payload = outboxMessage.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new TypeError("verification Outbox payload must be an object");
      }
      const expectedState = passing ? "verified_success" : "intervention_required";
      if (
        outboxMessage.id !== `${report.reportId}:${passing ? "success" : "intervention"}`
        || payload.state !== expectedState
        || payload.reportId !== report.reportId
        || payload.implementationTaskId !== report.implementationTaskId
      ) {
        throw new TypeError("verification Outbox does not match its report");
      }
      if (passing && (
        payload.implementationProvider !== report.implementationProvider
        || payload.verifierProvider !== report.verifierProvider
        || payload.diffSummary !== report.diffSummary
        || JSON.stringify(payload.projectRoute) !== JSON.stringify(report.projectRoute)
        || JSON.stringify(payload.changedFiles) !== JSON.stringify(report.changedFiles)
        || JSON.stringify(payload.commands) !== JSON.stringify(report.commands)
        || JSON.stringify(payload.auditReferences) !== JSON.stringify(report.auditReferences)
        || JSON.stringify(payload.evidence) !== JSON.stringify(report.evidence)
      )) {
        throw new TypeError("verified success Outbox is missing final report evidence");
      }
    }
    if (fixTask !== undefined && (
      fixTask.role !== "implement"
      || fixTask.runId !== report.runId
      || decision.kind !== "create_fix_task"
      || fixTask.cycle !== decision.nextCycle
      || fixTask.taskId !== `${report.implementationTaskId}:fix:${decision.nextCycle}`
      || fixTask.sourceVerificationTaskId !== report.verificationTaskId
      || fixTask.implementationTaskId !== report.implementationTaskId
      || fixTask.preferredAgent !== report.implementationProvider
      || JSON.stringify(fixTask.dependsOn) !== JSON.stringify([report.verificationTaskId])
      || JSON.stringify(fixTask.findings) !== JSON.stringify(report.findings)
    )) {
      throw new TypeError("Fix Task does not match the failed verification");
    }

    this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT run_id, payload_json
        FROM tasks
        WHERE id = ?
      `).get(report.verificationTaskId) as Pick<StoredTaskRow, "run_id" | "payload_json"> | undefined;
      if (row === undefined || row.run_id !== report.runId) {
        throw new Error(`Verification Task ${report.verificationTaskId} is not persisted for its Run`);
      }
      const taskPayload = StoredGeneratedTaskSchema.parse(parseJson(row.payload_json));
      if (
        taskPayload.taskId !== report.verificationTaskId
        || taskPayload.preferredAgent !== report.verifierProvider
        || taskPayload.implementationTaskId !== report.implementationTaskId
        || taskPayload.implementationDispatchId !== report.implementationDispatchId
        || taskPayload.implementationProvider !== report.implementationProvider
        || taskPayload.cycle !== report.cycle
        || taskPayload.gitDiff === undefined
        || typeof taskPayload.gitDiff !== "object"
        || taskPayload.gitDiff === null
        || (taskPayload.gitDiff as { summary?: unknown }).summary !== report.diffSummary
        || JSON.stringify(taskPayload.projectRoute) !== JSON.stringify(report.projectRoute)
        || JSON.stringify(taskPayload.changedFiles) !== JSON.stringify(report.changedFiles)
        || JSON.stringify(
          Array.isArray(taskPayload.testReceipts)
            ? taskPayload.testReceipts.map((receipt) =>
              typeof receipt === "object" && receipt !== null && "command" in receipt
                ? (receipt as { command: unknown }).command
                : undefined
            )
            : []
        ) !== JSON.stringify(report.commands.map(({ command }) => command))
        || !Array.isArray(taskPayload.auditReferences)
        || !taskPayload.auditReferences.every((reference) =>
          typeof reference === "string" && report.auditReferences.includes(reference)
        )
      ) {
        throw new TypeError("verification report does not own the persisted Task");
      }
      if (fixTask !== undefined && (
        JSON.stringify(fixTask.requestedScope) !== JSON.stringify(taskPayload.requestedScope)
        || JSON.stringify(fixTask.prohibitedEffects)
          !== JSON.stringify(taskPayload.implementationProhibitedEffects)
      )) {
        throw new TypeError("Fix Task does not preserve its implementation boundary");
      }
      const taskState = passing
        ? "verified_success"
        : intervening
          ? "intervention_required"
          : "verification_failed";
      const durablePayload = JsonValueSchema.parse({ ...taskPayload, report });
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE tasks
        SET state = ?, payload_json = ?, updated_at = ?
        WHERE id = ? AND run_id = ?
      `).run(taskState, JSON.stringify(durablePayload), now, report.verificationTaskId, report.runId);

      if (fixTask !== undefined) {
        const fixPayload = JsonValueSchema.parse(fixTask);
        this.database.prepare(`
          INSERT INTO tasks (id, run_id, state, payload_json, created_at, updated_at)
          VALUES (?, ?, 'planned', ?, ?, ?)
        `).run(fixTask.taskId, fixTask.runId, JSON.stringify(fixPayload), now, now);
      }

      const runState = passing ? "verified_success" : intervening ? "intervention_required" : "active";
      const runUpdate = this.database.prepare(`
        UPDATE runs SET state = ?, updated_at = ? WHERE id = ?
      `).run(runState, now, report.runId);
      if (runUpdate.changes !== 1) throw new Error(`Run ${report.runId} is not persisted`);

      this.appendAudit({
        id: `${report.reportId}:audit`,
        subjectId: audit.subjectId,
        eventType: audit.eventType,
        data: audit.data
      });
      if (outboxMessage !== undefined) {
        this.enqueueOutbox({
          id: outboxMessage.id,
          ...(outboxMessage.commandId === undefined ? {} : { commandId: outboxMessage.commandId }),
          channel: outboxMessage.channel,
          destination: outboxMessage.destination,
          template: outboxMessage.template,
          payload: outboxMessage.payload,
          nextAttemptAt: outboxMessage.nextAttemptAt
        });
      }
    }).immediate();
  }

  markOutboxDelivered(
    idInput: string,
    providerMessageIdInput: string,
    deliveredAtInput = new Date().toISOString()
  ): void {
    const id = z.string().min(1).parse(idInput);
    const providerMessageId = z.string().min(1).parse(providerMessageIdInput);
    const deliveredAt = normalizeTimestamp(z.string().datetime().parse(deliveredAtInput));
    const result = this.database.prepare(`
      UPDATE outbox_messages
      SET state = 'delivered', provider_message_id = ?, last_error_json = NULL,
          claimed_by = NULL, claimed_at = NULL, updated_at = ?
      WHERE id = ? AND state = 'claimed'
    `).run(providerMessageId, deliveredAt, id);
    if (result.changes !== 1) throw new Error(`Outbox message ${id} is not claimed`);
  }

  rescheduleOutbox(
    idInput: string,
    retryInput: Readonly<{ nextAttemptAt: string; lastError: JsonValue }>,
    updatedAtInput = new Date().toISOString()
  ): void {
    const id = z.string().min(1).parse(idInput);
    const nextAttemptAt = normalizeTimestamp(z.string().datetime().parse(retryInput.nextAttemptAt));
    const lastError = JsonValueSchema.parse(retryInput.lastError);
    const updatedAt = normalizeTimestamp(z.string().datetime().parse(updatedAtInput));
    const result = this.database.prepare(`
      UPDATE outbox_messages
      SET state = 'pending', next_attempt_at = ?, last_error_json = ?,
          claimed_by = NULL, claimed_at = NULL, updated_at = ?
      WHERE id = ? AND state = 'claimed'
    `).run(nextAttemptAt, JSON.stringify(lastError), updatedAt, id);
    if (result.changes !== 1) throw new Error(`Outbox message ${id} is not claimed`);
  }

  markOutboxFailed(
    idInput: string,
    failureInput: Readonly<{
      channel: OutboxMessage["channel"];
      attempts: number;
      failure: JsonValue;
    }>,
    failedAtInput = new Date().toISOString()
  ): void {
    const id = z.string().min(1).parse(idInput);
    const channel = z.enum(["slack", "telegram", "tailscale-web"]).parse(failureInput.channel);
    const attempts = z.number().int().positive().parse(failureInput.attempts);
    const failure = JsonValueSchema.parse(failureInput.failure);
    const failedAt = normalizeTimestamp(z.string().datetime().parse(failedAtInput));
    this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE outbox_messages
        SET state = 'failed', last_error_json = ?, claimed_by = NULL,
            claimed_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'claimed'
      `).run(JSON.stringify(failure), failedAt, id);
      if (result.changes !== 1) throw new Error(`Outbox message ${id} is not claimed`);
      this.appendAudit({
        subjectId: id,
        eventType: "outbox.delivery_failed",
        data: { channel, attempts, failure }
      });
    }).immediate();
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

  acquireWorktreeLock(leaseInput: WorktreeLease): WorktreeAcquireResult {
    const lease = normalizeLease(leaseInput);
    const acquire = this.database.transaction((): WorktreeAcquireResult => {
      const row = this.database.prepare(`
        SELECT state, payload_json
        FROM worktree_locks
        WHERE id = ?
      `).get(lease.lockKey) as WorktreeLockRow | undefined;

      if (row === undefined) {
        this.database.prepare(`
          INSERT INTO worktree_locks (
            id, dispatch_id, state, payload_json, created_at, updated_at
          ) VALUES (?, ?, 'active', ?, ?, ?)
        `).run(
          lease.lockKey,
          lease.dispatchId,
          JSON.stringify(lease),
          lease.acquiredAt,
          lease.heartbeatAt
        );
        return Object.freeze({ kind: "acquired", lease });
      }

      if (row.state === "released") {
        this.database.prepare(`
          UPDATE worktree_locks
          SET dispatch_id = ?, state = 'active', payload_json = ?,
              created_at = ?, updated_at = ?
          WHERE id = ? AND state = 'released'
        `).run(
          lease.dispatchId,
          JSON.stringify(lease),
          lease.acquiredAt,
          lease.heartbeatAt,
          lease.lockKey
        );
        return Object.freeze({ kind: "acquired", lease });
      }

      const existing = worktreeLeaseFromRow(row);
      if (new Date(lease.acquiredAt).getTime() >= new Date(existing.expiresAt).getTime()) {
        return Object.freeze({
          kind: "review_required",
          reason: "expired_lease_requires_reconciliation",
          lease: existing
        });
      }
      if (existing.dispatchId === lease.dispatchId) {
        return Object.freeze({ kind: "acquired", lease: existing });
      }
      return Object.freeze({ kind: "conflict", lease: existing });
    });
    return acquire.immediate();
  }

  heartbeatWorktreeLock(input: WorktreeHeartbeatUpdate): WorktreeHeartbeatResult {
    const parsed = WorktreeHeartbeatUpdateSchema.parse(input);
    const heartbeat = {
      ...parsed,
      heartbeatAt: normalizeTimestamp(parsed.heartbeatAt),
      expiresAt: normalizeTimestamp(parsed.expiresAt)
    };
    const update = this.database.transaction((): WorktreeHeartbeatResult => {
      const row = this.database.prepare(`
        SELECT state, payload_json
        FROM worktree_locks
        WHERE id = ?
      `).get(heartbeat.lockKey) as WorktreeLockRow | undefined;
      if (row === undefined || row.state !== "active") {
        return Object.freeze({ kind: "not_found" });
      }

      const existing = worktreeLeaseFromRow(row);
      if (new Date(heartbeat.heartbeatAt).getTime() >= new Date(existing.expiresAt).getTime()) {
        return Object.freeze({
          kind: "review_required",
          reason: "expired_lease_requires_reconciliation",
          lease: existing
        });
      }
      if (existing.dispatchId !== heartbeat.dispatchId) {
        return Object.freeze({ kind: "conflict", lease: existing });
      }
      if (new Date(heartbeat.heartbeatAt).getTime() <= new Date(existing.heartbeatAt).getTime()) {
        return Object.freeze({
          kind: "review_required",
          reason: "non_monotonic_heartbeat",
          lease: existing
        });
      }

      const lease = normalizeLease({
        ...existing,
        heartbeatAt: heartbeat.heartbeatAt,
        expiresAt: heartbeat.expiresAt
      });
      this.database.prepare(`
        UPDATE worktree_locks
        SET payload_json = ?, updated_at = ?
        WHERE id = ? AND state = 'active' AND dispatch_id = ?
      `).run(JSON.stringify(lease), lease.heartbeatAt, lease.lockKey, lease.dispatchId);
      return Object.freeze({ kind: "heartbeated", lease });
    });
    return update.immediate();
  }

  releaseWorktreeLock(input: WorktreeReleaseUpdate): WorktreeReleaseResult {
    const release = WorktreeReleaseUpdateSchema.parse(input);
    const releasedAt = normalizeTimestamp(release.releasedAt);
    const update = this.database.transaction((): WorktreeReleaseResult => {
      const row = this.database.prepare(`
        SELECT state, payload_json
        FROM worktree_locks
        WHERE id = ?
      `).get(release.lockKey) as WorktreeLockRow | undefined;
      if (row === undefined || row.state !== "active") {
        return Object.freeze({ kind: "not_found" });
      }
      const existing = worktreeLeaseFromRow(row);
      if (existing.dispatchId !== release.dispatchId) {
        return Object.freeze({ kind: "conflict", lease: existing });
      }

      this.database.prepare(`
        UPDATE worktree_locks
        SET state = 'released', updated_at = ?
        WHERE id = ? AND state = 'active' AND dispatch_id = ?
      `).run(releasedAt, release.lockKey, release.dispatchId);
      return Object.freeze({ kind: "released" });
    });
    return update.immediate();
  }

  getWorktreeLock(lockKeyInput: string): WorktreeLease | undefined {
    const lockKey = z.string().min(1).parse(lockKeyInput);
    const row = this.database.prepare(`
      SELECT state, payload_json
      FROM worktree_locks
      WHERE id = ? AND state = 'active'
    `).get(lockKey) as WorktreeLockRow | undefined;
    return row === undefined ? undefined : worktreeLeaseFromRow(row);
  }
}
