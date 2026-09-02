import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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

const LifecycleRunStoreSchema = z.object({
  id: z.string().min(1),
  proposalId: z.string().min(1),
  commandId: z.string().min(1),
  state: z.string().min(1)
}).passthrough();

const LifecycleTaskStoreSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  state: z.string().min(1)
}).passthrough();

const LifecycleDispatchStoreSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  state: z.string().min(1)
}).passthrough();

const LifecycleTransitionStoreSchema = z.object({
  entity: z.enum(["run", "task", "dispatch"]),
  entityId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  at: z.string().datetime()
}).passthrough();

const LifecycleMessageStoreSchema = z.object({
  kind: z.string().min(1),
  messageId: z.string().min(1),
  dispatchId: z.string().min(1)
}).passthrough();

const WorkerDoneCommitStoreSchema = z.object({
  message: LifecycleMessageStoreSchema,
  dispatch: LifecycleDispatchStoreSchema,
  task: LifecycleTaskStoreSchema,
  transitions: z.array(LifecycleTransitionStoreSchema).length(2)
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
  diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
  diffSummary: z.string().min(1),
  commands: z.array(z.object({
    command: z.string().min(1),
    exitCode: z.number().int(),
    summary: z.string().min(1).max(512),
    auditReference: z.string().min(1).max(256)
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
  diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
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

const ProviderStartEvidenceStoreSchema = z.object({
  kind: z.literal("provider_start"),
  protocol: z.literal(1),
  provider: z.enum(["codex", "claude"]),
  assignmentTaskId: z.string().min(1),
  assignmentDispatchId: z.string().min(1),
  orcaTaskId: z.string().min(1),
  orcaDispatchId: z.string().min(1),
  promptArtifact: z.object({
    protocol: z.literal(1),
    artifactId: z.string().regex(/^assignment:[a-f0-9]{64}$/u),
    path: z.string().min(1),
    version: z.number().int().positive(),
    ownerDispatchId: z.string().min(1),
    content: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  }).strict(),
  boundary: z.object({
    lifecycleAuthority: z.literal("orca_worker_start"),
    promptDelivery: z.literal("prestart_atomic_assignment_artifact"),
    attemptContext: z.literal("orca_injected_task_spec_and_prestart_assignment"),
    credentialSource: z.literal("provider_authenticated_cli"),
    postStartMail: z.literal(false),
    providerChildEnvironmentIsolation: z.object({ kind: z.string().min(1) }).passthrough(),
    assignmentArtifactAccess: z.object({ kind: z.literal("same_host") }).strict()
  }).strict(),
  orcaReceipt: z.object({
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.object({
      dispatchId: z.string().min(1),
      taskId: z.string().min(1)
    }).passthrough()
  }).passthrough()
}).strict();

const ProviderInspectEvidenceStoreSchema = z.object({
  kind: z.literal("provider_inspect"),
  protocol: z.literal(1),
  provider: z.enum(["codex", "claude"]),
  dispatchId: z.string().min(1),
  workerState: z.string().min(1),
  showReceipt: z.object({
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.object({
      dispatch: z.object({ id: z.string().min(1) }).passthrough(),
      worker: z.object({ dispatch_id: z.string().min(1) }).passthrough(),
      observation: z.object({ exactWorker: z.literal(true) }).passthrough(),
      terminalResource: z.object({ id: z.string().min(1) }).passthrough()
    }).passthrough()
  }).passthrough(),
  readReceipt: z.object({
    id: z.string().min(1),
    ok: z.literal(true),
    result: z.object({ dispatchId: z.string().min(1) }).passthrough()
  }).passthrough()
}).strict();

const ProviderTerminalEvidenceStoreSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    dispatchId: z.string().min(1),
    verdict: z.enum(["released", "stopped"])
  }).passthrough()
}).passthrough();

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

interface StoredDispatchRow {
  id: string;
  task_id: string;
  state: string;
  payload_json: string;
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function verificationDecisionFor(
  report: z.infer<typeof VerificationReportStoreSchema>
): z.infer<typeof VerificationDecisionStoreSchema> {
  if (report.verdict === "pass") {
    return { kind: "verified_success", evidence: [...report.evidence] };
  }
  if (report.cycle < 2) {
    return {
      kind: "create_fix_task",
      findings: [...report.findings],
      nextCycle: report.cycle + 1
    };
  }
  return { kind: "intervention_required", findings: [...report.findings] };
}

function hasBoundProviderReceipts(
  payload: Record<string, unknown>,
  provider: "codex" | "claude",
  taskId: string,
  dispatchId: string
): boolean {
  const startResult = ProviderStartEvidenceStoreSchema.safeParse(payload.providerStartReceipt);
  const inspectionsResult = z.array(ProviderInspectEvidenceStoreSchema).min(1)
    .safeParse(payload.providerInspectReceipts);
  const terminalResult = ProviderTerminalEvidenceStoreSchema.safeParse(
    payload.releaseReceipt ?? payload.fenceReceipt
  );
  if (!startResult.success || !inspectionsResult.success || !terminalResult.success) return false;
  const start = startResult.data;
  const startReceiptResult = start.orcaReceipt.result;
  const orcaDispatchId = start.orcaDispatchId;
  const terminal = terminalResult.data.result;
  const assignment = objectValue(payload.assignment);
  return payload.providerId === provider
    && payload.id === dispatchId
    && payload.taskId === taskId
    && assignment?.taskId === taskId
    && assignment.dispatchId === dispatchId
    && start.provider === provider
    && start.assignmentTaskId === taskId
    && start.assignmentDispatchId === dispatchId
    && startReceiptResult.dispatchId === orcaDispatchId
    && startReceiptResult.taskId === start.orcaTaskId
    && inspectionsResult.data.every((inspection) => {
      return inspection.provider === provider
        && inspection.dispatchId === orcaDispatchId
        && inspection.showReceipt.result.dispatch.id === orcaDispatchId
        && inspection.showReceipt.result.worker.dispatch_id === orcaDispatchId
        && inspection.readReceipt.result.dispatchId === orcaDispatchId;
    })
    && terminal.dispatchId === orcaDispatchId
    && payload.releaseFailure === undefined
    && payload.fenceFailure === undefined;
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

  saveRun(recordInput: unknown): void {
    const payload = JsonValueSchema.parse(recordInput);
    const record = LifecycleRunStoreSchema.parse(payload);
    const now = new Date().toISOString();
    const existing = this.database.prepare(`
      SELECT command_id
      FROM runs
      WHERE id = ?
    `).get(record.id) as { command_id: string } | undefined;
    if (existing === undefined) {
      this.database.prepare(`
        INSERT INTO runs (
          id, command_id, execution_proposal_id, state, payload_json, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?)
      `).run(record.id, record.commandId, record.state, JSON.stringify(payload), now, now);
      return;
    }
    if (existing.command_id !== record.commandId) {
      throw new Error(`Run ${record.id} belongs to another Command`);
    }
    this.database.prepare(`
      UPDATE runs SET state = ?, payload_json = ?, updated_at = ? WHERE id = ?
    `).run(record.state, JSON.stringify(payload), now, record.id);
  }

  saveTask(recordInput: unknown): void {
    const payload = JsonValueSchema.parse(recordInput);
    const record = LifecycleTaskStoreSchema.parse(payload);
    const now = new Date().toISOString();
    const existing = this.database.prepare(`
      SELECT run_id, payload_json
      FROM tasks
      WHERE id = ?
    `).get(record.id) as Pick<StoredTaskRow, "run_id" | "payload_json"> | undefined;
    if (existing === undefined) {
      this.database.prepare(`
        INSERT INTO tasks (id, run_id, state, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(record.id, record.runId, record.state, JSON.stringify(payload), now, now);
      return;
    }
    if (existing.run_id !== record.runId) {
      throw new Error(`Task ${record.id} belongs to another Run`);
    }
    const existingPayload = objectValue(parseJson(existing.payload_json));
    const merged = JsonValueSchema.parse({ ...(existingPayload ?? {}), ...record });
    this.database.prepare(`
      UPDATE tasks SET state = ?, payload_json = ?, updated_at = ? WHERE id = ?
    `).run(record.state, JSON.stringify(merged), now, record.id);
  }

  saveDispatch(recordInput: unknown): void {
    const payload = JsonValueSchema.parse(recordInput);
    const record = LifecycleDispatchStoreSchema.parse(payload);
    const now = new Date().toISOString();
    const existing = this.database.prepare(`
      SELECT task_id
      FROM dispatches
      WHERE id = ?
    `).get(record.id) as { task_id: string } | undefined;
    if (existing === undefined) {
      this.database.prepare(`
        INSERT INTO dispatches (id, task_id, state, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(record.id, record.taskId, record.state, JSON.stringify(payload), now, now);
      return;
    }
    if (existing.task_id !== record.taskId) {
      throw new Error(`Dispatch ${record.id} belongs to another Task`);
    }
    this.database.prepare(`
      UPDATE dispatches SET state = ?, payload_json = ?, updated_at = ? WHERE id = ?
    `).run(record.state, JSON.stringify(payload), now, record.id);
  }

  appendTransition(transitionInput: unknown): void {
    const transition = LifecycleTransitionStoreSchema.parse(
      JsonValueSchema.parse(transitionInput)
    );
    this.database.prepare(`
      INSERT INTO audit_events (id, subject_id, event_type, data_json, created_at)
      VALUES (?, ?, 'lifecycle.transition', ?, ?)
    `).run(
      `transition:${randomUUID()}`,
      transition.entityId,
      JSON.stringify(transition),
      transition.at
    );
  }

  appendMessageOnce(messageInput: unknown): "inserted" | "duplicate" {
    const message = LifecycleMessageStoreSchema.parse(JsonValueSchema.parse(messageInput));
    const result = this.database.prepare(`
      INSERT INTO audit_events (id, subject_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      `worker-message:${message.messageId}`,
      message.dispatchId,
      `worker.${message.kind}`,
      JSON.stringify(message),
      new Date().toISOString()
    );
    return result.changes === 1 ? "inserted" : "duplicate";
  }

  commitWorkerDone(inputValue: unknown): "inserted" | "duplicate" {
    const input = WorkerDoneCommitStoreSchema.parse(JsonValueSchema.parse(inputValue));
    return this.database.transaction(() => {
      const messageId = `worker-message:${input.message.messageId}`;
      const existing = this.database.prepare(`
        SELECT id FROM audit_events WHERE id = ?
      `).get(messageId) as { id: string } | undefined;
      if (existing !== undefined) return "duplicate" as const;
      const dispatchUpdate = this.database.prepare(`
        UPDATE dispatches SET state = ?, payload_json = ?, updated_at = ?
        WHERE id = ? AND task_id = ? AND state = 'running'
      `).run(
        input.dispatch.state,
        JSON.stringify(input.dispatch),
        new Date().toISOString(),
        input.dispatch.id,
        input.dispatch.taskId
      );
      if (dispatchUpdate.changes !== 1) {
        throw new Error(`Dispatch ${input.dispatch.id} changed during worker_done`);
      }
      const taskRow = this.database.prepare(`
        SELECT run_id, payload_json FROM tasks WHERE id = ?
      `).get(input.task.id) as Pick<StoredTaskRow, "run_id" | "payload_json"> | undefined;
      if (taskRow === undefined || taskRow.run_id !== input.task.runId) {
        throw new Error(`Task ${input.task.id} is not persisted for worker_done`);
      }
      const taskPayload = objectValue(parseJson(taskRow.payload_json));
      const mergedTask = JsonValueSchema.parse({ ...(taskPayload ?? {}), ...input.task });
      const taskUpdate = this.database.prepare(`
        UPDATE tasks SET state = ?, payload_json = ?, updated_at = ?
        WHERE id = ? AND state = 'running'
      `).run(
        input.task.state,
        JSON.stringify(mergedTask),
        new Date().toISOString(),
        input.task.id
      );
      if (taskUpdate.changes !== 1) {
        throw new Error(`Task ${input.task.id} changed during worker_done`);
      }
      this.database.prepare(`
        INSERT INTO audit_events (id, subject_id, event_type, data_json, created_at)
        VALUES (?, ?, 'worker.worker_done', ?, ?)
      `).run(
        messageId,
        input.message.dispatchId,
        JSON.stringify(input.message),
        new Date().toISOString()
      );
      for (const transition of input.transitions) this.appendTransition(transition);
      return "inserted" as const;
    }).immediate();
  }

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
      const existingPayload = objectValue(parseJson(existing.payload_json));
      if (
        existing.run_id !== task.runId
        || existingPayload === undefined
        || Object.entries(objectValue(payload) ?? {}).some(([key, value]) =>
          !isDeepStrictEqual(existingPayload[key], value)
        )
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
    const recomputedDecision = verificationDecisionFor(report);
    if (JSON.stringify(decision) !== JSON.stringify(recomputedDecision)) {
      throw new TypeError("verification decision does not match the recomputed completion gate");
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
      || audit.data.diffSha256 !== report.diffSha256
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
        || payload.diffSha256 !== report.diffSha256
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
      const completionOwner = this.database.prepare(`
        SELECT id, run_id, state, payload_json
        FROM tasks
        WHERE id = ?
      `).get(report.verificationTaskId) as StoredTaskRow | undefined;
      if (
        completionOwner !== undefined
        && ["verified_success", "verification_failed", "intervention_required"]
          .includes(completionOwner.state)
      ) {
        const payload = objectValue(parseJson(completionOwner.payload_json));
        const expectedState = decision.kind === "verified_success"
          ? "verified_success"
          : decision.kind === "intervention_required"
            ? "intervention_required"
            : "verification_failed";
        if (
          completionOwner.run_id === report.runId
          && completionOwner.state === expectedState
          && JSON.stringify(payload?.report) === JSON.stringify(report)
          && JSON.stringify(payload?.completionDecision) === JSON.stringify(decision)
          && objectValue(payload?.completionStatus)?.ownerReportId === report.reportId
          && objectValue(payload?.completionStatus)?.status === "complete"
        ) return;
        throw new Error(`conflicting verification completion replay: ${report.verificationTaskId}`);
      }
      const runRow = this.database.prepare(`
        SELECT id, state
        FROM runs
        WHERE id = ?
      `).get(report.runId) as TaskRow | undefined;
      if (runRow === undefined || runRow.state !== "awaiting_verification") {
        throw new Error(`Run ${report.runId} is not awaiting_verification`);
      }
      const implementationTask = this.database.prepare(`
        SELECT id, run_id, state, payload_json
        FROM tasks
        WHERE id = ?
      `).get(report.implementationTaskId) as StoredTaskRow | undefined;
      const implementationTaskPayload = objectValue(
        implementationTask === undefined ? undefined : parseJson(implementationTask.payload_json)
      );
      if (
        implementationTask === undefined
        || implementationTask.run_id !== report.runId
        || implementationTask.state !== "worker_done"
        || implementationTaskPayload?.role !== "implement"
        || implementationTaskPayload.preferredAgent !== report.implementationProvider
      ) {
        throw new Error(
          `implementation Task ${report.implementationTaskId} is not durably worker_done`
        );
      }
      const implementationDispatch = this.database.prepare(`
        SELECT id, task_id, state, payload_json
        FROM dispatches
        WHERE id = ?
      `).get(report.implementationDispatchId) as StoredDispatchRow | undefined;
      if (
        implementationDispatch === undefined
        || implementationDispatch.task_id !== report.implementationTaskId
        || implementationDispatch.state !== "worker_done"
      ) {
        throw new Error(
          `implementation Dispatch ${report.implementationDispatchId} is not durably worker_done`
        );
      }
      const implementationDispatchPayload = objectValue(parseJson(
        implementationDispatch.payload_json
      ));
      if (
        implementationDispatchPayload === undefined
        || !hasBoundProviderReceipts(
          implementationDispatchPayload,
          report.implementationProvider,
          report.implementationTaskId,
          report.implementationDispatchId
        )
        || objectValue(implementationDispatchPayload.assignment)?.preferredAgent
          !== report.implementationProvider
      ) {
        throw new TypeError("implementation Dispatch provider evidence is not durably bound");
      }
      const row = this.database.prepare(`
        SELECT run_id, state, payload_json
        FROM tasks
        WHERE id = ?
      `).get(report.verificationTaskId) as Pick<
        StoredTaskRow,
        "run_id" | "state" | "payload_json"
      > | undefined;
      if (row === undefined || row.run_id !== report.runId || row.state !== "worker_done") {
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
        || (taskPayload.gitDiff as { sha256?: unknown }).sha256 !== report.diffSha256
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
      const verifierDispatchRows = this.database.prepare(`
        SELECT id, task_id, state, payload_json
        FROM dispatches
        WHERE task_id = ?
      `).all(report.verificationTaskId) as StoredDispatchRow[];
      if (verifierDispatchRows.length !== 1) {
        throw new Error(`Verification Task ${report.verificationTaskId} has no exact Dispatch`);
      }
      const verifierDispatch = verifierDispatchRows[0] as StoredDispatchRow;
      const verifierDispatchPayload = objectValue(parseJson(verifierDispatch.payload_json));
      const verifierAssignment = objectValue(verifierDispatchPayload?.assignment);
      if (
        verifierDispatch.state !== "worker_done"
        || verifierDispatchPayload === undefined
        || verifierAssignment?.role !== "verify"
        || verifierAssignment.preferredAgent !== report.verifierProvider
        || verifierAssignment.permissions !== "read-only"
        || verifierAssignment.nestedWorkers !== "forbidden"
        || JSON.stringify(verifierAssignment.acceptanceCommands)
          !== JSON.stringify(report.commands.map(({ command }) => command))
        || JSON.stringify(verifierDispatchPayload.verificationCommands)
          !== JSON.stringify(report.commands)
        || !hasBoundProviderReceipts(
          verifierDispatchPayload,
          report.verifierProvider,
          report.verificationTaskId,
          verifierDispatch.id
        )
      ) {
        throw new TypeError("verification report is not bound to durable verifier Dispatch evidence");
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
      const durablePayload = JsonValueSchema.parse({
        ...taskPayload,
        report,
        completionDecision: decision,
        completionStatus: {
          ownerReportId: report.reportId,
          status: "complete"
        }
      });
      const now = new Date().toISOString();
      const taskUpdate = this.database.prepare(`
        UPDATE tasks
        SET state = ?, payload_json = ?, updated_at = ?
        WHERE id = ? AND run_id = ? AND state = 'worker_done'
      `).run(taskState, JSON.stringify(durablePayload), now, report.verificationTaskId, report.runId);
      if (taskUpdate.changes !== 1) {
        throw new Error(`Verification Task ${report.verificationTaskId} changed during completion`);
      }

      if (fixTask !== undefined) {
        const fixPayload = JsonValueSchema.parse(fixTask);
        this.database.prepare(`
          INSERT INTO tasks (id, run_id, state, payload_json, created_at, updated_at)
          VALUES (?, ?, 'planned', ?, ?, ?)
        `).run(fixTask.taskId, fixTask.runId, JSON.stringify(fixPayload), now, now);
      }

      const outstanding = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM tasks
        WHERE run_id = ?
          AND (
            (
              json_extract(payload_json, '$.role') = 'verify'
              AND state NOT IN ('verified_success', 'verification_failed', 'intervention_required')
            )
            OR (
              json_extract(payload_json, '$.sourceVerificationTaskId') IS NOT NULL
              AND state NOT IN ('worker_done', 'intervention_required')
            )
          )
      `).get(report.runId) as { count: number };
      const finalPassingReport = passing && outstanding.count === 0;
      const runState = finalPassingReport
        ? "verified_success"
        : intervening
          ? "intervention_required"
          : fixing
            ? "active"
            : "awaiting_verification";
      const runUpdate = this.database.prepare(`
        UPDATE runs SET state = ?, updated_at = ?
        WHERE id = ? AND state = 'awaiting_verification'
      `).run(runState, now, report.runId);
      if (runUpdate.changes !== 1) throw new Error(`Run ${report.runId} is not persisted`);

      this.appendAudit({
        id: `${report.reportId}:audit`,
        subjectId: audit.subjectId,
        eventType: audit.eventType,
        data: audit.data
      });
      if (outboxMessage !== undefined && (!passing || finalPassingReport)) {
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
