import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  ContextSnapshotSchema,
  ProgressEventInputSchema,
  ProgressEventSchema,
  ProgressRequestSnapshotSchema,
  ProgressRequestStateSchema,
  SubmitProgressRequestSchema,
  type ContextSnapshot,
  type ProgressEvent,
  type ProgressRequestSnapshot,
  type ProgressRequestState,
  type SubmitProgressRequest
} from "@orca-hq/core";
import { openDatabase } from "@orca-hq/persistence";
import { createSqliteWorkerAdmission, migrateWorkerAdmission, nativeExecutionReservations, type WorkerAdmission, type WorkerAdmissionOptions } from "./worker-admission.js";
import { resourcesOverlap } from "./execution-reservations.js";

import type {
  ProgressEventKind,
  ProgressEventSource
} from "@orca-hq/core";

/**
 * Storage boundary used by the progress control plane and context runtime.
 * The concrete implementation binds one trusted owner at construction time;
 * callers never pass an HTTP-supplied owner key to individual operations.
 */
export interface ProgressStore {
  createWorkerAdmission(options: WorkerAdmissionOptions): WorkerAdmission;
  acceptRequest(input: SubmitProgressRequest): ProgressRequestAcceptance;
  claimNextRequest(claimantId: string): ClaimedProgressRequest | undefined;
  getRequest(requestId: string): ProgressRequestSnapshot | undefined;
  getRequestInput(requestId: string): SubmitProgressRequest | undefined;
  recoverInterruptedRequests(options?: RecoverInterruptedRequestsOptions): ProgressRequestSnapshot[];
  updateRequest(update: ProgressRequestUpdate): ProgressRequestSnapshot;
  completeRequest(input: CompleteProgressRequest): ProgressRequestSnapshot;

  createContext(input: CreateWorkContext): ContextSnapshot;
  updateContext(input: UpdateWorkContext): ContextSnapshot;
  assignRequestContext(input: AssignRequestContext): void;
  completeAssignment(input: CompleteRequestAssignment): void;
  setContextAgent(input: SetContextAgent): void;
  getContextAgent(contextId: string): ContextAgentRecord | undefined;
  listRequestAssignments(requestId: string): RequestContextAssignment[];
  listRequestContexts(requestId: string): RequestContextAssignment[];
  linkContextJob(input: LinkContextJob): void;
  rebindContextJob(input: LinkContextJob & { dispatchId: string }): void;
  listContextJobs(contextId?: string): ContextJobRecord[];
  listContexts(sessionId?: string): ContextSnapshot[];
  getContext(contextId: string): ContextSnapshot | undefined;

  appendEvent(input: AppendProgressEvent): ProgressEvent;
  readEvents(query: ProgressEventQuery): ProgressEventPage;

  acquireViewerLease(input: AcquireViewerLease): ViewerLeaseResult;
  heartbeatViewerLease(input: MutateViewerLease): ViewerLeaseMutation;
  releaseViewerLease(input: MutateViewerLease): ViewerLeaseMutation;

  tryReserveExecution(input: ReserveContextExecution): ExecutionReservationResult;
  linkReservationDispatch(input: LinkReservationDispatch): ExecutionReservation;
  heartbeatExecutionReservation(input: HeartbeatExecutionReservation): ExecutionReservation;
  markReservationRecoveryRequired(input: MutateExecutionReservation): ExecutionReservation[];
  releaseExecutionReservation(input: MutateExecutionReservation): ExecutionReservation[];
  assertExecutionGeneration(contextId: string, generation: number): void;
  listExecutionReservations(contextId?: string): ExecutionReservation[];

  /** Deletes at most 1,000 old detail events; receipts, results and held executions remain. */
  pruneCompletedEvents(before: string): number;
  close(): void;
}

export type ProgressRequestAcceptance = Readonly<{
  accepted: boolean;
  request: ProgressRequestSnapshot;
  event: ProgressEvent;
}>;

export type RecoverInterruptedRequestsOptions = Readonly<{
  /** Requeue classification/capacity waits only when runtime guarantees no effect started. */
  requeueClassifying?: boolean;
}>;

export type ClaimedProgressRequest = Readonly<{
  request: ProgressRequestSnapshot;
  input: SubmitProgressRequest;
  claimantId: string;
  claimedAt: string;
}>;

export type ProgressRequestUpdate = Readonly<{
  requestId: string;
  state: ProgressRequestState;
  result?: { text: string; jobId?: string };
}>;

export type CompleteProgressRequest = Readonly<{
  requestId: string;
  eventKey: string;
  state: "completed" | "failed" | "recovery_required";
  text: string;
  jobId?: string;
  occurredAt?: string;
}>;

export type CreateWorkContext = Readonly<{
  contextId: string;
  originSessionId: string;
  title: string;
  objective: string;
  summary?: string;
  threadId?: string;
  projectIds?: readonly string[];
}>;

export type UpdateWorkContext = Readonly<{
  contextId: string;
  title?: string;
  objective?: string;
  summary?: string;
  threadId?: string | null;
  state?: string;
}>;

export type AssignRequestContext = Readonly<{
  requestId: string;
  partId: string;
  contextId: string;
  relation: "new" | "continue";
  instruction: string;
  sourceContextId?: string;
}>;

export type SetContextAgent = Readonly<{
  contextId: string;
  agentId: string;
  state: string;
  generation: number;
  currentRequestId?: string;
  heartbeatAt?: string;
  lastObservedAt?: string;
}>;

export type LinkContextJob = Readonly<{
  contextId: string;
  jobId: string;
  requestId: string;
  dispatchId?: string;
}>;

export type ContextAgentRecord = Readonly<{
  contextId: string;
  agentId: string;
  currentRequestId?: string;
  state: string;
  generation: number;
  heartbeatAt?: string;
  lastObservedAt?: string;
}>;

export type RequestContextAssignment = Readonly<{
  requestId: string;
  partId: string;
  contextId: string;
  relation: "new" | "continue";
  sourceContextId?: string;
  instruction: string;
  outcome?: AssignmentOutcome;
}>;

export type AssignmentOutcome = Readonly<{
  state: "completed" | "failed" | "recovery_required";
  text: string;
  jobId?: string;
  jobIds?: readonly string[];
}>;

export type CompleteRequestAssignment = Readonly<{
  requestId: string;
  partId: string;
  eventKey: string;
  outcome: AssignmentOutcome;
}>;

export type ContextJobRecord = Readonly<{
  contextId: string;
  jobId: string;
  requestId: string;
  dispatchId?: string;
}>;

export type AppendProgressEvent = Omit<ProgressEvent, "seq" | "occurredAt"> & Readonly<{
  occurredAt?: string;
}>;

export type ProgressEventQuery = Readonly<{
  after: number;
  limit?: number;
  sessionId?: string;
  contextId?: string;
}>;

export type ProgressEventPage = Readonly<{
  events: ProgressEvent[];
  oldestSeq: number;
  latestSeq: number;
  compacted: boolean;
  snapshots: ContextSnapshot[];
}>;

export type AcquireViewerLease = Readonly<{
  contextId: string;
  viewerInstanceId: string;
}>;

export type MutateViewerLease = AcquireViewerLease & Readonly<{ leaseToken: string }>;

export type ViewerLeaseResult = Readonly<{
  acquired: boolean;
  viewerInstanceId: string;
  leaseToken?: string;
  expiresAt: string;
}>;

export type ViewerLeaseMutation = Readonly<{ ok: true }>;

export type ResourceAccessMode = "read" | "write";
export type NormalizedResourceAccess = Readonly<{
  resourceKey: string;
  mode: ResourceAccessMode;
}>;

export type ReserveContextExecution = Readonly<{
  reservationId: string;
  contextId: string;
  requestId: string;
  agentId: string;
  generation: number;
  resources: readonly NormalizedResourceAccess[];
}>;

export type ExecutionReservationState = "acquired" | "recovery_required" | "released";
export type ExecutionReservation = Readonly<{
  reservationId: string;
  contextId: string;
  requestId: string;
  agentId: string;
  generation: number;
  resourceKey: string;
  mode: ResourceAccessMode;
  state: ExecutionReservationState;
  acquiredAt: string;
  heartbeatAt: string;
  releasedAt: string | null;
  nativeDispatchId: string | null;
}>;

export type ReservationConflict = Readonly<{
  resourceKey: string;
  requestedMode: ResourceAccessMode;
  heldBy: ExecutionReservation;
}>;

export type ExecutionReservationResult =
  | Readonly<{ acquired: true; reservations: ExecutionReservation[] }>
  | Readonly<{ acquired: false; conflicts: ReservationConflict[] }>;

export type LinkReservationDispatch = Readonly<{
  reservationId: string;
  contextId: string;
  requestId: string;
  generation: number;
  nativeDispatchId: string;
}>;

export type HeartbeatExecutionReservation = Readonly<{
  reservationId: string;
  contextId: string;
  generation: number;
}>;

export type MutateExecutionReservation = HeartbeatExecutionReservation & Readonly<{
  requestId: string;
  nativeCompletion?: NativeCompletionEvidence;
}>;

export type NativeCompletionEvidence = Readonly<{
  dispatchId: string;
  state: "succeeded" | "failed" | "stopped";
}>;

export type ProgressStoreOptions = Readonly<{
  databasePath: string;
  ownerKey: string;
  now?: () => Date;
  tokenFactory?: () => string;
  viewerLeaseTtlMs?: number;
}>;

type Database = ReturnType<typeof openDatabase>;

interface RequestRow {
  request_id: string;
  owner_key: string;
  session_id: string;
  text: string;
  context_hint_json: string | null;
  state: ProgressRequestState;
  created_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  result_text: string | null;
  result_job_id: string | null;
  events_compacted_through: number;
}

interface EventRow {
  seq: number;
  event_key: string;
  request_id: string;
  context_id: string | null;
  kind: ProgressEventKind;
  source: ProgressEventSource;
  occurred_at: string;
  payload_json: string;
  agent_id: string | null;
  generation: number | null;
}

interface ReservationRow {
  reservation_id: string;
  context_id: string;
  request_id: string;
  agent_id: string;
  generation: number;
  resource_key: string;
  mode: ResourceAccessMode;
  state: ExecutionReservationState;
  acquired_at: string;
  heartbeat_at: string;
  released_at: string | null;
  native_dispatch_id: string | null;
}

export class ProgressStoreError extends Error {}

export class ProgressRequestCollisionError extends ProgressStoreError {
  constructor(requestId: string) {
    super(`Progress request ${requestId} has different content`);
    this.name = "ProgressRequestCollisionError";
  }
}

export class ProgressEventCollisionError extends ProgressStoreError {
  constructor(eventKey: string) {
    super(`Progress event ${eventKey} has different content`);
    this.name = "ProgressEventCollisionError";
  }
}

export class ProgressEventContextMismatchError extends ProgressStoreError {
  constructor(requestId: string, contextId: string) {
    super(`Progress request ${requestId} is not assigned to context ${contextId}`);
    this.name = "ProgressEventContextMismatchError";
  }
}

export class ProgressRecordNotFoundError extends ProgressStoreError {
  constructor(kind: string, id: string) {
    super(`${kind} ${id} was not found`);
    this.name = "ProgressRecordNotFoundError";
  }
}

export class ProgressRecordCollisionError extends ProgressStoreError {
  constructor(kind: string, id: string) {
    super(`${kind} ${id} has different content`);
    this.name = "ProgressRecordCollisionError";
  }
}

export class ViewerLeaseConflictError extends ProgressStoreError {
  constructor(contextId: string) {
    super(`Viewer lease for ${contextId} is not owned by this token`);
    this.name = "ViewerLeaseConflictError";
  }
}

export class ExecutionGenerationConflictError extends ProgressStoreError {
  constructor(contextId: string, generation: number) {
    super(`Context ${contextId} does not own execution generation ${generation}`);
    this.name = "ExecutionGenerationConflictError";
  }
}

export class ExecutionOwnershipConflictError extends ProgressStoreError {
  constructor(contextId: string, requestId: string) {
    super(`Context ${contextId} does not own request ${requestId} for execution`);
    this.name = "ExecutionOwnershipConflictError";
  }
}

export class ExecutionReservationCollisionError extends ProgressStoreError {
  constructor(reservationId: string) {
    super(`Execution reservation ${reservationId} has different content`);
    this.name = "ExecutionReservationCollisionError";
  }
}

export class ExecutionReservationReleasedError extends ProgressStoreError {
  constructor(reservationId: string) {
    super(`Execution reservation ${reservationId} was already released`);
    this.name = "ExecutionReservationReleasedError";
  }
}

export class NativeReservationEvidenceError extends ProgressStoreError {
  constructor(reservationId: string) {
    super(`Execution reservation ${reservationId} requires matching terminal native evidence`);
    this.name = "NativeReservationEvidenceError";
  }
}

const TERMINAL_REQUEST_STATES = ["completed", "failed"] as const;
const DEFAULT_VIEWER_LEASE_TTL_MS = 20_000;
const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;

export function openProgressStore(options: ProgressStoreOptions): SqliteProgressStore {
  if (!options.ownerKey.trim()) throw new TypeError("ownerKey is required");
  const parent = dirname(options.databasePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const database = openDatabase(options.databasePath);
  chmodSync(options.databasePath, 0o600);
  return new SqliteProgressStore(database, options);
}

export const createProgressStore = openProgressStore;

export class SqliteProgressStore implements ProgressStore {
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;
  private readonly viewerLeaseTtlMs: number;
  private closed = false;

  constructor(
    private readonly database: Database,
    private readonly options: ProgressStoreOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("hex"));
    this.viewerLeaseTtlMs = options.viewerLeaseTtlMs ?? DEFAULT_VIEWER_LEASE_TTL_MS;
    if (!Number.isSafeInteger(this.viewerLeaseTtlMs) || this.viewerLeaseTtlMs <= 0) {
      throw new TypeError("viewerLeaseTtlMs must be a positive integer");
    }
    this.migrate();
    migrateWorkerAdmission(this.database);
  }

  createWorkerAdmission(options: WorkerAdmissionOptions): WorkerAdmission {
    return createSqliteWorkerAdmission(this.database, this.options.ownerKey, this.now, options);
  }

  acceptRequest(rawInput: SubmitProgressRequest): ProgressRequestAcceptance {
    const input = SubmitProgressRequestSchema.parse(rawInput);
    return this.database.transaction(() => {
      const existing = this.database.prepare(
        "SELECT * FROM progress_requests WHERE request_id = ?"
      ).get(input.requestId) as RequestRow | undefined;
      const hintJson = input.contextHint === undefined ? null : JSON.stringify(input.contextHint);
      if (existing !== undefined) {
        if (
          existing.owner_key !== this.options.ownerKey
          || existing.session_id !== input.sessionId
          || existing.text !== input.text
          || existing.context_hint_json !== hintJson
        ) {
          throw new ProgressRequestCollisionError(input.requestId);
        }
        const event = this.getEventByKey(this.acceptedEventKey(input.requestId));
        if (event === undefined) throw new ProgressRecordNotFoundError("accepted event", input.requestId);
        return { accepted: false, request: this.requestSnapshot(existing), event };
      }

      const occurredAt = this.nowIso();
      this.database.prepare(`
        INSERT INTO progress_requests (
          request_id, owner_key, session_id, text, context_hint_json, state, created_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?)
      `).run(input.requestId, this.options.ownerKey, input.sessionId, input.text, hintJson, occurredAt);
      const event = this.insertEvent({
        eventKey: this.acceptedEventKey(input.requestId),
        requestId: input.requestId,
        contextId: null,
        kind: "request.accepted",
        source: "system",
        occurredAt,
        payload: { text: "Request accepted" }
      });
      const row = this.requireRequestRow(input.requestId);
      return { accepted: true, request: this.requestSnapshot(row), event };
    }).immediate();
  }

  claimNextRequest(claimantId: string): ClaimedProgressRequest | undefined {
    if (!claimantId.trim()) throw new TypeError("claimantId is required");
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM progress_requests
        WHERE owner_key = ? AND state = 'queued'
        ORDER BY created_at, rowid LIMIT 1
      `).get(this.options.ownerKey) as RequestRow | undefined;
      if (row === undefined) return undefined;
      const claimedAt = this.nowIso();
      const changed = this.database.prepare(`
        UPDATE progress_requests
        SET state = 'classifying', claimed_at = ?, claimed_by = ?
        WHERE request_id = ? AND owner_key = ? AND state = 'queued'
      `).run(claimedAt, claimantId, row.request_id, this.options.ownerKey).changes;
      if (changed !== 1) return undefined;
      return {
        request: this.requestSnapshot(this.requireRequestRow(row.request_id)),
        input: this.requestInput(row),
        claimantId,
        claimedAt
      };
    }).immediate();
  }

  getRequest(requestId: string): ProgressRequestSnapshot | undefined {
    const row = this.database.prepare(`
      SELECT * FROM progress_requests WHERE request_id = ? AND owner_key = ?
    `).get(requestId, this.options.ownerKey) as RequestRow | undefined;
    return row === undefined ? undefined : this.requestSnapshot(row);
  }

  getRequestInput(requestId: string): SubmitProgressRequest | undefined {
    const row = this.database.prepare(`
      SELECT * FROM progress_requests WHERE request_id = ? AND owner_key = ?
    `).get(requestId, this.options.ownerKey) as RequestRow | undefined;
    return row === undefined ? undefined : this.requestInput(row);
  }

  recoverInterruptedRequests(options: RecoverInterruptedRequestsOptions = {}): ProgressRequestSnapshot[] {
    return this.database.transaction(() => {
      const rows = this.database.prepare(`
        SELECT * FROM progress_requests
        WHERE owner_key = ? AND state IN ('classifying', 'executing')
        ORDER BY created_at, rowid
      `).all(this.options.ownerKey) as RequestRow[];
      const occurredAt = this.nowIso();
      const recovery: RequestRow[] = [];
      for (const row of rows) {
        if (row.state === "classifying" && options.requeueClassifying === true) {
          this.database.prepare(`
            UPDATE progress_requests
            SET state = 'queued', claimed_at = NULL, claimed_by = NULL
            WHERE request_id = ? AND owner_key = ?
          `).run(row.request_id, this.options.ownerKey);
          continue;
        }
        this.database.prepare(`
          UPDATE progress_requests SET state = 'recovery_required'
          WHERE request_id = ? AND owner_key = ?
        `).run(row.request_id, this.options.ownerKey);
        this.insertEvent({
          eventKey: `request:${row.request_id}:recovery:${row.claimed_at ?? row.created_at}`,
          requestId: row.request_id,
          contextId: null,
          kind: "recovery.required",
          source: "system",
          occurredAt,
          payload: { text: "Execution state requires reconciliation after restart" }
        });
        recovery.push(row);
      }
      return recovery.map((row) => this.requestSnapshot({ ...row, state: "recovery_required" }));
    }).immediate();
  }

  updateRequest(update: ProgressRequestUpdate): ProgressRequestSnapshot {
    const state = ProgressRequestStateSchema.parse(update.state);
    const result = update.result;
    this.requireRequestRow(update.requestId);
    this.database.prepare(`
      UPDATE progress_requests
      SET state = ?, result_text = COALESCE(?, result_text), result_job_id = COALESCE(?, result_job_id)
      WHERE request_id = ? AND owner_key = ?
    `).run(
      state,
      result?.text ?? null,
      result?.jobId ?? null,
      update.requestId,
      this.options.ownerKey
    );
    return this.requestSnapshot(this.requireRequestRow(update.requestId));
  }

  completeRequest(input: CompleteProgressRequest): ProgressRequestSnapshot {
    if (!input.text.trim()) throw new TypeError("completion text is required");
    return this.database.transaction(() => {
      const request = this.requireRequestRow(input.requestId);
      const existingEvent = this.getEventByKey(input.eventKey);
      const compactedCompletion = existingEvent === undefined
        && request.events_compacted_through > 0
        && (request.state === "completed" || request.state === "failed")
        && request.result_text !== null;
      if (
        (existingEvent !== undefined || compactedCompletion)
        && (
          request.state !== input.state
          || request.result_text !== input.text
          || request.result_job_id !== (input.jobId ?? null)
        )
      ) throw new ProgressEventCollisionError(input.eventKey);
      // The durable result remains the completion receipt after display detail expires.
      if (compactedCompletion) return this.requestSnapshot(request);
      const kind = input.state === "completed"
        ? "request.completed"
        : input.state === "failed" ? "request.failed" : "recovery.required";
      this.appendEvent({
        eventKey: input.eventKey,
        requestId: input.requestId,
        contextId: null,
        kind,
        source: "system",
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
        payload: this.boundEventPayload({
          text: input.text,
          ...(input.jobId === undefined ? {} : { jobId: input.jobId })
        })
      });
      this.database.prepare(`
        UPDATE progress_requests SET state = ?, result_text = ?, result_job_id = ?
        WHERE request_id = ? AND owner_key = ?
      `).run(input.state, input.text, input.jobId ?? null, input.requestId, this.options.ownerKey);
      return this.requestSnapshot(this.requireRequestRow(input.requestId));
    }).immediate();
  }

  createContext(input: CreateWorkContext): ContextSnapshot {
    const now = this.nowIso();
    const existing = this.database.prepare(
      "SELECT * FROM work_contexts WHERE context_id = ?"
    ).get(input.contextId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (
        existing.owner_key !== this.options.ownerKey
        || existing.origin_session_id !== input.originSessionId
        || existing.title !== input.title
        || existing.objective !== input.objective
      ) throw new ProgressRecordCollisionError("context", input.contextId);
      return this.requireContextSnapshot(input.contextId);
    }
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO work_contexts (
          context_id, owner_key, origin_session_id, title, objective, summary,
          thread_id, state, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)
      `).run(
        input.contextId,
        this.options.ownerKey,
        input.originSessionId,
        input.title,
        input.objective,
        input.summary ?? "",
        input.threadId ?? null,
        now,
        now
      );
      const addProject = this.database.prepare(
        "INSERT OR IGNORE INTO context_projects(context_id, project_id) VALUES (?, ?)"
      );
      for (const projectId of new Set(input.projectIds ?? [])) addProject.run(input.contextId, projectId);
    }).immediate();
    return this.requireContextSnapshot(input.contextId);
  }

  updateContext(input: UpdateWorkContext): ContextSnapshot {
    this.requireContextSnapshot(input.contextId);
    const current = this.database.prepare(`
      SELECT title, objective, summary, thread_id, state FROM work_contexts
      WHERE context_id = ? AND owner_key = ?
    `).get(input.contextId, this.options.ownerKey) as {
      title: string; objective: string; summary: string; thread_id: string | null; state: string;
    };
    this.database.prepare(`
      UPDATE work_contexts SET title = ?, objective = ?, summary = ?, thread_id = ?, state = ?,
        revision = revision + 1, updated_at = ?
      WHERE context_id = ? AND owner_key = ?
    `).run(
      input.title ?? current.title,
      input.objective ?? current.objective,
      input.summary ?? current.summary,
      input.threadId === undefined ? current.thread_id : input.threadId,
      input.state ?? current.state,
      this.nowIso(),
      input.contextId,
      this.options.ownerKey
    );
    return this.requireContextSnapshot(input.contextId);
  }

  assignRequestContext(input: AssignRequestContext): void {
    this.requireRequestRow(input.requestId);
    this.requireContextSnapshot(input.contextId);
    const existing = this.database.prepare(`
      SELECT context_id, relation, source_context_id, instruction FROM request_contexts
      WHERE request_id = ? AND part_id = ?
    `).get(input.requestId, input.partId) as {
      context_id: string; relation: string; source_context_id: string | null; instruction: string;
    } | undefined;
    if (existing !== undefined) {
      if (
        existing.context_id !== input.contextId
        || existing.relation !== input.relation
        || existing.source_context_id !== (input.sourceContextId ?? null)
        || existing.instruction !== input.instruction
      ) throw new ProgressRecordCollisionError("request context", `${input.requestId}:${input.partId}`);
      return;
    }
    this.database.prepare(`
      INSERT INTO request_contexts (
        request_id, part_id, context_id, relation, source_context_id, instruction
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId,
      input.partId,
      input.contextId,
      input.relation,
      input.sourceContextId ?? null,
      input.instruction
    );
  }

  setContextAgent(input: SetContextAgent): void {
    if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
      throw new TypeError("generation must be a positive integer");
    }
    this.requireContextSnapshot(input.contextId);
    const existing = this.database.prepare(`
      SELECT generation FROM context_agents WHERE context_id = ?
    `).get(input.contextId) as { generation: number } | undefined;
    if (existing !== undefined && input.generation < existing.generation) {
      throw new ExecutionGenerationConflictError(input.contextId, input.generation);
    }
    this.database.prepare(`
      INSERT INTO context_agents (
        context_id, agent_id, current_request_id, state, generation, heartbeat_at, last_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(context_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        current_request_id = excluded.current_request_id,
        state = excluded.state,
        generation = excluded.generation,
        heartbeat_at = excluded.heartbeat_at,
        last_observed_at = excluded.last_observed_at
    `).run(
      input.contextId,
      input.agentId,
      input.currentRequestId ?? null,
      input.state,
      input.generation,
      input.heartbeatAt ?? null,
      input.lastObservedAt ?? null
    );
  }

  getContextAgent(contextId: string): ContextAgentRecord | undefined {
    const row = this.database.prepare(`
      SELECT a.* FROM context_agents a
      JOIN work_contexts c ON c.context_id = a.context_id
      WHERE a.context_id = ? AND c.owner_key = ?
    `).get(contextId, this.options.ownerKey) as {
      context_id: string;
      agent_id: string;
      current_request_id: string | null;
      state: string;
      generation: number;
      heartbeat_at: string | null;
      last_observed_at: string | null;
    } | undefined;
    if (row === undefined) return undefined;
    return {
      contextId: row.context_id,
      agentId: row.agent_id,
      state: row.state,
      generation: row.generation,
      ...(row.current_request_id === null ? {} : { currentRequestId: row.current_request_id }),
      ...(row.heartbeat_at === null ? {} : { heartbeatAt: row.heartbeat_at }),
      ...(row.last_observed_at === null ? {} : { lastObservedAt: row.last_observed_at })
    };
  }

  listRequestAssignments(requestId: string): RequestContextAssignment[] {
    this.requireRequestRow(requestId);
    const rows = this.database.prepare(`
      SELECT request_id, part_id, context_id, relation, source_context_id, instruction, outcome_json
      FROM request_contexts WHERE request_id = ? ORDER BY part_id
    `).all(requestId) as Array<{
      request_id: string;
      part_id: string;
      context_id: string;
      relation: "new" | "continue";
      source_context_id: string | null;
      instruction: string;
      outcome_json: string | null;
    }>;
    return rows.map((row) => ({
      requestId: row.request_id,
      partId: row.part_id,
      contextId: row.context_id,
      relation: row.relation,
      instruction: row.instruction,
      ...(row.outcome_json === null ? {} : { outcome: JSON.parse(row.outcome_json) as AssignmentOutcome }),
      ...(row.source_context_id === null ? {} : { sourceContextId: row.source_context_id })
    }));
  }

  completeAssignment(input: CompleteRequestAssignment): void {
    this.database.transaction(() => {
      const assignment = this.listRequestAssignments(input.requestId).find(a => a.partId === input.partId);
      if (!assignment) throw new ProgressRecordNotFoundError("assignment", input.partId);
      if (assignment.outcome) {
        if (JSON.stringify(assignment.outcome) !== JSON.stringify(input.outcome)) {
          throw new ProgressRecordCollisionError("assignment outcome", `${input.requestId}:${input.partId}`);
        }
        return;
      }
      this.appendEvent({
        requestId: input.requestId,
        contextId: assignment.contextId,
        eventKey: input.eventKey,
        kind: input.outcome.state === "completed" ? "request.completed"
          : input.outcome.state === "failed" ? "request.failed" : "recovery.required",
        source: "system",
        payload: this.boundEventPayload({ text: input.outcome.text, partId: input.partId }),
      });
      this.database.prepare(`
        UPDATE request_contexts SET outcome_json = ? WHERE request_id = ? AND part_id = ?
      `).run(JSON.stringify(input.outcome), input.requestId, input.partId);
    }).immediate();
  }

  listRequestContexts(requestId: string): RequestContextAssignment[] {
    return this.listRequestAssignments(requestId);
  }

  linkContextJob(input: LinkContextJob): void {
    this.requireContextSnapshot(input.contextId);
    this.requireRequestRow(input.requestId);
    const existing = this.database.prepare(`
      SELECT attempt_key, request_id, dispatch_id FROM context_jobs
      WHERE context_id = ? AND job_id = ? ORDER BY rowid
    `).all(input.contextId, input.jobId) as Array<{
      attempt_key: string; request_id: string; dispatch_id: string | null;
    }>;
    const sameRequest = existing.find(({ request_id }) => request_id === input.requestId);
    if (sameRequest !== undefined) {
      if (input.dispatchId === undefined || sameRequest.dispatch_id === input.dispatchId) return;
      if (sameRequest.dispatch_id !== null) {
        throw new ProgressRecordCollisionError("context job", `${input.contextId}:${input.jobId}`);
      }
      this.database.prepare(`
        UPDATE context_jobs SET attempt_key = ?, dispatch_id = ?
        WHERE context_id = ? AND job_id = ? AND attempt_key = ?
      `).run(
        this.jobAttemptKey(input.requestId, input.dispatchId),
        input.dispatchId,
        input.contextId,
        input.jobId,
        sameRequest.attempt_key
      );
      return;
    }
    if (existing.length > 0) {
      throw new ProgressRecordCollisionError("context job", `${input.contextId}:${input.jobId}`);
    }
    this.database.prepare(`
      INSERT INTO context_jobs(context_id, job_id, attempt_key, request_id, dispatch_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.contextId,
      input.jobId,
      this.jobAttemptKey(input.requestId, input.dispatchId),
      input.requestId,
      input.dispatchId ?? null
    );
  }

  rebindContextJob(input: LinkContextJob & { dispatchId: string }): void {
    if (!input.dispatchId.trim()) throw new TypeError("dispatchId is required to rebind a job");
    this.requireContextSnapshot(input.contextId);
    this.requireRequestRow(input.requestId);
    const existing = this.database.prepare(`
      SELECT request_id FROM context_jobs
      WHERE context_id = ? AND job_id = ? AND dispatch_id = ?
    `).get(input.contextId, input.jobId, input.dispatchId) as { request_id: string } | undefined;
    if (existing !== undefined) {
      if (existing.request_id !== input.requestId) {
        throw new ProgressRecordCollisionError("context job dispatch", input.dispatchId);
      }
      return;
    }
    this.database.prepare(`
      INSERT INTO context_jobs(context_id, job_id, attempt_key, request_id, dispatch_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.contextId,
      input.jobId,
      this.jobAttemptKey(input.requestId, input.dispatchId),
      input.requestId,
      input.dispatchId
    );
  }

  listContextJobs(contextId?: string): ContextJobRecord[] {
    if (contextId !== undefined) this.requireContextSnapshot(contextId);
    const rows = (contextId === undefined
      ? this.database.prepare(`
          SELECT j.* FROM context_jobs j
          JOIN work_contexts c ON c.context_id = j.context_id
          WHERE c.owner_key = ? ORDER BY j.context_id, j.job_id, j.rowid
        `).all(this.options.ownerKey)
      : this.database.prepare(`
          SELECT j.* FROM context_jobs j
          JOIN work_contexts c ON c.context_id = j.context_id
          WHERE c.owner_key = ? AND j.context_id = ? ORDER BY j.job_id, j.rowid
        `).all(this.options.ownerKey, contextId)) as Array<{
      context_id: string; job_id: string; request_id: string; dispatch_id: string | null;
    }>;
    return rows.map((row) => ({
      contextId: row.context_id,
      jobId: row.job_id,
      requestId: row.request_id,
      ...(row.dispatch_id === null ? {} : { dispatchId: row.dispatch_id })
    }));
  }

  listContexts(sessionId?: string): ContextSnapshot[] {
    const rows = (sessionId === undefined
      ? this.database.prepare(`
          SELECT context_id FROM work_contexts WHERE owner_key = ? ORDER BY updated_at DESC, context_id
        `).all(this.options.ownerKey)
      : this.database.prepare(`
          SELECT context_id FROM work_contexts
          WHERE owner_key = ? AND origin_session_id = ? ORDER BY updated_at DESC, context_id
        `).all(this.options.ownerKey, sessionId)) as Array<{ context_id: string }>;
    return rows.map(({ context_id }) => this.requireContextSnapshot(context_id));
  }

  getContext(contextId: string): ContextSnapshot | undefined {
    const exists = this.database.prepare(`
      SELECT 1 FROM work_contexts WHERE context_id = ? AND owner_key = ?
    `).get(contextId, this.options.ownerKey);
    return exists === undefined ? undefined : this.requireContextSnapshot(contextId);
  }

  appendEvent(input: AppendProgressEvent): ProgressEvent {
    return this.database.transaction(() => {
      const existing = this.getEventByKey(input.eventKey);
      if (existing !== undefined) {
        const occurredAt = input.occurredAt ?? existing.occurredAt;
        const proposed = {
          ...input,
          occurredAt,
          seq: existing.seq
        };
        const parsed = ProgressEventSchema.parse(proposed);
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
          throw new ProgressEventCollisionError(input.eventKey);
        }
        return existing;
      }
      const occurredAt = input.occurredAt ?? this.nowIso();
      return this.insertEvent({ ...input, occurredAt });
    }).immediate();
  }

  readEvents(query: ProgressEventQuery): ProgressEventPage {
    if (!Number.isSafeInteger(query.after) || query.after < 0) throw new TypeError("after must be nonnegative");
    if (query.sessionId !== undefined && query.contextId !== undefined) {
      throw new TypeError("sessionId and contextId are mutually exclusive");
    }
    const limit = query.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new TypeError("limit must be between 1 and 10000");
    }
    const clauses = ["e.owner_key = ?", "e.seq > ?"];
    const parameters: unknown[] = [this.options.ownerKey, query.after];
    if (query.contextId !== undefined) {
      clauses.push("e.context_id = ?");
      parameters.push(query.contextId);
    } else if (query.sessionId !== undefined) {
      clauses.push("r.session_id = ?");
      parameters.push(query.sessionId);
    }
    parameters.push(limit);
    const rows = this.database.prepare(`
      SELECT e.* FROM progress_events e
      JOIN progress_requests r ON r.request_id = e.request_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY e.seq LIMIT ?
    `).all(...parameters) as EventRow[];

    const scopeClauses = ["owner_key = ?"];
    const scopeParameters: unknown[] = [this.options.ownerKey];
    if (query.contextId !== undefined) {
      scopeClauses.push(`request_id IN (
        SELECT request_id FROM request_contexts WHERE context_id = ?
      )`);
      scopeParameters.push(query.contextId);
    } else if (query.sessionId !== undefined) {
      scopeClauses.push("session_id = ?");
      scopeParameters.push(query.sessionId);
    }
    const watermarks = this.database.prepare(`
      SELECT COALESCE(MAX(events_compacted_through), 0) AS compacted
      FROM progress_requests WHERE ${scopeClauses.join(" AND ")}
    `).get(...scopeParameters) as { compacted: number };
    const eventScopeClauses = ["e.owner_key = ?"];
    const eventScopeParameters: unknown[] = [this.options.ownerKey];
    if (query.contextId !== undefined) {
      eventScopeClauses.push("e.context_id = ?");
      eventScopeParameters.push(query.contextId);
    } else if (query.sessionId !== undefined) {
      eventScopeClauses.push("r.session_id = ?");
      eventScopeParameters.push(query.sessionId);
    }
    const stats = this.database.prepare(`
      SELECT COALESCE(MIN(e.seq), 0) AS oldest, COALESCE(MAX(e.seq), 0) AS latest
      FROM progress_events e
      JOIN progress_requests r ON r.request_id = e.request_id
      WHERE ${eventScopeClauses.join(" AND ")}
    `).get(...eventScopeParameters) as { oldest: number; latest: number };
    const compacted = query.after < watermarks.compacted;
    const events = rows.map((row) => this.eventFromRow(row));
    const latestSeq = Math.max(watermarks.compacted, stats.latest);
    const oldestSeq = stats.oldest > 0
      ? stats.oldest
      : watermarks.compacted > 0 ? watermarks.compacted + 1 : 0;
    return {
      events,
      oldestSeq,
      latestSeq,
      compacted,
      snapshots: compacted
        ? query.contextId === undefined
          ? this.listContexts(query.sessionId)
          : this.getContext(query.contextId) === undefined ? [] : [this.requireContextSnapshot(query.contextId)]
        : []
    };
  }

  acquireViewerLease(input: AcquireViewerLease): ViewerLeaseResult {
    this.requireContextSnapshot(input.contextId);
    return this.database.transaction(() => {
      const now = this.nowIso();
      const existing = this.database.prepare(`
        SELECT viewer_instance_id, expires_at FROM progress_viewers
        WHERE context_id = ? AND owner_key = ?
      `).get(input.contextId, this.options.ownerKey) as {
        viewer_instance_id: string; expires_at: string;
      } | undefined;
      if (existing !== undefined && existing.expires_at > now) {
        return {
          acquired: false,
          viewerInstanceId: existing.viewer_instance_id,
          expiresAt: existing.expires_at
        };
      }
      const leaseToken = this.tokenFactory();
      if (leaseToken.length < 32) throw new TypeError("viewer lease tokens must contain at least 32 characters");
      const expiresAt = new Date(this.now().getTime() + this.viewerLeaseTtlMs).toISOString();
      this.database.prepare(`
        INSERT INTO progress_viewers (
          context_id, owner_key, viewer_instance_id, lease_token_hash, heartbeat_at,
          expires_at, window_state
        ) VALUES (?, ?, ?, ?, ?, ?, 'leased')
        ON CONFLICT(context_id) DO UPDATE SET
          owner_key = excluded.owner_key,
          viewer_instance_id = excluded.viewer_instance_id,
          lease_token_hash = excluded.lease_token_hash,
          heartbeat_at = excluded.heartbeat_at,
          expires_at = excluded.expires_at,
          window_state = excluded.window_state
      `).run(
        input.contextId,
        this.options.ownerKey,
        input.viewerInstanceId,
        this.hashToken(leaseToken),
        now,
        expiresAt
      );
      return { acquired: true, viewerInstanceId: input.viewerInstanceId, leaseToken, expiresAt };
    }).immediate();
  }

  heartbeatViewerLease(input: MutateViewerLease): ViewerLeaseMutation {
    return this.database.transaction(() => {
      const row = this.requireViewerLease(input);
      const now = this.nowIso();
      if (row.expires_at <= now) throw new ViewerLeaseConflictError(input.contextId);
      const expiresAt = new Date(this.now().getTime() + this.viewerLeaseTtlMs).toISOString();
      this.database.prepare(`
        UPDATE progress_viewers SET heartbeat_at = ?, expires_at = ?
        WHERE context_id = ? AND owner_key = ?
      `).run(now, expiresAt, input.contextId, this.options.ownerKey);
      return { ok: true } as const;
    }).immediate();
  }

  releaseViewerLease(input: MutateViewerLease): ViewerLeaseMutation {
    return this.database.transaction(() => {
      this.requireViewerLease(input);
      this.database.prepare(`
        DELETE FROM progress_viewers WHERE context_id = ? AND owner_key = ?
      `).run(input.contextId, this.options.ownerKey);
      return { ok: true } as const;
    }).immediate();
  }

  tryReserveExecution(input: ReserveContextExecution): ExecutionReservationResult {
    if (input.resources.length === 0) throw new TypeError("at least one resource is required");
    return this.database.transaction((): ExecutionReservationResult => {
      this.assertExecutionIdentity(input.contextId, input.requestId, input.agentId, input.generation);
      this.requireRequestRow(input.requestId);
      const existing = this.reservationRows(input.reservationId);
      if (existing.length > 0) {
        if (existing.every((row) => row.state === "released")) {
          throw new ExecutionReservationReleasedError(input.reservationId);
        }
        const expected = [...input.resources].sort((a, b) => a.resourceKey.localeCompare(b.resourceKey));
        const actual = existing.map(({ resource_key, mode }) => ({ resourceKey: resource_key, mode }))
          .sort((a, b) => a.resourceKey.localeCompare(b.resourceKey));
        const identityMatches = existing.every((row) =>
          row.context_id === input.contextId
          && row.request_id === input.requestId
          && row.agent_id === input.agentId
          && row.generation === input.generation
        );
        if (!identityMatches || JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new ExecutionReservationCollisionError(input.reservationId);
        }
        if (existing.some((row) => row.state === "recovery_required")) {
          return {
            acquired: false,
            conflicts: existing.map((row) => ({
              resourceKey: row.resource_key,
              requestedMode: row.mode,
              heldBy: this.reservationFromRow(row)
            }))
          };
        }
        return { acquired: true, reservations: existing.map((row) => this.reservationFromRow(row)) };
      }

      const held = this.database.prepare(`
        SELECT * FROM execution_reservations
        WHERE owner_key = ? AND state IN ('acquired', 'recovery_required')
        ORDER BY reservation_id, resource_key
      `).all(this.options.ownerKey) as ReservationRow[];
      const conflicts: ReservationConflict[] = [];
      for (const requested of input.resources) {
        for (const row of held) {
          if (
            this.resourcesOverlap(requested.resourceKey, row.resource_key)
            && (requested.mode === "write" || row.mode === "write")
          ) {
            conflicts.push({
              resourceKey: requested.resourceKey,
              requestedMode: requested.mode,
              heldBy: this.reservationFromRow(row)
            });
          }
        }
      }
      for (const requested of input.resources) {
        for (const native of nativeExecutionReservations(this.database, this.options.ownerKey)) {
          if (native.state !== "released" && resourcesOverlap(requested.resourceKey, native.resourceKey)
            && (requested.mode === "write" || native.mode === "write")) {
            conflicts.push({ resourceKey: requested.resourceKey, requestedMode: requested.mode, heldBy: native });
          }
        }
      }
      if (conflicts.length > 0) return { acquired: false, conflicts };

      const now = this.nowIso();
      const insert = this.database.prepare(`
        INSERT INTO execution_reservations (
          reservation_id, owner_key, context_id, request_id, agent_id, generation,
          resource_key, mode, state, acquired_at, heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?)
      `);
      for (const resource of input.resources) {
        insert.run(
          input.reservationId,
          this.options.ownerKey,
          input.contextId,
          input.requestId,
          input.agentId,
          input.generation,
          resource.resourceKey,
          resource.mode,
          now,
          now
        );
      }
      return {
        acquired: true,
        reservations: this.reservationRows(input.reservationId).map((row) => this.reservationFromRow(row))
      };
    }).immediate();
  }

  linkReservationDispatch(input: LinkReservationDispatch): ExecutionReservation {
    return this.database.transaction(() => {
      this.assertExecutionGeneration(input.contextId, input.generation);
      const rows = this.requireReservationMutation(input);
      if (rows.some((row) => row.native_dispatch_id !== null && row.native_dispatch_id !== input.nativeDispatchId)) {
        throw new ExecutionReservationCollisionError(input.reservationId);
      }
      this.database.prepare(`
        UPDATE execution_reservations SET native_dispatch_id = ?
        WHERE reservation_id = ? AND owner_key = ? AND state IN ('acquired', 'recovery_required')
      `).run(input.nativeDispatchId, input.reservationId, this.options.ownerKey);
      return this.reservationFromRow(this.reservationRows(input.reservationId)[0]!);
    }).immediate();
  }

  heartbeatExecutionReservation(input: HeartbeatExecutionReservation): ExecutionReservation {
    return this.database.transaction(() => {
      this.assertExecutionGeneration(input.contextId, input.generation);
      const rows = this.reservationRows(input.reservationId).filter((row) =>
        row.context_id === input.contextId
        && row.generation === input.generation
        && row.state !== "released"
      );
      if (rows.length === 0) throw new ProgressRecordNotFoundError("reservation", input.reservationId);
      this.database.prepare(`
        UPDATE execution_reservations SET heartbeat_at = ?
        WHERE reservation_id = ? AND owner_key = ? AND state IN ('acquired', 'recovery_required')
      `).run(this.nowIso(), input.reservationId, this.options.ownerKey);
      return this.reservationFromRow(this.reservationRows(input.reservationId)[0]!);
    }).immediate();
  }

  markReservationRecoveryRequired(input: MutateExecutionReservation): ExecutionReservation[] {
    return this.mutateReservation(input, "recovery_required");
  }

  releaseExecutionReservation(input: MutateExecutionReservation): ExecutionReservation[] {
    return this.mutateReservation(input, "released");
  }

  assertExecutionGeneration(contextId: string, generation: number): void {
    const row = this.database.prepare(`
      SELECT generation FROM context_agents a
      JOIN work_contexts c ON c.context_id = a.context_id
      WHERE a.context_id = ? AND c.owner_key = ?
    `).get(contextId, this.options.ownerKey) as { generation: number } | undefined;
    if (row?.generation !== generation) throw new ExecutionGenerationConflictError(contextId, generation);
  }

  listExecutionReservations(contextId?: string): ExecutionReservation[] {
    const rows = (contextId === undefined
      ? this.database.prepare(`
          SELECT * FROM execution_reservations WHERE owner_key = ? ORDER BY reservation_id, resource_key
        `).all(this.options.ownerKey)
      : this.database.prepare(`
          SELECT * FROM execution_reservations
          WHERE owner_key = ? AND context_id = ? ORDER BY reservation_id, resource_key
        `).all(this.options.ownerKey, contextId)) as ReservationRow[];
    return [...rows.map((row) => this.reservationFromRow(row)), ...nativeExecutionReservations(this.database, this.options.ownerKey, contextId)];
  }

  pruneCompletedEvents(before: string): number {
    if (Number.isNaN(Date.parse(before))) throw new TypeError("before must be an ISO timestamp");
    return this.database.transaction(() => {
      const rows = this.database.prepare(`
        SELECT e.request_id, e.seq
        FROM progress_events e
        JOIN progress_requests r ON r.request_id = e.request_id
        WHERE e.owner_key = ? AND r.owner_key = ?
          AND r.state IN (${TERMINAL_REQUEST_STATES.map(() => "?").join(",")})
          AND e.occurred_at < ? AND e.kind != 'request.accepted'
          AND NOT EXISTS (
            SELECT 1 FROM execution_reservations held
            WHERE held.owner_key = r.owner_key AND held.request_id = r.request_id
              AND held.state != 'released'
          )
          AND NOT EXISTS (
            SELECT 1 FROM hq_worker_attempts native
            WHERE native.owner_key = r.owner_key AND native.request_id = r.request_id
              AND native.state NOT IN ('queued', 'settled')
          )
        ORDER BY e.seq LIMIT 1000
      `).all(
        this.options.ownerKey,
        this.options.ownerKey,
        ...TERMINAL_REQUEST_STATES,
        new Date(before).toISOString()
      ) as Array<{ request_id: string; seq: number }>;
      const compacted = new Map<string, number>();
      // Selection and deletion share this immediate transaction, including reservation checks.
      for (const row of rows) {
        compacted.set(row.request_id, row.seq);
      }
      for (const [requestId, maxSeq] of compacted) {
        this.database.prepare(`
          UPDATE progress_requests
          SET events_compacted_through = MAX(events_compacted_through, ?)
          WHERE request_id = ? AND owner_key = ?
        `).run(maxSeq, requestId, this.options.ownerKey);
      }
      if (!rows.length) return 0;
      return this.database.prepare(`
        DELETE FROM progress_events
        WHERE owner_key = ? AND seq IN (${rows.map(() => "?").join(",")})
      `).run(
        this.options.ownerKey,
        ...rows.map(row => row.seq)
      ).changes;
    }).immediate();
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS progress_requests (
        request_id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        context_hint_json TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued','classifying','awaiting_input','executing','completed','failed','recovery_required')),
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        claimed_by TEXT,
        result_text TEXT,
        result_job_id TEXT,
        events_compacted_through INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS progress_requests_owner_queue
        ON progress_requests(owner_key, state, created_at);

      CREATE TABLE IF NOT EXISTS work_contexts (
        context_id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        origin_session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        thread_id TEXT,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS work_contexts_owner_updated
        ON work_contexts(owner_key, updated_at);

      CREATE TABLE IF NOT EXISTS context_agents (
        context_id TEXT PRIMARY KEY REFERENCES work_contexts(context_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        current_request_id TEXT REFERENCES progress_requests(request_id),
        state TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation > 0),
        heartbeat_at TEXT,
        last_observed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS execution_reservations (
        reservation_id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        context_id TEXT NOT NULL REFERENCES work_contexts(context_id),
        request_id TEXT NOT NULL REFERENCES progress_requests(request_id),
        agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation > 0),
        resource_key TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('read','write')),
        state TEXT NOT NULL CHECK(state IN ('acquired','recovery_required','released')),
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        released_at TEXT,
        native_dispatch_id TEXT,
        PRIMARY KEY(reservation_id, resource_key)
      );
      CREATE INDEX IF NOT EXISTS execution_reservations_active
        ON execution_reservations(owner_key, state, resource_key);
      CREATE INDEX IF NOT EXISTS execution_reservations_request_state
        ON execution_reservations(owner_key, request_id, state);

      CREATE TABLE IF NOT EXISTS request_contexts (
        request_id TEXT NOT NULL REFERENCES progress_requests(request_id) ON DELETE CASCADE,
        part_id TEXT NOT NULL,
        context_id TEXT NOT NULL REFERENCES work_contexts(context_id),
        relation TEXT NOT NULL CHECK(relation IN ('new','continue')),
        source_context_id TEXT,
        instruction TEXT NOT NULL,
        outcome_json TEXT,
        PRIMARY KEY(request_id, part_id)
      );
      CREATE INDEX IF NOT EXISTS request_contexts_context ON request_contexts(context_id);

      CREATE TABLE IF NOT EXISTS context_projects (
        context_id TEXT NOT NULL REFERENCES work_contexts(context_id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        PRIMARY KEY(context_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS context_jobs (
        context_id TEXT NOT NULL REFERENCES work_contexts(context_id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        attempt_key TEXT NOT NULL,
        request_id TEXT NOT NULL REFERENCES progress_requests(request_id),
        dispatch_id TEXT,
        PRIMARY KEY(context_id, job_id, attempt_key)
      );

      CREATE TABLE IF NOT EXISTS progress_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        owner_key TEXT NOT NULL,
        request_id TEXT NOT NULL REFERENCES progress_requests(request_id),
        context_id TEXT REFERENCES work_contexts(context_id),
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        agent_id TEXT,
        generation INTEGER
      );
      CREATE INDEX IF NOT EXISTS progress_events_owner_seq ON progress_events(owner_key, seq);
      CREATE INDEX IF NOT EXISTS progress_events_context_seq ON progress_events(context_id, seq);

      CREATE TABLE IF NOT EXISTS progress_viewers (
        context_id TEXT PRIMARY KEY REFERENCES work_contexts(context_id) ON DELETE CASCADE,
        owner_key TEXT NOT NULL,
        viewer_instance_id TEXT NOT NULL,
        lease_token_hash TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        window_state TEXT NOT NULL
      );
    `);
    const contextColumns = this.database.prepare("PRAGMA table_info(work_contexts)").all() as Array<{
      name: string;
    }>;
    const assignmentColumns = this.database.prepare("PRAGMA table_info(request_contexts)").all() as Array<{ name: string }>;
    if (!assignmentColumns.some(({ name }) => name === "outcome_json")) {
      this.database.exec("ALTER TABLE request_contexts ADD COLUMN outcome_json TEXT");
    }
    if (!contextColumns.some(({ name }) => name === "last_seq")) {
      this.database.exec("ALTER TABLE work_contexts ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0");
    }
    const jobColumns = this.database.prepare("PRAGMA table_info(context_jobs)").all() as Array<{
      name: string;
    }>;
    if (!jobColumns.some(({ name }) => name === "attempt_key")) {
      this.database.exec(`
        ALTER TABLE context_jobs RENAME TO context_jobs_legacy;
        CREATE TABLE context_jobs (
          context_id TEXT NOT NULL REFERENCES work_contexts(context_id) ON DELETE CASCADE,
          job_id TEXT NOT NULL,
          attempt_key TEXT NOT NULL,
          request_id TEXT NOT NULL REFERENCES progress_requests(request_id),
          dispatch_id TEXT,
          PRIMARY KEY(context_id, job_id, attempt_key)
        );
        INSERT INTO context_jobs(context_id, job_id, attempt_key, request_id, dispatch_id)
        SELECT context_id, job_id,
          CASE WHEN dispatch_id IS NULL THEN 'request:' || request_id ELSE 'dispatch:' || dispatch_id END,
          request_id, dispatch_id
        FROM context_jobs_legacy;
        DROP TABLE context_jobs_legacy;
      `);
    }
  }

  private acceptedEventKey(requestId: string): string {
    return `request:${requestId}:accepted`;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private requireRequestRow(requestId: string): RequestRow {
    const row = this.database.prepare(`
      SELECT * FROM progress_requests WHERE request_id = ? AND owner_key = ?
    `).get(requestId, this.options.ownerKey) as RequestRow | undefined;
    if (row === undefined) throw new ProgressRecordNotFoundError("request", requestId);
    return row;
  }

  private requestSnapshot(row: RequestRow): ProgressRequestSnapshot {
    const contextIds = (this.database.prepare(`
      SELECT DISTINCT context_id FROM request_contexts WHERE request_id = ? ORDER BY context_id
    `).all(row.request_id) as Array<{ context_id: string }>).map(({ context_id }) => context_id);
    return ProgressRequestSnapshotSchema.parse({
      requestId: row.request_id,
      sessionId: row.session_id,
      state: row.state,
      contextIds,
      ...(row.result_text === null ? {} : {
        result: {
          text: row.result_text,
          ...(row.result_job_id === null ? {} : { jobId: row.result_job_id })
        }
      })
    });
  }

  private requestInput(row: RequestRow): SubmitProgressRequest {
    return SubmitProgressRequestSchema.parse({
      requestId: row.request_id,
      sessionId: row.session_id,
      text: row.text,
      ...(row.context_hint_json === null
        ? {}
        : { contextHint: JSON.parse(row.context_hint_json) as unknown })
    });
  }

  private boundEventPayload<T extends Record<string, unknown>>(payload: T): T {
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_EVENT_PAYLOAD_BYTES) return payload;
    if (typeof payload.text !== "string") throw new TypeError("progress event payload exceeds 8KiB");
    const points = Array.from(payload.text);
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = { ...payload, text: `${points.slice(0, middle).join("")}…` };
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_EVENT_PAYLOAD_BYTES) low = middle;
      else high = middle - 1;
    }
    const bounded = { ...payload, text: `${points.slice(0, low).join("")}…` };
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
      throw new TypeError("progress event payload exceeds 8KiB");
    }
    return bounded;
  }

  private jobAttemptKey(requestId: string, dispatchId?: string): string {
    return dispatchId === undefined ? `request:${requestId}` : `dispatch:${dispatchId}`;
  }

  private requireContextSnapshot(contextId: string): ContextSnapshot {
    const row = this.database.prepare(`
      SELECT context_id, title, state, summary, created_at, updated_at,
        MAX(c.last_seq, COALESCE((SELECT MAX(seq) FROM progress_events e WHERE e.context_id = c.context_id), 0)) AS last_seq
      FROM work_contexts c WHERE context_id = ? AND owner_key = ?
    `).get(contextId, this.options.ownerKey) as {
      context_id: string; title: string; state: string; summary: string;
      created_at: string; updated_at: string; last_seq: number;
    } | undefined;
    if (row === undefined) throw new ProgressRecordNotFoundError("context", contextId);
    const projectIds = (this.database.prepare(`
      SELECT project_id FROM context_projects WHERE context_id = ? ORDER BY project_id
    `).all(contextId) as Array<{ project_id: string }>).map(({ project_id }) => project_id);
    const jobIds = (this.database.prepare(`
      SELECT DISTINCT job_id FROM context_jobs WHERE context_id = ? ORDER BY job_id
    `).all(contextId) as Array<{ job_id: string }>).map(({ job_id }) => job_id);
    return ContextSnapshotSchema.parse({
      contextId: row.context_id,
      title: row.title,
      state: row.state,
      summary: row.summary,
      projectIds,
      jobIds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastSeq: row.last_seq
    });
  }

  private getEventByKey(eventKey: string): ProgressEvent | undefined {
    const row = this.database.prepare(`
      SELECT * FROM progress_events WHERE event_key = ? AND owner_key = ?
    `).get(eventKey, this.options.ownerKey) as EventRow | undefined;
    return row === undefined ? undefined : this.eventFromRow(row);
  }

  private insertEvent(input: AppendProgressEvent & { occurredAt: string }): ProgressEvent {
    this.requireRequestRow(input.requestId);
    if (input.contextId !== null) {
      this.requireContextSnapshot(input.contextId);
      const assigned = this.database.prepare(`
        SELECT 1 FROM request_contexts WHERE request_id = ? AND context_id = ? LIMIT 1
      `).get(input.requestId, input.contextId);
      if (assigned === undefined) {
        throw new ProgressEventContextMismatchError(input.requestId, input.contextId);
      }
    }
    const payloadJson = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
      throw new TypeError("progress event payload exceeds 8KiB");
    }
    const draft = ProgressEventInputSchema.parse(input);
    const result = this.database.prepare(`
      INSERT INTO progress_events (
        event_key, owner_key, request_id, context_id, kind, source, occurred_at,
        payload_json, agent_id, generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.eventKey,
      this.options.ownerKey,
      draft.requestId,
      draft.contextId,
      draft.kind,
      draft.source,
      draft.occurredAt,
      payloadJson,
      draft.agentId ?? null,
      draft.generation ?? null
    );
    const seq = Number(result.lastInsertRowid);
    if (draft.contextId !== null) {
      this.database.prepare(`
        UPDATE work_contexts SET last_seq = MAX(last_seq, ?), updated_at = MAX(updated_at, ?)
        WHERE context_id = ? AND owner_key = ?
      `).run(seq, draft.occurredAt, draft.contextId, this.options.ownerKey);
    }
    return ProgressEventSchema.parse({ ...draft, seq });
  }

  private eventFromRow(row: EventRow): ProgressEvent {
    return ProgressEventSchema.parse({
      seq: row.seq,
      eventKey: row.event_key,
      requestId: row.request_id,
      contextId: row.context_id,
      kind: row.kind,
      source: row.source,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as unknown,
      ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
      ...(row.generation === null ? {} : { generation: row.generation })
    });
  }

  private requireViewerLease(input: MutateViewerLease): {
    viewer_instance_id: string; lease_token_hash: string; expires_at: string;
  } {
    const row = this.database.prepare(`
      SELECT viewer_instance_id, lease_token_hash, expires_at FROM progress_viewers
      WHERE context_id = ? AND owner_key = ?
    `).get(input.contextId, this.options.ownerKey) as {
      viewer_instance_id: string; lease_token_hash: string; expires_at: string;
    } | undefined;
    if (
      row === undefined
      || row.viewer_instance_id !== input.viewerInstanceId
      || row.lease_token_hash !== this.hashToken(input.leaseToken)
    ) throw new ViewerLeaseConflictError(input.contextId);
    return row;
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  private assertExecutionIdentity(
    contextId: string,
    requestId: string,
    agentId: string,
    generation: number
  ): void {
    const row = this.database.prepare(`
      SELECT a.agent_id, a.generation, a.current_request_id,
        EXISTS(
          SELECT 1 FROM request_contexts rc
          WHERE rc.context_id = a.context_id AND rc.request_id = ?
        ) AS assigned
      FROM context_agents a
      JOIN work_contexts c ON c.context_id = a.context_id
      WHERE a.context_id = ? AND c.owner_key = ?
    `).get(requestId, contextId, this.options.ownerKey) as {
      agent_id: string; generation: number; current_request_id: string | null; assigned: number;
    } | undefined;
    if (row?.agent_id !== agentId || row.generation !== generation) {
      throw new ExecutionGenerationConflictError(contextId, generation);
    }
    if (row.current_request_id !== requestId || row.assigned !== 1) {
      throw new ExecutionOwnershipConflictError(contextId, requestId);
    }
  }

  private reservationRows(reservationId: string): ReservationRow[] {
    return this.database.prepare(`
      SELECT * FROM execution_reservations
      WHERE reservation_id = ? AND owner_key = ? ORDER BY resource_key
    `).all(reservationId, this.options.ownerKey) as ReservationRow[];
  }

  private reservationFromRow(row: ReservationRow): ExecutionReservation {
    return {
      reservationId: row.reservation_id,
      contextId: row.context_id,
      requestId: row.request_id,
      agentId: row.agent_id,
      generation: row.generation,
      resourceKey: row.resource_key,
      mode: row.mode,
      state: row.state,
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      releasedAt: row.released_at,
      nativeDispatchId: row.native_dispatch_id
    };
  }

  private resourcesOverlap(left: string, right: string): boolean {
    return resourcesOverlap(left, right);
  }

  private requireReservationMutation(input: MutateExecutionReservation): ReservationRow[] {
    const rows = this.reservationRows(input.reservationId);
    if (
      rows.length === 0
      || rows.some((row) =>
        row.context_id !== input.contextId
        || row.request_id !== input.requestId
        || row.generation !== input.generation
      )
    ) throw new ProgressRecordNotFoundError("reservation", input.reservationId);
    return rows;
  }

  private mutateReservation(
    input: MutateExecutionReservation,
    state: "recovery_required" | "released"
  ): ExecutionReservation[] {
    return this.database.transaction(() => {
      this.assertExecutionGeneration(input.contextId, input.generation);
      const rows = this.requireReservationMutation(input);
      if (state === "released") {
        const nativeDispatchIds = new Set(rows.flatMap((row) =>
          row.native_dispatch_id === null ? [] : [row.native_dispatch_id]
        ));
        if (
          nativeDispatchIds.size > 0
          && (
            input.nativeCompletion === undefined
            || nativeDispatchIds.size !== 1
            || !nativeDispatchIds.has(input.nativeCompletion.dispatchId)
          )
        ) throw new NativeReservationEvidenceError(input.reservationId);
      }
      const now = this.nowIso();
      this.database.prepare(`
        UPDATE execution_reservations
        SET state = ?, heartbeat_at = ?, released_at = CASE WHEN ? = 'released' THEN ? ELSE released_at END
        WHERE reservation_id = ? AND owner_key = ? AND state != 'released'
      `).run(state, now, state, now, input.reservationId, this.options.ownerKey);
      return this.reservationRows(input.reservationId).map((row) => this.reservationFromRow(row));
    }).immediate();
  }
}
