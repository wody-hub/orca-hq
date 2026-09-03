import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  ApprovalConfirmationSchema,
  ApprovalRecordSchema,
  PersistedApprovalRequestSchema,
  PersistedApprovalSchema,
  ChannelMessageJsonSchema,
  CommandEnvelopeSchema,
  type ChannelMessageJson,
  type CommandEnvelope,
  type CommandIngress,
  type ApprovalConfirmation,
  type ApprovalRecord,
  type PersistedApprovalRequest,
  type PersistedApproval
} from "@orca-hq/core";
import { OrcaReceiptSchema, parseOrcaOperationReceipt } from "@orca-hq/orca-adapter";
import {
  ProviderInspectReceiptSchema,
  ProviderStartReceiptSchema,
  TrustedRepositorySnapshotSchema,
  assertAuthoritativeActiveWorkerInspection,
  assertAuthoritativeWorkerIdentityInspection
} from "@orca-hq/worker-routing";
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

const WorkerCompletionIdentityStoreSchema = z.object({
  dispatchId: z.string().min(1),
  outcome: z.enum(["completed", "failed"]),
  summary: z.string().min(1)
}).strict();

const WorkerDoneMessageStoreSchema = z.object({
  kind: z.literal("worker_done"),
  messageId: z.string().min(1),
  dispatchId: z.string().min(1),
  outcome: z.enum(["completed", "failed"]),
  summary: z.string().min(1)
}).strict();

const VerificationObligationStoreSchema = z.object({
  rootImplementationTaskId: z.string().min(1),
  currentImplementationTaskId: z.string().min(1),
  implementationDispatchId: z.string().min(1),
  cycle: z.number().int().min(0).max(2),
  status: z.enum([
    "pending",
    "verifier_running",
    "fix_required",
    "passed",
    "intervention_required"
  ]),
  verificationTaskId: z.string().min(1).optional()
}).strict();

const VerificationObligationVerifierInputSchema = z.object({
  runId: z.string().min(1),
  rootImplementationTaskId: z.string().min(1),
  currentImplementationTaskId: z.string().min(1),
  implementationDispatchId: z.string().min(1),
  cycle: z.number().int().min(0).max(2),
  verificationTaskId: z.string().min(1)
}).strict();

const WorkerDoneCommitStoreSchema = z.object({
  message: WorkerDoneMessageStoreSchema,
  dispatch: LifecycleDispatchStoreSchema.extend({
    state: z.literal("worker_done"),
    workerCompletion: WorkerCompletionIdentityStoreSchema,
    workerCompletionAuditReference: z.string().min(1)
  }).passthrough(),
  task: LifecycleTaskStoreSchema,
  transitions: z.array(LifecycleTransitionStoreSchema).length(2)
}).strict();

const LaunchFailureCommitStoreSchema = z.object({
  message: z.object({
    kind: z.literal("launch_failure"),
    messageId: z.string().min(1),
    dispatchId: z.string().min(1),
    evidence: z.object({
      kind: z.literal("orca_worker_state"),
      state: z.enum(["launch_failed", "process_failed"])
    }).strict()
  }).strict(),
  dispatch: LifecycleDispatchStoreSchema.extend({
    state: z.literal("launch_failed"),
    launchFailureId: z.string().min(1),
    orcaDispatchId: z.string().min(1),
    fenceReceipt: OrcaReceiptSchema
  }).passthrough(),
  transition: LifecycleTransitionStoreSchema
}).strict();

const LaunchFailureReservationCommitStoreSchema = z.object({
  message: z.object({
    kind: z.literal("launch_failure"),
    messageId: z.string().min(1),
    dispatchId: z.string().min(1),
    evidence: z.object({
      kind: z.literal("orca_worker_state"),
      state: z.enum(["launch_failed", "process_failed"])
    }).strict()
  }).strict(),
  dispatch: LifecycleDispatchStoreSchema.extend({
    state: z.literal("launch_failure_reserved"),
    launchFailureId: z.string().min(1),
    orcaDispatchId: z.string().min(1)
  }).passthrough(),
  transition: LifecycleTransitionStoreSchema
}).strict();

const LaunchSuccessCommitStoreSchema = z.object({
  dispatch: LifecycleDispatchStoreSchema.extend({
    state: z.literal("running"),
    orcaDispatchId: z.string().min(1),
    providerId: z.enum(["codex", "claude"]),
    providerStartReceipt: ProviderStartReceiptSchema,
    providerInspectReceipts: z.array(ProviderInspectReceiptSchema).min(1)
  }).passthrough(),
  task: LifecycleTaskStoreSchema.extend({ state: z.literal("running") }).passthrough(),
  transitions: z.array(LifecycleTransitionStoreSchema).max(2)
}).strict();

const LaunchInterventionCommitStoreSchema = z.object({
  dispatch: LifecycleDispatchStoreSchema.extend({
    state: z.literal("intervention_required"),
    orcaDispatchId: z.string().min(1).optional(),
    fenceReceipt: OrcaReceiptSchema.optional(),
    fenceFailure: z.object({
      code: z.string().min(1),
      retryable: z.boolean()
    }).strict().optional()
  }).passthrough().refine(
    (dispatch) => (
      dispatch.fenceReceipt !== undefined || dispatch.fenceFailure !== undefined
    ) && (
      dispatch.fenceReceipt === undefined || dispatch.orcaDispatchId !== undefined
    ),
    { message: "launch intervention requires a bound fence outcome" }
  ),
  task: LifecycleTaskStoreSchema.extend({
    state: z.literal("intervention_required")
  }).passthrough(),
  run: LifecycleRunStoreSchema.extend({
    state: z.literal("intervention_required")
  }).passthrough(),
  transitions: z.array(LifecycleTransitionStoreSchema).max(3)
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
    outcome: z.enum(["passed", "failed"]),
    auditReference: z.string().min(1).max(256)
  }).strict().superRefine((receipt, context) => {
    const expectedOutcome = receipt.exitCode === 0 ? "passed" : "failed";
    if (receipt.outcome !== expectedOutcome) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "command outcome must match its exit code"
      });
    }
  })).min(1),
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
    || report.commands.some(({ exitCode, outcome }) => exitCode !== 0 || outcome !== "passed")
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

const DurableFixLineageSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  sourceVerificationTaskId: z.string().min(1),
  implementationTaskId: z.string().min(1),
  role: z.literal("implement"),
  dependsOn: z.array(z.string().min(1)).length(1),
  cycle: z.number().int().min(1).max(2)
}).passthrough();

const DurableVerifierLineageSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  role: z.literal("verify"),
  implementationTaskId: z.string().min(1),
  cycle: z.number().int().min(0).max(2)
}).passthrough();

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

interface ApprovalRow {
  execution_proposal_id: string;
  state: string;
  payload_json: string;
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

type VerificationObligation = z.infer<typeof VerificationObligationStoreSchema>;

type DurableLineageTask = Readonly<{
  id: string;
  state: string;
  payload: Record<string, unknown>;
}>;

type DurableImplementationLineage = Readonly<{
  rootTaskId: string;
  currentTaskId: string;
  cycle: number;
}>;

function deriveDurableImplementationLineages(
  database: Database.Database,
  runId: string,
  obligations: readonly VerificationObligation[]
): ReadonlyMap<string, DurableImplementationLineage> {
  const rows = database.prepare(`
    SELECT id, state, payload_json
    FROM tasks
    WHERE run_id = ?
  `).all(runId) as Array<Pick<StoredTaskRow, "id" | "state" | "payload_json">>;
  const tasks: DurableLineageTask[] = rows.map((row) => {
    const payload = objectValue(parseJson(row.payload_json));
    if (payload === undefined) throw new TypeError(`Task ${row.id} payload is invalid`);
    return { id: row.id, state: row.state, payload };
  });
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const roots = tasks.filter((task) =>
    task.payload.role === "implement" && task.payload.sourceVerificationTaskId === undefined
  );
  const derivedRootIds = roots.map(({ id }) => id).sort();
  const obligationRootIds = obligations.map(({ rootImplementationTaskId }) =>
    rootImplementationTaskId
  ).sort();
  if (
    new Set(obligationRootIds).size !== obligationRootIds.length
    || !isDeepStrictEqual(derivedRootIds, obligationRootIds)
  ) {
    throw new TypeError(`Run ${runId} verification obligation roots are not exhaustive`);
  }

  const resolvedFixes = new Map<string, DurableImplementationLineage>();
  const resolving = new Set<string>();
  const resolveFix = (task: DurableLineageTask): DurableImplementationLineage => {
    const existing = resolvedFixes.get(task.id);
    if (existing !== undefined) return existing;
    if (resolving.has(task.id)) {
      throw new TypeError(`Run ${runId} latest Fix lineage contains a cycle`);
    }
    resolving.add(task.id);
    try {
      const fix = DurableFixLineageSchema.parse(task.payload);
      if (fix.taskId !== task.id || fix.runId !== runId) {
        throw new TypeError(`Run ${runId} latest Fix lineage has a mismatched Task identity`);
      }
      const parent = tasksById.get(fix.implementationTaskId);
      if (parent === undefined || parent.payload.role !== "implement") {
        throw new TypeError(`Run ${runId} latest Fix lineage has no implementation parent`);
      }
      const parentLineage = parent.payload.sourceVerificationTaskId === undefined
        ? { rootTaskId: parent.id, currentTaskId: parent.id, cycle: 0 }
        : resolveFix(parent);
      const sourceVerifier = tasksById.get(fix.sourceVerificationTaskId);
      if (sourceVerifier === undefined) {
        throw new TypeError(`Run ${runId} latest Fix lineage has no source verifier`);
      }
      const verifier = DurableVerifierLineageSchema.parse(sourceVerifier.payload);
      if (
        verifier.taskId !== sourceVerifier.id
        || verifier.runId !== runId
        || verifier.implementationTaskId !== parent.id
        || verifier.cycle !== parentLineage.cycle
        || fix.cycle !== parentLineage.cycle + 1
        || !isDeepStrictEqual(fix.dependsOn, [sourceVerifier.id])
      ) {
        throw new TypeError(`Run ${runId} latest Fix lineage is not monotonic`);
      }
      const lineage = {
        rootTaskId: parentLineage.rootTaskId,
        currentTaskId: task.id,
        cycle: fix.cycle
      };
      resolvedFixes.set(task.id, lineage);
      return lineage;
    } finally {
      resolving.delete(task.id);
    }
  };

  const fixesByRootAndCycle = new Map<string, Map<number, DurableLineageTask>>();
  for (const task of tasks) {
    if (task.payload.role !== "implement" || task.payload.sourceVerificationTaskId === undefined) {
      continue;
    }
    const lineage = resolveFix(task);
    const fixesByCycle = fixesByRootAndCycle.get(lineage.rootTaskId) ?? new Map();
    if (fixesByCycle.has(lineage.cycle)) {
      throw new TypeError(`Run ${runId} latest Fix lineage branches at cycle ${lineage.cycle}`);
    }
    fixesByCycle.set(lineage.cycle, task);
    fixesByRootAndCycle.set(lineage.rootTaskId, fixesByCycle);
  }

  return new Map(roots.map((root) => {
    const fixesByCycle = fixesByRootAndCycle.get(root.id);
    const cycleOne = fixesByCycle?.get(1);
    const cycleTwo = fixesByCycle?.get(2);
    if (cycleTwo !== undefined && cycleOne === undefined) {
      throw new TypeError(`Run ${runId} latest Fix lineage skips cycle 1`);
    }
    if (cycleOne !== undefined) {
      const firstFix = DurableFixLineageSchema.parse(cycleOne.payload);
      if (firstFix.implementationTaskId !== root.id) {
        throw new TypeError(`Run ${runId} latest Fix lineage has a historical branch`);
      }
    }
    if (cycleTwo !== undefined) {
      const secondFix = DurableFixLineageSchema.parse(cycleTwo.payload);
      if (secondFix.implementationTaskId !== cycleOne?.id) {
        throw new TypeError(`Run ${runId} latest Fix lineage has a historical branch`);
      }
    }
    const current = cycleTwo ?? cycleOne ?? root;
    return [root.id, {
      rootTaskId: root.id,
      currentTaskId: current.id,
      cycle: cycleTwo === undefined ? cycleOne === undefined ? 0 : 1 : 2
    }];
  }));
}

function assertObligationsOwnLatestLineages(
  database: Database.Database,
  runId: string,
  obligations: readonly VerificationObligation[]
): ReadonlyMap<string, DurableImplementationLineage> {
  const lineages = deriveDurableImplementationLineages(database, runId, obligations);
  for (const obligation of obligations) {
    const lineage = lineages.get(obligation.rootImplementationTaskId);
    if (
      lineage === undefined
      || obligation.currentImplementationTaskId !== lineage.currentTaskId
      || obligation.cycle !== lineage.cycle
    ) {
      throw new TypeError(`Run ${runId} obligation does not own its latest Fix lineage`);
    }
    if (
      obligation.verificationTaskId !== undefined
      && obligation.verificationTaskId !==
        `${lineage.currentTaskId}:verify:${lineage.cycle}`
    ) {
      throw new TypeError(`Run ${runId} verifier identity is not bound to its latest Fix lineage`);
    }
  }
  return lineages;
}

function assertInitialVerificationObligations(
  database: Database.Database,
  runId: string,
  obligations: readonly VerificationObligation[],
  existing?: readonly VerificationObligation[]
): void {
  const existingByRoot = existing === undefined
    ? undefined
    : new Map(existing.map((obligation) => [obligation.rootImplementationTaskId, obligation]));
  for (const obligation of obligations) {
    const task = database.prepare(`
      SELECT run_id, state, payload_json FROM tasks WHERE id = ?
    `).get(obligation.rootImplementationTaskId) as Omit<StoredTaskRow, "id"> | undefined;
    const taskPayload = objectValue(task === undefined ? undefined : parseJson(task.payload_json));
    const dispatch = database.prepare(`
      SELECT task_id, state FROM dispatches WHERE id = ?
    `).get(obligation.implementationDispatchId) as {
      task_id: string;
      state: string;
    } | undefined;
    const verificationTaskId = `${obligation.rootImplementationTaskId}:verify:0`;
    if (
      obligation.currentImplementationTaskId !== obligation.rootImplementationTaskId
      || obligation.cycle !== 0
      || obligation.status !== "pending"
      || obligation.verificationTaskId !== verificationTaskId
      || task === undefined
      || task.run_id !== runId
      || task.state !== "worker_done"
      || taskPayload?.role !== "implement"
      || taskPayload.sourceVerificationTaskId !== undefined
      || dispatch?.task_id !== obligation.rootImplementationTaskId
      || dispatch.state !== "worker_done"
    ) {
      throw new TypeError("initial verification obligation is not bound to its root Task");
    }
    if (existing === undefined) continue;
    const verificationTask = database.prepare(`
      SELECT run_id, payload_json FROM tasks WHERE id = ?
    `).get(verificationTaskId) as Pick<StoredTaskRow, "run_id" | "payload_json"> | undefined;
    const verificationTaskPayload = objectValue(
      verificationTask === undefined ? undefined : parseJson(verificationTask.payload_json)
    );
    const existingObligation = existingByRoot?.get(obligation.rootImplementationTaskId);
    const ownsOriginalRequest = verificationTask === undefined
      ? existingObligation?.currentImplementationTaskId === obligation.rootImplementationTaskId
        && existingObligation.implementationDispatchId === obligation.implementationDispatchId
        && existingObligation.cycle === 0
        && existingObligation.verificationTaskId === verificationTaskId
      : verificationTask.run_id === runId
        && verificationTaskPayload?.taskId === verificationTaskId
        && verificationTaskPayload.role === "verify"
        && verificationTaskPayload.implementationTaskId === obligation.rootImplementationTaskId
        && verificationTaskPayload.implementationDispatchId === obligation.implementationDispatchId
        && verificationTaskPayload.cycle === 0;
    if (!ownsOriginalRequest) {
      throw new Error(`Run ${runId} has conflicting verification obligations`);
    }
  }
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

type BoundProviderReceiptOptions = Readonly<{
  inspectionMode?: "active_start" | "launch_failure_identity" | undefined;
  verifierSnapshotMode?: "completion" | "launch_failure" | undefined;
  expectedVerifierDiffSha256?: string | undefined;
}>;

function hasBoundActiveProviderReceipts(
  payload: Record<string, unknown>,
  provider: "codex" | "claude",
  taskId: string,
  dispatchId: string,
  orcaTaskId: string,
  orcaRunId: string,
  inspectionMode: "active_start" | "launch_failure_identity" = "active_start"
): boolean {
  const startResult = ProviderStartReceiptSchema.safeParse(payload.providerStartReceipt);
  const inspectionsResult = z.array(ProviderInspectReceiptSchema).min(1)
    .safeParse(payload.providerInspectReceipts);
  if (!startResult.success || !inspectionsResult.success) return false;
  const start = startResult.data;
  const orcaDispatchId = start.orcaDispatchId;
  const assignment = objectValue(payload.assignment);
  const assignmentArtifact = objectValue(payload.assignmentArtifact);
  try {
    const startReceiptResult = start.orcaReceipt.result;
    for (const inspection of inspectionsResult.data) {
      if (inspectionMode === "launch_failure_identity") {
        assertAuthoritativeWorkerIdentityInspection(
          inspection.showReceipt,
          inspection.readReceipt,
          { dispatchId: orcaDispatchId, taskId: orcaTaskId, runId: orcaRunId }
        );
      } else {
        assertAuthoritativeActiveWorkerInspection(
          inspection.showReceipt,
          inspection.readReceipt,
          {
            dispatchId: orcaDispatchId,
            taskId: orcaTaskId,
            runId: orcaRunId,
            workerState: start.orcaReceipt.result.state,
            workerStage: start.orcaReceipt.result.stage
          }
        );
      }
      if (
        inspection.provider !== provider
        || inspection.dispatchId !== orcaDispatchId
        || inspection.workerState !== inspection.showReceipt.result.worker.state
      ) return false;
    }
    return payload.providerId === provider
      && payload.id === dispatchId
      && payload.taskId === taskId
      && payload.orcaDispatchId === orcaDispatchId
      && assignment?.taskId === taskId
      && assignment.dispatchId === dispatchId
      && start.provider === provider
      && start.assignmentTaskId === taskId
      && start.assignmentDispatchId === dispatchId
      && start.orcaTaskId === orcaTaskId
      && start.promptArtifact.ownerDispatchId === dispatchId
      && assignmentArtifact !== undefined
      && isDeepStrictEqual(assignmentArtifact, start.promptArtifact)
      && startReceiptResult.dispatchId === orcaDispatchId
      && startReceiptResult.taskId === orcaTaskId
      && startReceiptResult.runId === orcaRunId;
  } catch {
    return false;
  }
}

function hasBoundProviderReceipts(
  payload: Record<string, unknown>,
  provider: "codex" | "claude",
  taskId: string,
  dispatchId: string,
  orcaTaskId: string,
  orcaRunId: string,
  options: BoundProviderReceiptOptions = {}
): boolean {
  const startResult = ProviderStartReceiptSchema.safeParse(payload.providerStartReceipt);
  const inspectionsResult = z.array(ProviderInspectReceiptSchema).min(1)
    .safeParse(payload.providerInspectReceipts);
  if (!startResult.success || !inspectionsResult.success) return false;
  const start = startResult.data;
  const orcaDispatchId = start.orcaDispatchId;
  const assignment = objectValue(payload.assignment);
  const assignmentArtifact = objectValue(payload.assignmentArtifact);
  try {
    const startReceipt = start.orcaReceipt;
    const startReceiptResult = startReceipt.result;
    for (const inspection of inspectionsResult.data) {
      const showReceipt = inspection.showReceipt;
      const readReceipt = inspection.readReceipt;
      const show = showReceipt.result;
      const read = readReceipt.result;
      if (options.inspectionMode === "launch_failure_identity") {
        assertAuthoritativeWorkerIdentityInspection(showReceipt, readReceipt, {
          dispatchId: orcaDispatchId,
          taskId: orcaTaskId,
          runId: orcaRunId
        });
      } else {
        assertAuthoritativeActiveWorkerInspection(showReceipt, readReceipt, {
          dispatchId: orcaDispatchId,
          taskId: orcaTaskId,
          runId: orcaRunId,
          workerState: startReceipt.result.state,
          workerStage: startReceipt.result.stage
        });
      }
      if (
        inspection.provider !== provider
        || inspection.dispatchId !== orcaDispatchId
        || show.dispatch.id !== orcaDispatchId
        || show.dispatch.task_id !== orcaTaskId
        || show.dispatch.run_id !== orcaRunId
        || show.worker.dispatch_id !== orcaDispatchId
        || show.worker.agent_terminal_handle === null
        || show.worker.agent_terminal_handle !== show.terminalResource.id
        || inspection.workerState !== show.worker.state
        || show.worker.state !== show.observation.status
        || show.worker.state !== read.status.worker
        || read.dispatchId !== orcaDispatchId
        || show.terminalResource.ownershipState !== "owned"
        || show.terminalResource.releaseState !== "active"
        || (
          options.inspectionMode !== "launch_failure_identity"
          && (
            startReceipt.result.state !== show.worker.state
            || startReceipt.result.stage !== show.worker.stage
            || read.status.terminal !== "running"
          )
        )
      ) return false;
    }
    const terminalOperation = payload.releaseReceipt === undefined ? "stop_worker" : "release_worker";
    const terminalEnvelope = OrcaReceiptSchema.parse(
      payload.releaseReceipt ?? payload.fenceReceipt
    );
    if (!terminalEnvelope.ok) return false;
    const terminalReceipt = parseOrcaOperationReceipt(
      terminalOperation,
      terminalEnvelope
    );
    const terminal = objectValue(terminalReceipt.result);
    const expectedTerminal = terminalOperation === "release_worker"
      ? { state: "released", verdict: "released" }
      : { state: "stopped", verdict: "stopped" };
    const repositorySnapshots = objectValue(payload.repositorySnapshots);
    const beforeSnapshot = TrustedRepositorySnapshotSchema.safeParse(repositorySnapshots?.before);
    const afterSnapshot = TrustedRepositorySnapshotSchema.safeParse(repositorySnapshots?.after);
    const assignmentRepo = objectValue(assignment?.repo);
    const assignmentWorktree = objectValue(assignment?.worktree);
    const verifierRepositorySafe = assignment?.role !== "verify" || (
      beforeSnapshot.success
      && beforeSnapshot.data.repositoryPath === assignmentRepo?.repositoryPath
      && beforeSnapshot.data.worktreePath === assignmentWorktree?.path
      && beforeSnapshot.data.worktreeKind === assignmentWorktree?.kind
      && beforeSnapshot.data.branch === assignmentWorktree?.branch
      && beforeSnapshot.data.diffSha256 === options.expectedVerifierDiffSha256
      && (
        options.verifierSnapshotMode === "launch_failure"
        || (
          repositorySnapshots?.mutated === false
          && afterSnapshot.success
          && isDeepStrictEqual(
            { ...beforeSnapshot.data, auditReference: undefined },
            { ...afterSnapshot.data, auditReference: undefined }
          )
        )
      )
    );
    return verifierRepositorySafe
    && payload.providerId === provider
    && payload.id === dispatchId
    && payload.taskId === taskId
    && payload.orcaDispatchId === orcaDispatchId
    && assignment?.taskId === taskId
    && assignment.dispatchId === dispatchId
    && start.provider === provider
    && start.assignmentTaskId === taskId
    && start.assignmentDispatchId === dispatchId
    && start.orcaTaskId === orcaTaskId
    && start.promptArtifact.ownerDispatchId === dispatchId
    && assignmentArtifact !== undefined
    && isDeepStrictEqual(assignmentArtifact, start.promptArtifact)
    && startReceiptResult.dispatchId === orcaDispatchId
    && startReceiptResult.taskId === orcaTaskId
    && startReceiptResult.runId === orcaRunId
    && terminal?.dispatchId === orcaDispatchId
    && terminal.state === expectedTerminal.state
    && terminal.verdict === expectedTerminal.verdict
    && payload.releaseFailure === undefined
    && payload.fenceFailure === undefined;
  } catch {
    return false;
  }
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

export class WorkerCompletionConflictError extends Error {
  readonly code = "worker_completion_conflict";
  readonly retryable = false;

  constructor(dispatchId: string) {
    super(`Dispatch ${dispatchId} has conflicting worker completion content`);
    this.name = "WorkerCompletionConflictError";
  }
}

export class ControlStore implements CommandIngress {
  constructor(private readonly database: Database.Database) {}

  saveRun(recordInput: unknown): void {
    const payload = JsonValueSchema.parse(recordInput);
    const record = LifecycleRunStoreSchema.parse(payload);
    const now = new Date().toISOString();
    const existing = this.database.prepare(`
      SELECT command_id, payload_json
      FROM runs
      WHERE id = ?
    `).get(record.id) as { command_id: string; payload_json: string } | undefined;
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
    const existingPayload = objectValue(parseJson(existing.payload_json));
    const merged = JsonValueSchema.parse({ ...(existingPayload ?? {}), ...record });
    this.database.prepare(`
      UPDATE runs SET state = ?, payload_json = ?, updated_at = ? WHERE id = ?
    `).run(record.state, JSON.stringify(merged), now, record.id);
  }

  ensureVerificationObligations(runIdInput: unknown, obligationsInput: unknown): void {
    const runId = z.string().min(1).parse(runIdInput);
    const obligations = z.array(VerificationObligationStoreSchema).min(1).parse(obligationsInput);
    this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT payload_json FROM runs WHERE id = ?
      `).get(runId) as { payload_json: string } | undefined;
      if (row === undefined) throw new Error(`Run ${runId} is not persisted`);
      const payload = objectValue(parseJson(row.payload_json));
      if (payload === undefined) throw new TypeError(`Run ${runId} payload is invalid`);
      if (payload.verificationObligations !== undefined) {
        const existing = z.array(VerificationObligationStoreSchema).min(1)
          .parse(payload.verificationObligations);
        assertObligationsOwnLatestLineages(this.database, runId, existing);
        const existingRoots = existing.map(({ rootImplementationTaskId }) =>
          rootImplementationTaskId
        ).sort();
        const requestedRoots = obligations.map(({ rootImplementationTaskId }) =>
          rootImplementationTaskId
        ).sort();
        if (!isDeepStrictEqual(existingRoots, requestedRoots)) {
          throw new Error(`Run ${runId} has conflicting verification obligations`);
        }
        assertInitialVerificationObligations(this.database, runId, obligations, existing);
        return;
      }
      const lineages = assertObligationsOwnLatestLineages(this.database, runId, obligations);
      if ([...lineages.values()].some(({ cycle }) => cycle !== 0)) {
        throw new TypeError("initial verification obligation is not bound to its root Task");
      }
      assertInitialVerificationObligations(this.database, runId, obligations);
      const updated = JsonValueSchema.parse({ ...payload, verificationObligations: obligations });
      this.database.prepare(`
        UPDATE runs SET payload_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(updated), new Date().toISOString(), runId);
    }).immediate();
  }

  setVerificationObligationVerifier(inputValue: unknown): void {
    const input = VerificationObligationVerifierInputSchema.parse(inputValue);
    this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT payload_json FROM runs WHERE id = ?
      `).get(input.runId) as { payload_json: string } | undefined;
      if (row === undefined) throw new Error(`Run ${input.runId} is not persisted`);
      const payload = objectValue(parseJson(row.payload_json));
      const obligations = z.array(VerificationObligationStoreSchema).min(1)
        .parse(payload?.verificationObligations);
      const lineages = assertObligationsOwnLatestLineages(
        this.database,
        input.runId,
        obligations
      );
      const index = obligations.findIndex(({ rootImplementationTaskId }) =>
        rootImplementationTaskId === input.rootImplementationTaskId
      );
      const current = obligations[index];
      if (current === undefined) {
        throw new Error(`Run ${input.runId} has no verification obligation for the root Task`);
      }
      const lineage = lineages.get(input.rootImplementationTaskId);
      const implementationDispatch = this.database.prepare(`
        SELECT task_id, state
        FROM dispatches
        WHERE id = ?
      `).get(input.implementationDispatchId) as {
        task_id: string;
        state: string;
      } | undefined;
      if (
        lineage === undefined
        || input.currentImplementationTaskId !== lineage.currentTaskId
        || input.cycle !== lineage.cycle
        || input.verificationTaskId !==
          `${lineage.currentTaskId}:verify:${lineage.cycle}`
        || implementationDispatch?.task_id !== lineage.currentTaskId
        || implementationDispatch.state !== "worker_done"
      ) {
        throw new TypeError(`Run ${input.runId} verifier does not own the latest Fix lineage`);
      }
      const next = VerificationObligationStoreSchema.parse({
        rootImplementationTaskId: input.rootImplementationTaskId,
        currentImplementationTaskId: input.currentImplementationTaskId,
        implementationDispatchId: input.implementationDispatchId,
        cycle: input.cycle,
        status: "verifier_running",
        verificationTaskId: input.verificationTaskId
      });
      if (current.status === "passed" || current.status === "intervention_required") {
        throw new Error(`Run ${input.runId} verification obligation is terminal`);
      }
      if (
        current.currentImplementationTaskId !== lineage.currentTaskId
        || current.cycle !== lineage.cycle
      ) {
        throw new Error(`Run ${input.runId} verification obligation cannot change lineage`);
      }
      obligations[index] = next;
      const updated = JsonValueSchema.parse({ ...payload, verificationObligations: obligations });
      this.database.prepare(`
        UPDATE runs SET payload_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(updated), new Date().toISOString(), input.runId);
    }).immediate();
  }

  loadRunRecord(idInput: unknown): JsonValue | undefined {
    const id = z.string().min(1).parse(idInput);
    const row = this.database.prepare(`SELECT id, state, payload_json FROM runs WHERE id = ?`)
      .get(id) as { id: string; state: string; payload_json: string } | undefined;
    if (row === undefined) return undefined;
    return JsonValueSchema.parse({
      ...objectValue(parseJson(row.payload_json)),
      id: row.id,
      state: row.state
    });
  }

  loadTaskRecord(idInput: unknown): JsonValue | undefined {
    const id = z.string().min(1).parse(idInput);
    const row = this.database.prepare(`SELECT id, run_id, state, payload_json FROM tasks WHERE id = ?`)
      .get(id) as { id: string; run_id: string; state: string; payload_json: string } | undefined;
    if (row === undefined) return undefined;
    return JsonValueSchema.parse({
      ...objectValue(parseJson(row.payload_json)),
      id: row.id,
      runId: row.run_id,
      state: row.state
    });
  }

  loadDispatchesForTask(taskIdInput: unknown): JsonValue[] {
    const taskId = z.string().min(1).parse(taskIdInput);
    const rows = this.database.prepare(`
      SELECT id, task_id, state, payload_json
      FROM dispatches WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as Array<{
      id: string;
      task_id: string;
      state: string;
      payload_json: string;
    }>;
    return rows.map((row) => JsonValueSchema.parse({
      ...objectValue(parseJson(row.payload_json)),
      id: row.id,
      taskId: row.task_id,
      state: row.state
    }));
  }

  loadRunGraphForDispatch(dispatchIdInput: unknown): JsonValue | undefined {
    const dispatchId = z.string().min(1).parse(dispatchIdInput);
    const owners = this.database.prepare(`
      SELECT d.id, t.run_id
      FROM dispatches d
      JOIN tasks t ON t.id = d.task_id
      WHERE d.id = ? OR json_extract(d.payload_json, '$.orcaDispatchId') = ?
      ORDER BY CASE WHEN d.id = ? THEN 0 ELSE 1 END
      LIMIT 2
    `).all(dispatchId, dispatchId, dispatchId) as Array<{ id: string; run_id: string }>;
    if (owners.length === 0) return undefined;
    if (owners.length !== 1) {
      throw new Error(`Dispatch lookup ${dispatchId} is ambiguous`);
    }
    const owner = owners[0] as { id: string; run_id: string };
    const run = this.loadRunRecord(owner.run_id);
    if (run === undefined) throw new Error(`Run ${owner.run_id} is not persisted`);
    const taskRows = this.database.prepare(`
      SELECT id, run_id, state, payload_json
      FROM tasks
      WHERE run_id = ?
      ORDER BY created_at, id
    `).all(owner.run_id) as Array<{
      id: string;
      run_id: string;
      state: string;
      payload_json: string;
    }>;
    const tasks = taskRows.map((row) => JsonValueSchema.parse({
      ...objectValue(parseJson(row.payload_json)),
      id: row.id,
      runId: row.run_id,
      state: row.state
    }));
    const dispatchRows = this.database.prepare(`
      SELECT d.id, d.task_id, d.state, d.payload_json
      FROM dispatches d
      JOIN tasks t ON t.id = d.task_id
      WHERE t.run_id = ?
      ORDER BY d.created_at, d.id
    `).all(owner.run_id) as StoredDispatchRow[];
    const dispatches = dispatchRows.map((row) => JsonValueSchema.parse({
      ...objectValue(parseJson(row.payload_json)),
      id: row.id,
      taskId: row.task_id,
      state: row.state
    }));
    const activeLeaseDispatchIds = (this.database.prepare(`
      SELECT wl.dispatch_id
      FROM worktree_locks wl
      JOIN dispatches d ON d.id = wl.dispatch_id
      JOIN tasks t ON t.id = d.task_id
      WHERE t.run_id = ? AND wl.state = 'active'
      ORDER BY wl.created_at, wl.id
    `).all(owner.run_id) as Array<{ dispatch_id: string }>).map(({ dispatch_id }) => dispatch_id);
    return JsonValueSchema.parse({ run, tasks, dispatches, activeLeaseDispatchIds });
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
      const dispatchRow = this.database.prepare(`
        SELECT task_id, state, payload_json
        FROM dispatches
        WHERE id = ?
      `).get(input.dispatch.id) as Pick<
        StoredDispatchRow,
        "task_id" | "state" | "payload_json"
      > | undefined;
      if (dispatchRow === undefined || dispatchRow.task_id !== input.dispatch.taskId) {
        throw new WorkerCompletionConflictError(input.dispatch.id);
      }
      const dispatchPayload = objectValue(parseJson(dispatchRow.payload_json));
      const messageAuditReference = `worker-message:${input.message.messageId}`;
      const expectedCompletion = WorkerCompletionIdentityStoreSchema.parse({
        dispatchId: input.message.dispatchId,
        outcome: input.message.outcome,
        summary: input.message.summary
      });
      if (
        input.dispatch.workerCompletion.dispatchId !== expectedCompletion.dispatchId
        || input.dispatch.workerCompletion.outcome !== expectedCompletion.outcome
        || input.dispatch.workerCompletion.summary !== expectedCompletion.summary
        || input.dispatch.taskId !== input.task.id
        || input.task.state !== "worker_done"
        || input.dispatch.orcaDispatchId !== expectedCompletion.dispatchId
        || dispatchPayload?.orcaDispatchId !== expectedCompletion.dispatchId
      ) {
        throw new WorkerCompletionConflictError(input.dispatch.id);
      }
      if (dispatchRow.state === "worker_done") {
        const existingCompletion = WorkerCompletionIdentityStoreSchema.safeParse(
          dispatchPayload?.workerCompletion
        );
        const terminalTaskRow = this.database.prepare(`
          SELECT run_id, state, payload_json
          FROM tasks
          WHERE id = ?
        `).get(dispatchRow.task_id) as StoredTaskRow | undefined;
        const terminalTaskPayload = objectValue(
          terminalTaskRow === undefined ? undefined : parseJson(terminalTaskRow.payload_json)
        );
        const terminalTaskStateCoherent = terminalTaskRow?.state === "worker_done"
          || (
            terminalTaskPayload?.role === "verify"
            && ["verified_success", "verification_failed", "intervention_required"]
              .includes(terminalTaskRow?.state ?? "")
          );
        if (
          existingCompletion.success
          && isDeepStrictEqual(existingCompletion.data, expectedCompletion)
          && input.dispatch.workerCompletionAuditReference
            === dispatchPayload?.workerCompletionAuditReference
          && terminalTaskRow !== undefined
          && terminalTaskRow.run_id === input.task.runId
          && terminalTaskStateCoherent
          && terminalTaskPayload?.id === input.task.id
          && terminalTaskPayload.runId === input.task.runId
        ) return "duplicate" as const;
        throw new WorkerCompletionConflictError(input.dispatch.id);
      }
      if (dispatchRow.state !== "running") {
        throw new WorkerCompletionConflictError(input.dispatch.id);
      }
      if (input.dispatch.workerCompletionAuditReference !== messageAuditReference) {
        throw new WorkerCompletionConflictError(input.dispatch.id);
      }
      const messageId = messageAuditReference;
      const existing = this.database.prepare(`
        SELECT id FROM audit_events WHERE id = ?
      `).get(messageId) as { id: string } | undefined;
      if (existing !== undefined) throw new WorkerCompletionConflictError(input.dispatch.id);
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

  commitLaunchSuccess(inputValue: unknown): "inserted" | "duplicate" {
    const input = LaunchSuccessCommitStoreSchema.parse(JsonValueSchema.parse(inputValue));
    return this.database.transaction(() => {
      const dispatchRow = this.database.prepare(`
        SELECT task_id, state, payload_json FROM dispatches WHERE id = ?
      `).get(input.dispatch.id) as StoredDispatchRow | undefined;
      if (dispatchRow === undefined || dispatchRow.task_id !== input.dispatch.taskId) {
        throw new Error(`Dispatch ${input.dispatch.id} is not persisted for launch success`);
      }
      const taskRow = this.database.prepare(`
        SELECT run_id, state, payload_json FROM tasks WHERE id = ?
      `).get(input.task.id) as StoredTaskRow | undefined;
      if (
        taskRow === undefined
        || taskRow.run_id !== input.task.runId
        || input.dispatch.taskId !== input.task.id
      ) {
        throw new Error(`Task ${input.task.id} is not persisted for launch success`);
      }
      const runRow = this.database.prepare(`
        SELECT payload_json FROM runs WHERE id = ?
      `).get(taskRow.run_id) as { payload_json: string } | undefined;
      const runPayload = objectValue(
        runRow === undefined ? undefined : parseJson(runRow.payload_json)
      );
      const taskPayload = objectValue(parseJson(taskRow.payload_json));
      const dispatchPayload = objectValue(parseJson(dispatchRow.payload_json));
      const provider = z.enum(["codex", "claude"]).safeParse(input.dispatch.providerId);
      if (
        typeof taskPayload?.orcaTaskId !== "string"
        || typeof runPayload?.orcaRunId !== "string"
        || !provider.success
        || !hasBoundActiveProviderReceipts(
          input.dispatch,
          provider.data,
          input.dispatch.taskId,
          input.dispatch.id,
          taskPayload.orcaTaskId,
          runPayload.orcaRunId
        )
        || !isDeepStrictEqual(input.dispatch.providerStartReceipt, dispatchPayload?.providerStartReceipt)
        || !isDeepStrictEqual(
          input.dispatch.providerInspectReceipts,
          dispatchPayload?.providerInspectReceipts
        )
        || input.dispatch.orcaDispatchId !== dispatchPayload?.orcaDispatchId
      ) {
        throw new TypeError("launch success receipts are not durably bound");
      }
      if (dispatchRow.state === "running" && taskRow.state === "running") {
        return "duplicate" as const;
      }
      if (
        !["launching", "running"].includes(dispatchRow.state)
        || !["ready", "running"].includes(taskRow.state)
      ) {
        throw new Error(`Dispatch ${input.dispatch.id} changed during launch success`);
      }
      const expectedTransitions = [
        ...(dispatchRow.state === "running"
          ? []
          : [{ entity: "dispatch", entityId: input.dispatch.id, from: "launching", to: "running" }]),
        ...(taskRow.state === "running"
          ? []
          : [{ entity: "task", entityId: input.task.id, from: "ready", to: "running" }])
      ];
      if (!isDeepStrictEqual(
        input.transitions.map(({ entity, entityId, from, to }) => ({ entity, entityId, from, to })),
        expectedTransitions
      )) {
        throw new TypeError("launch success transitions do not match durable states");
      }
      if (dispatchRow.state === "launching") {
        const update = this.database.prepare(`
          UPDATE dispatches SET state = 'running', payload_json = ?, updated_at = ?
          WHERE id = ? AND task_id = ? AND state = 'launching'
        `).run(
          JSON.stringify(input.dispatch),
          new Date().toISOString(),
          input.dispatch.id,
          input.dispatch.taskId
        );
        if (update.changes !== 1) {
          throw new Error(`Dispatch ${input.dispatch.id} changed during launch success`);
        }
      }
      if (taskRow.state === "ready") {
        const mergedTask = JsonValueSchema.parse({ ...(taskPayload ?? {}), ...input.task });
        const update = this.database.prepare(`
          UPDATE tasks SET state = 'running', payload_json = ?, updated_at = ?
          WHERE id = ? AND run_id = ? AND state = 'ready'
        `).run(
          JSON.stringify(mergedTask),
          new Date().toISOString(),
          input.task.id,
          input.task.runId
        );
        if (update.changes !== 1) {
          throw new Error(`Task ${input.task.id} changed during launch success`);
        }
      }
      for (const transition of input.transitions) this.appendTransition(transition);
      return "inserted" as const;
    }).immediate();
  }

  commitLaunchIntervention(inputValue: unknown): "inserted" | "duplicate" {
    const input = LaunchInterventionCommitStoreSchema.parse(
      JsonValueSchema.parse(inputValue)
    );
    return this.database.transaction(() => {
      const dispatchRow = this.database.prepare(`
        SELECT task_id, state, payload_json FROM dispatches WHERE id = ?
      `).get(input.dispatch.id) as StoredDispatchRow | undefined;
      const taskRow = this.database.prepare(`
        SELECT run_id, state, payload_json FROM tasks WHERE id = ?
      `).get(input.task.id) as StoredTaskRow | undefined;
      const runRow = this.database.prepare(`
        SELECT state, payload_json FROM runs WHERE id = ?
      `).get(input.run.id) as { state: string; payload_json: string } | undefined;
      if (
        dispatchRow === undefined
        || taskRow === undefined
        || runRow === undefined
        || dispatchRow.task_id !== input.task.id
        || taskRow.run_id !== input.run.id
      ) {
        throw new Error(`Dispatch ${input.dispatch.id} has no durable launch graph`);
      }
      const dispatchPayload = objectValue(parseJson(dispatchRow.payload_json));
      const taskPayload = objectValue(parseJson(taskRow.payload_json));
      const runPayload = objectValue(parseJson(runRow.payload_json));
      const terminalStates = (
        dispatchRow.state === "intervention_required"
        && taskRow.state === "intervention_required"
        && runRow.state === "intervention_required"
      );
      const activeGraph = (
        ["launching", "running", "launch_failure_reserved", "launch_failed"].includes(
          dispatchRow.state
        )
        && ["ready", "running"].includes(taskRow.state)
        && runRow.state === "active"
      );
      const partialInterventionGraph = (
        dispatchRow.state === "intervention_required"
        && ["ready", "running", "intervention_required"].includes(taskRow.state)
        && ["active", "intervention_required"].includes(runRow.state)
      );
      if (!activeGraph && !partialInterventionGraph) {
        throw new Error(`Dispatch ${input.dispatch.id} changed during launch intervention`);
      }
      const hasFenceReceipt = input.dispatch.fenceReceipt !== undefined;
      const hasFenceFailure = input.dispatch.fenceFailure !== undefined;
      if (hasFenceReceipt === hasFenceFailure) {
        throw new TypeError("launch intervention requires exactly one fence outcome");
      }
      if (
        dispatchPayload?.fenceReceipt !== undefined
        && !isDeepStrictEqual(dispatchPayload.fenceReceipt, input.dispatch.fenceReceipt)
      ) {
        throw new TypeError("launch intervention cannot replace durable fence proof");
      }
      if (
        dispatchPayload?.fenceFailure !== undefined
        && !isDeepStrictEqual(dispatchPayload.fenceFailure, input.dispatch.fenceFailure)
      ) {
        throw new TypeError("launch intervention cannot replace durable fence failure");
      }
      if (input.dispatch.fenceReceipt !== undefined) {
        if (!input.dispatch.fenceReceipt.ok) {
          throw new TypeError("launch intervention stop proof is not successful");
        }
        const receipt = parseOrcaOperationReceipt("stop_worker", input.dispatch.fenceReceipt);
        const result = objectValue(receipt.result);
        if (
          result === undefined
          || result.dispatchId !== input.dispatch.orcaDispatchId
          || result.state !== "stopped"
          || result.verdict !== "stopped"
        ) {
          throw new TypeError("launch intervention stop proof is not exact");
        }
      }
      const {
        fenceReceipt: _durableFenceReceipt,
        fenceFailure: _durableFenceFailure,
        ...dispatchIdentity
      } = dispatchPayload ?? {};
      const expectedDispatch = JsonValueSchema.parse({
        ...dispatchIdentity,
        id: input.dispatch.id,
        taskId: dispatchRow.task_id,
        state: "intervention_required",
        ...(input.dispatch.fenceReceipt === undefined
          ? { fenceFailure: input.dispatch.fenceFailure }
          : { fenceReceipt: input.dispatch.fenceReceipt })
      });
      const expectedTask = JsonValueSchema.parse({
        ...(taskPayload ?? {}),
        id: input.task.id,
        runId: taskRow.run_id,
        state: "intervention_required"
      });
      const expectedRun = JsonValueSchema.parse({
        ...(runPayload ?? {}),
        id: input.run.id,
        state: "intervention_required"
      });
      if (
        !isDeepStrictEqual(input.dispatch, expectedDispatch)
        || !isDeepStrictEqual(input.task, expectedTask)
        || !isDeepStrictEqual(input.run, expectedRun)
      ) {
        throw new TypeError("launch intervention payloads do not match durable identity");
      }
      const expectedTransitions = [
        ...(dispatchRow.state === "intervention_required"
          ? []
          : [{
              entity: "dispatch",
              entityId: input.dispatch.id,
              from: dispatchRow.state,
              to: "intervention_required",
              ...(input.dispatch.fenceReceipt === undefined
                ? {}
                : { receiptId: input.dispatch.fenceReceipt.id })
            }]),
        ...(taskRow.state === "intervention_required"
          ? []
          : [{
              entity: "task",
              entityId: input.task.id,
              from: taskRow.state,
              to: "intervention_required"
            }]),
        ...(runRow.state === "intervention_required"
          ? []
          : [{
              entity: "run",
              entityId: input.run.id,
              from: runRow.state,
              to: "intervention_required"
            }])
      ];
      const transitionIdentities = input.transitions.map((transition) => ({
        entity: transition.entity,
        entityId: transition.entityId,
        from: transition.from,
        to: transition.to,
        ...(transition.receiptId === undefined ? {} : { receiptId: transition.receiptId })
      }));
      if (!isDeepStrictEqual(transitionIdentities, expectedTransitions)) {
        throw new TypeError("launch intervention transitions do not match durable states");
      }
      const terminalGraph = terminalStates && (
        (
          dispatchPayload?.fenceReceipt !== undefined
          && dispatchPayload.fenceFailure === undefined
          && isDeepStrictEqual(dispatchPayload.fenceReceipt, input.dispatch.fenceReceipt)
        )
        || (
          dispatchPayload?.fenceFailure !== undefined
          && dispatchPayload.fenceReceipt === undefined
          && isDeepStrictEqual(dispatchPayload.fenceFailure, input.dispatch.fenceFailure)
        )
      );
      if (terminalGraph) return "duplicate" as const;
      const updateDispatch = this.database.prepare(`
        UPDATE dispatches
        SET state = 'intervention_required', payload_json = ?, updated_at = ?
        WHERE id = ? AND state = ?
      `).run(
        JSON.stringify(input.dispatch),
        new Date().toISOString(),
        input.dispatch.id,
        dispatchRow.state
      );
      const updateTask = taskRow.state === "intervention_required"
        ? undefined
        : this.database.prepare(`
          UPDATE tasks SET state = 'intervention_required', payload_json = ?, updated_at = ?
          WHERE id = ? AND state = ?
        `).run(
          JSON.stringify(JsonValueSchema.parse({ ...(taskPayload ?? {}), ...input.task })),
          new Date().toISOString(),
          input.task.id,
          taskRow.state
        );
      const updateRun = runRow.state === "intervention_required"
        ? undefined
        : this.database.prepare(`
          UPDATE runs SET state = 'intervention_required', payload_json = ?, updated_at = ?
          WHERE id = ? AND state = ?
        `).run(
          JSON.stringify(JsonValueSchema.parse({ ...(runPayload ?? {}), ...input.run })),
          new Date().toISOString(),
          input.run.id,
          runRow.state
        );
      if (
        updateDispatch.changes !== 1
        || updateTask?.changes === 0
        || updateRun?.changes === 0
      ) {
        throw new Error(`Dispatch ${input.dispatch.id} changed during launch intervention`);
      }
      for (const transition of input.transitions) this.appendTransition(transition);
      return "inserted" as const;
    }).immediate();
  }

  reserveLaunchFailure(inputValue: unknown): "inserted" | "duplicate" {
    const input = LaunchFailureReservationCommitStoreSchema.parse(
      JsonValueSchema.parse(inputValue)
    );
    return this.database.transaction(() => {
      const dispatchRow = this.database.prepare(`
        SELECT task_id, state, payload_json
        FROM dispatches
        WHERE id = ?
      `).get(input.dispatch.id) as StoredDispatchRow | undefined;
      if (dispatchRow === undefined || dispatchRow.task_id !== input.dispatch.taskId) {
        throw new Error(`Dispatch ${input.dispatch.id} is not persisted for launch failure`);
      }
      const existingPayload = objectValue(parseJson(dispatchRow.payload_json));
      if (dispatchRow.state === "launch_failure_reserved") {
        if (
          existingPayload?.launchFailureId === input.message.messageId
          && existingPayload.orcaDispatchId === input.message.dispatchId
        ) return "duplicate" as const;
        throw new Error(`Dispatch ${input.dispatch.id} has conflicting launch failure`);
      }
      if (dispatchRow.state !== "running") {
        throw new Error(`Dispatch ${input.dispatch.id} changed during launch failure reservation`);
      }
      const taskRow = this.database.prepare(`
        SELECT run_id, payload_json FROM tasks WHERE id = ?
      `).get(input.dispatch.taskId) as Pick<StoredTaskRow, "run_id" | "payload_json"> | undefined;
      const taskPayload = objectValue(
        taskRow === undefined ? undefined : parseJson(taskRow.payload_json)
      );
      const runRow = taskRow === undefined ? undefined : this.database.prepare(`
        SELECT payload_json FROM runs WHERE id = ?
      `).get(taskRow.run_id) as { payload_json: string } | undefined;
      const runPayload = objectValue(
        runRow === undefined ? undefined : parseJson(runRow.payload_json)
      );
      const provider = z.enum(["codex", "claude"]).safeParse(input.dispatch.providerId);
      if (
        input.dispatch.launchFailureId !== input.message.messageId
        || input.dispatch.orcaDispatchId !== input.message.dispatchId
        || taskRow === undefined
        || typeof taskPayload?.orcaTaskId !== "string"
        || typeof runPayload?.orcaRunId !== "string"
        || !provider.success
        || !hasBoundActiveProviderReceipts(
          input.dispatch,
          provider.data,
          input.dispatch.taskId,
          input.dispatch.id,
          taskPayload.orcaTaskId,
          runPayload.orcaRunId,
          "launch_failure_identity"
        )
      ) {
        throw new TypeError("launch failure reservation is not durably bound");
      }
      const update = this.database.prepare(`
        UPDATE dispatches
        SET state = 'launch_failure_reserved', payload_json = ?, updated_at = ?
        WHERE id = ? AND task_id = ? AND state = 'running'
      `).run(
        JSON.stringify(input.dispatch),
        new Date().toISOString(),
        input.dispatch.id,
        input.dispatch.taskId
      );
      if (update.changes !== 1) {
        throw new Error(`Dispatch ${input.dispatch.id} changed during launch failure reservation`);
      }
      this.appendTransition(input.transition);
      return "inserted" as const;
    }).immediate();
  }

  commitLaunchFailure(inputValue: unknown): "inserted" | "duplicate" {
    const input = LaunchFailureCommitStoreSchema.parse(JsonValueSchema.parse(inputValue));
    return this.database.transaction(() => {
      const dispatchRow = this.database.prepare(`
        SELECT task_id, state, payload_json
        FROM dispatches
        WHERE id = ?
      `).get(input.dispatch.id) as StoredDispatchRow | undefined;
      if (dispatchRow === undefined || dispatchRow.task_id !== input.dispatch.taskId) {
        throw new Error(`Dispatch ${input.dispatch.id} is not persisted for launch failure`);
      }
      const existingPayload = objectValue(parseJson(dispatchRow.payload_json));
      if (dispatchRow.state === "launch_failed") {
        if (
          existingPayload?.launchFailureId === input.message.messageId
          && isDeepStrictEqual(existingPayload.fenceReceipt, input.dispatch.fenceReceipt)
        ) return "duplicate" as const;
        throw new Error(`Dispatch ${input.dispatch.id} has conflicting launch failure`);
      }
      if (dispatchRow.state !== "launch_failure_reserved") {
        throw new Error(`Dispatch ${input.dispatch.id} changed during launch failure`);
      }
      const taskRow = this.database.prepare(`
        SELECT run_id, payload_json
        FROM tasks
        WHERE id = ?
      `).get(input.dispatch.taskId) as Pick<StoredTaskRow, "run_id" | "payload_json"> | undefined;
      const taskPayload = objectValue(taskRow === undefined ? undefined : parseJson(taskRow.payload_json));
      const taskGitDiff = objectValue(taskPayload?.gitDiff);
      const runRow = taskRow === undefined ? undefined : this.database.prepare(`
        SELECT payload_json FROM runs WHERE id = ?
      `).get(taskRow.run_id) as { payload_json: string } | undefined;
      const runPayload = objectValue(runRow === undefined ? undefined : parseJson(runRow.payload_json));
      const provider = z.enum(["codex", "claude"]).safeParse(input.dispatch.providerId);
      if (
        input.dispatch.launchFailureId !== input.message.messageId
        || input.dispatch.orcaDispatchId !== input.message.dispatchId
        || taskRow === undefined
        || typeof taskPayload?.orcaTaskId !== "string"
        || typeof runPayload?.orcaRunId !== "string"
        || !provider.success
        || !hasBoundProviderReceipts(
          input.dispatch,
          provider.data,
          input.dispatch.taskId,
          input.dispatch.id,
          taskPayload.orcaTaskId,
          runPayload.orcaRunId,
          {
            inspectionMode: "launch_failure_identity",
            verifierSnapshotMode: "launch_failure",
            expectedVerifierDiffSha256: typeof taskGitDiff?.sha256 === "string"
              ? taskGitDiff.sha256
              : undefined
          }
        )
      ) {
        throw new TypeError("launch failure terminal proof is not durably bound");
      }
      const update = this.database.prepare(`
        UPDATE dispatches
        SET state = 'launch_failed', payload_json = ?, updated_at = ?
        WHERE id = ? AND task_id = ? AND state = 'launch_failure_reserved'
      `).run(
        JSON.stringify(input.dispatch),
        new Date().toISOString(),
        input.dispatch.id,
        input.dispatch.taskId
      );
      if (update.changes !== 1) {
        throw new Error(`Dispatch ${input.dispatch.id} changed during launch failure`);
      }
      this.database.prepare(`
        INSERT INTO audit_events (id, subject_id, event_type, data_json, created_at)
        VALUES (?, ?, 'worker.launch_failure', ?, ?)
      `).run(
        `worker-message:${input.message.messageId}`,
        input.message.dispatchId,
        JSON.stringify(input.message),
        new Date().toISOString()
      );
      this.appendTransition(input.transition);
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

  loadVerificationTask(taskIdInput: unknown): JsonValue | undefined {
    const taskId = z.string().min(1).parse(taskIdInput);
    const row = this.database.prepare(`
      SELECT payload_json FROM tasks WHERE id = ?
    `).get(taskId) as { payload_json: string } | undefined;
    if (row === undefined) return undefined;
    const payload = JsonValueSchema.parse(parseJson(row.payload_json));
    const task = StoredGeneratedTaskSchema.parse(payload);
    if (task.taskId !== taskId || task.role !== "verify") {
      throw new TypeError(`Task ${taskId} is not a durable verification Task`);
    }
    const value = objectValue(payload);
    if (value === undefined) throw new TypeError(`Task ${taskId} payload is invalid`);
    const keys = [
      "runId",
      "implementationTaskId",
      "implementationDispatchId",
      "implementationProvider",
      "cycle",
      "projectRoute",
      "requestedScope",
      "changedFiles",
      "gitDiff",
      "testReceipts",
      "prohibitedEffects",
      "workerResult",
      "auditReferences",
      "taskId",
      "title",
      "role",
      "preferredAgent",
      "dependsOn",
      "permissions",
      "nestedWorkers",
      "implementationProhibitedEffects",
      "allowedActions"
    ] as const;
    return JsonValueSchema.parse(Object.fromEntries(keys.map((key) => [key, value[key]])));
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
        SELECT id, state, payload_json
        FROM runs
        WHERE id = ?
      `).get(report.runId) as (TaskRow & { payload_json: string }) | undefined;
      if (runRow === undefined || runRow.state !== "awaiting_verification") {
        throw new Error(`Run ${report.runId} is not awaiting_verification`);
      }
      const runPayload = objectValue(parseJson(runRow.payload_json));
      const orcaRunId = runPayload?.orcaRunId;
      if (typeof orcaRunId !== "string" || orcaRunId.length === 0) {
        throw new TypeError(`Run ${report.runId} has no durable Orca Run identity`);
      }
      const verificationObligations = z.array(VerificationObligationStoreSchema).min(1)
        .parse(runPayload?.verificationObligations);
      assertObligationsOwnLatestLineages(
        this.database,
        report.runId,
        verificationObligations
      );
      const obligationIndex = verificationObligations.findIndex((obligation) =>
        obligation.verificationTaskId === report.verificationTaskId
      );
      const obligation = verificationObligations[obligationIndex];
      if (
        obligation === undefined
        || obligation.currentImplementationTaskId !== report.implementationTaskId
        || obligation.implementationDispatchId !== report.implementationDispatchId
        || obligation.cycle !== report.cycle
        || obligation.status !== "verifier_running"
      ) {
        throw new TypeError("verification report does not own a durable Run obligation");
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
        || typeof implementationTaskPayload.orcaTaskId !== "string"
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
          report.implementationDispatchId,
          implementationTaskPayload.orcaTaskId,
          orcaRunId
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
        || typeof taskPayload.orcaTaskId !== "string"
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
          verifierDispatch.id,
          taskPayload.orcaTaskId,
          orcaRunId,
          {
            verifierSnapshotMode: "completion",
            expectedVerifierDiffSha256: report.diffSha256
          }
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

      verificationObligations[obligationIndex] = VerificationObligationStoreSchema.parse(
        passing
          ? { ...obligation, status: "passed" }
          : intervening
            ? { ...obligation, status: "intervention_required" }
            : {
                rootImplementationTaskId: obligation.rootImplementationTaskId,
                currentImplementationTaskId: fixTask?.taskId,
                implementationDispatchId: `dispatch:${fixTask?.taskId}:1`,
                cycle: fixTask?.cycle,
                status: "fix_required"
              }
      );

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
      const everyOriginalImplementationPassed = verificationObligations.every(
        ({ status }) => status === "passed"
      );
      const finalPassingReport = passing
        && outstanding.count === 0
        && everyOriginalImplementationPassed;
      const runState = finalPassingReport
        ? "verified_success"
        : intervening
          ? "intervention_required"
          : fixing
            ? "active"
            : "awaiting_verification";
      const updatedRunPayload = JsonValueSchema.parse({
        ...runPayload,
        verificationObligations
      });
      const runUpdate = this.database.prepare(`
        UPDATE runs SET state = ?, payload_json = ?, updated_at = ?
        WHERE id = ? AND state = 'awaiting_verification'
      `).run(runState, JSON.stringify(updatedRunPayload), now, report.runId);
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

  persistApprovalRequest(requestInput: PersistedApprovalRequest): void {
    const request = PersistedApprovalRequestSchema.parse(requestInput);
    this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT state, payload_json FROM approvals WHERE id = ?
      `).get(request.approvalId) as Pick<ApprovalRow, "state" | "payload_json"> | undefined;
      if (existing !== undefined) {
        const persisted = PersistedApprovalSchema.parse({
          ...(parseJson(existing.payload_json) as Record<string, unknown>),
          state: existing.state
        });
        if (!isDeepStrictEqual(persisted.request, request)) {
          throw new Error(`Approval ${request.approvalId} has conflicting request content`);
        }
        return;
      }
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO approvals (
          id, execution_proposal_id, state, payload_json, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?, ?)
      `).run(
        request.approvalId,
        request.proposal.proposalId,
        JSON.stringify({ request }),
        now,
        now
      );
      this.appendAudit({
        subjectId: request.approvalId,
        eventType: "approval.requested",
        data: {}
      });
    }).immediate();
  }

  confirmApproval(approvalInput: ApprovalConfirmation): ApprovalRecord {
    const approval = ApprovalConfirmationSchema.parse(approvalInput);
    const record = ApprovalRecordSchema.parse({
      approvalId: approval.approvalId,
      proposalDigest: approval.proposalDigest,
      operationDigest: approval.operationDigest,
      principalId: approval.principalId,
      channel: approval.channel,
      approvedAt: approval.approvedAt,
      expiresAt: approval.expiresAt,
      ...(approval.typedPhraseDigest === undefined
        ? {}
        : { typedPhraseDigest: approval.typedPhraseDigest })
    });
    return this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT execution_proposal_id, state, payload_json
        FROM approvals WHERE id = ?
      `).get(record.approvalId) as ApprovalRow | undefined;
      if (existing !== undefined) {
        const persisted = PersistedApprovalSchema.parse({
          ...(parseJson(existing.payload_json) as Record<string, unknown>),
          state: existing.state
        });
        if (
          persisted.state !== "pending"
          ||
          existing.execution_proposal_id !== approval.executionProposalId
          || persisted.request.proposalDigest !== record.proposalDigest
          || persisted.request.digest !== record.operationDigest
          || persisted.request.channel !== record.channel
          || persisted.request.typedPhraseDigest !== record.typedPhraseDigest
        ) {
          throw new Error(`Approval ${record.approvalId} has conflicting confirmation content`);
        }
        const now = new Date().toISOString();
        this.database.prepare(`
          UPDATE approvals SET state = 'approved', payload_json = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify({ request: persisted.request, approval: record }), now, record.approvalId);
        this.appendAudit({
          subjectId: record.approvalId,
          eventType: "approval.confirmed",
          data: {}
        });
        return record;
      }
      throw new Error(`Approval ${record.approvalId} has no pending request`);
    }).immediate();
  }

  findApproval(approvalIdInput: string): PersistedApproval | undefined {
    const approvalId = z.string().min(1).parse(approvalIdInput);
    const row = this.database.prepare(`
      SELECT state, payload_json FROM approvals WHERE id = ?
    `).get(approvalId) as Pick<ApprovalRow, "state" | "payload_json"> | undefined;
    if (row === undefined) return undefined;
    return PersistedApprovalSchema.parse({
      ...(parseJson(row.payload_json) as Record<string, unknown>),
      state: row.state
    });
  }

  consumeApproval(approvalIdInput: string): boolean {
    const approvalId = z.string().min(1).parse(approvalIdInput);
    return this.database.transaction(() => {
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        UPDATE approvals SET state = 'consumed', updated_at = ?
        WHERE id = ? AND state = 'approved'
      `).run(now, approvalId);
      if (result.changes === 0) return false;
      this.appendAudit({
        subjectId: approvalId,
        eventType: "approval.consumed",
        data: {}
      });
      return true;
    }).immediate();
  }

  invalidateApproval(
    approvalIdInput: string,
    reasonInput: "digest_changed" | "manual"
  ): boolean {
    const approvalId = z.string().min(1).parse(approvalIdInput);
    const reason = z.enum(["digest_changed", "manual"]).parse(reasonInput);
    return this.database.transaction(() => {
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        UPDATE approvals SET state = 'invalidated', updated_at = ?
        WHERE id = ? AND state IN ('pending', 'approved')
      `).run(now, approvalId);
      if (result.changes === 0) return false;
      this.appendAudit({
        subjectId: approvalId,
        eventType: "approval.invalidated",
        data: { reason }
      });
      return true;
    }).immediate();
  }

  expireApproval(approvalIdInput: string): boolean {
    const approvalId = z.string().min(1).parse(approvalIdInput);
    return this.database.transaction(() => {
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        UPDATE approvals SET state = 'expired', updated_at = ?
        WHERE id = ? AND state = 'approved'
      `).run(now, approvalId);
      if (result.changes === 0) return false;
      this.appendAudit({
        subjectId: approvalId,
        eventType: "approval.expired",
        data: {}
      });
      return true;
    }).immediate();
  }

  recordApprovalAudit(
    approvalIdInput: string,
    eventTypeInput: "approval.denied" | "approval.tamper_rejected" | "approval.invalidation_rejected",
    reasonInput: string
  ): void {
    const approvalId = z.string().min(1).parse(approvalIdInput);
    const eventType = z.enum([
      "approval.denied",
      "approval.tamper_rejected",
      "approval.invalidation_rejected"
    ]).parse(eventTypeInput);
    const reason = z.string().min(1).max(128).regex(/^[a-z_]+$/).parse(reasonInput);
    this.appendAudit({ subjectId: approvalId, eventType, data: { reason } });
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
