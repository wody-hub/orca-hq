import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  LaunchProfileSchema, NativeWorkItemSchema, NativeWorkerReceiptSchema,
  type NativeWorkItem, type NativeWorkerReceipt
} from "@orca-hq/core";
import type { openDatabase } from "@orca-hq/persistence";
import { z } from "zod";
import { normalizeResourceAccesses, resourcesOverlap } from "./execution-reservations.js";
import type { ExecutionReservation, ProgressStore } from "./progress-store.js";

export type WorkerLimit = number | "unlimited";
export type WorkerOutcome = "succeeded" | "failed" | "stopped";
export type WorkerResourceVerdict = "released" | "retained_idle" | "transferred" | "unknown";
export type WorkerAttemptState = "queued" | "launching" | "active" | "unknown" | "release_pending" | "release_unknown" | "transferred" | "settled";
const NoLaunchEffectSchema = z.object({
  kind: z.enum(["worktree", "setup"]),
  action: z.enum(["reused", "not_applicable", "skipped"])
}).passthrough();
export const AuthoritativeNoLaunchProofSchema = z.object({
  kind: z.literal("orca_authoritative_no_launch"),
  attemptId: z.string().trim().min(1).max(512),
  launchMutationRequestId: z.string().trim().min(1).max(512),
  runId: z.string().trim().min(1).max(512),
  taskId: z.string().trim().min(1).max(512),
  dispatchId: z.string().trim().min(1).max(512).optional(),
  worktreeId: z.string().trim().min(1).max(512),
  requested: LaunchProfileSchema,
  failedStage: z.string().trim().min(1).max(256),
  observedAt: z.string().datetime(),
  effects: z.array(NoLaunchEffectSchema).max(8),
  residualResources: z.array(z.unknown()).max(0)
}).strict();
export type AuthoritativeNoLaunchProof = z.infer<typeof AuthoritativeNoLaunchProofSchema>;
export interface WorkerAdmissionOptions {
  maxActiveWorkers?: WorkerLimit;
  /** Renew with heartbeat while idle; expiry fences writes, never frees resources. */
  leaseTtlMs?: number;
}
export interface WorkerAttempt {
  sequence: number;
  item: NativeWorkItem;
  state: WorkerAttemptState;
  receipt: NativeWorkerReceipt | null;
  outcome: WorkerOutcome | null;
  resourceVerdict: WorkerResourceVerdict | null;
  claimEpoch: number | null;
  reconciledEpoch: number | null;
  noLaunchProof: AuthoritativeNoLaunchProof | null;
}
export type WorkerReconciliation =
  | { state: "active"; dispatchId: string }
  | { state: "unknown" }
  | { state: "settled"; dispatchId: string; outcome: WorkerOutcome; resourceVerdict: WorkerResourceVerdict };
export interface WorkerAdmission {
  enqueue(item: NativeWorkItem): void;
  claimNext(): NativeWorkItem | undefined;
  /** Fenced mutation-boundary assertion immediately before native effects. */
  assertLaunchAuthorized(attemptId: string): NativeWorkItem;
  bindReceipt(receipt: NativeWorkerReceipt): void;
  settle(attemptId: string, dispatchId: string, outcome: WorkerOutcome, resourceVerdict: WorkerResourceVerdict): boolean;
  markUnknown(attemptId: string): void;
  /** Releases a receipt-free claim only from an authoritative worker-start no-launch observation. */
  recoverProvenNoLaunch(proof: AuthoritativeNoLaunchProof): boolean;
  snapshot(): { active: number; queued: number };
  /** Cleanup intent is durable before an external release call. */
  beginRelease(attemptId: string, dispatchId: string): boolean;
  listAttempts(): WorkerAttempt[];
  /** Trusted relay observations only; unknown counts as observed but stays occupied. */
  reconcile(attemptId: string, observation: WorkerReconciliation): void;
  finishReconciliation(): void;
  heartbeat(): void;
  /** Relinquishes the coordinator lease, not native resources. */
  close(): void;
}

export function createWorkerAdmission(options: WorkerAdmissionOptions & { store: ProgressStore }): WorkerAdmission {
  const { store, ...configuration } = options;
  return store.createWorkerAdmission(configuration);
}

type Database = ReturnType<typeof openDatabase>;
interface AttemptRow {
  sequence: number; attempt_id: string; owner_key: string; item_json: string;
  state: WorkerAttemptState; receipt_json: string | null; dispatch_id: string | null;
  outcome: WorkerOutcome | null; resource_verdict: WorkerResourceVerdict | null;
  claim_epoch: number | null; reconciled_epoch: number | null;
  acquired_at: string | null; updated_at: string; released_at: string | null;
  no_launch_proof_json: string | null;
}
interface CoordinatorRow {
  epoch: number; token: string; owner_key: string; expires_at: number; ready: number;
}
const OCCUPIED = "('launching','active','unknown','release_pending','release_unknown','transferred')";

/** @internal Additive progress-store migration using the existing persistence connection. */
export function migrateWorkerAdmission(database: Database): void {
  database.transaction(() => {
    database.exec(`
    CREATE TABLE IF NOT EXISTS hq_worker_coordinator (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      owner_key TEXT NOT NULL, epoch INTEGER NOT NULL, token TEXT NOT NULL,
      expires_at INTEGER NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS hq_worker_attempts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL UNIQUE, owner_key TEXT NOT NULL,
      request_id TEXT NOT NULL REFERENCES progress_requests(request_id),
      context_id TEXT NOT NULL REFERENCES work_contexts(context_id),
      item_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','launching','active','unknown','release_pending','release_unknown','transferred','settled')),
      receipt_json TEXT, dispatch_id TEXT UNIQUE,
      outcome TEXT CHECK(outcome IN ('succeeded','failed','stopped')),
      resource_verdict TEXT CHECK(resource_verdict IN ('released','retained_idle','transferred','unknown')),
      claim_epoch INTEGER, reconciled_epoch INTEGER,
      acquired_at TEXT, updated_at TEXT NOT NULL, released_at TEXT,
      no_launch_proof_json TEXT
    );
    CREATE INDEX IF NOT EXISTS hq_worker_attempts_queue ON hq_worker_attempts(state, sequence);
    CREATE TABLE IF NOT EXISTS hq_worker_resources (
      attempt_id TEXT NOT NULL REFERENCES hq_worker_attempts(attempt_id),
      resource_key TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('read','write')),
      PRIMARY KEY(attempt_id, resource_key)
    );
    `);
    const columns = database.prepare("PRAGMA table_info(hq_worker_attempts)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "no_launch_proof_json")) {
      database.exec("ALTER TABLE hq_worker_attempts ADD COLUMN no_launch_proof_json TEXT");
    }
  }).immediate();
}

/** @internal Read-only projection lets legacy paths see attempt-owned native resources. */
export function nativeExecutionReservations(database: Database, ownerKey: string, contextId?: string): ExecutionReservation[] {
  const rows = database.prepare(`
    SELECT a.*, r.resource_key, r.mode FROM hq_worker_attempts a
    JOIN hq_worker_resources r ON r.attempt_id = a.attempt_id
    WHERE a.owner_key = ? ${contextId === undefined ? "" : "AND a.context_id = ?"}
    ORDER BY a.sequence, r.resource_key
  `).all(...(contextId === undefined ? [ownerKey] : [ownerKey, contextId])) as Array<AttemptRow & { resource_key: string; mode: "read" | "write" }>;
  return rows.map(row => {
    const item = parseItem(row);
    return {
      reservationId: item.attemptId, contextId: item.contextId, requestId: item.requestId,
      agentId: `attempt:${item.attemptId}`, generation: item.generation,
      resourceKey: row.resource_key, mode: row.mode,
      state: row.state === "settled" ? "released" : row.state === "active" || row.state === "launching" ? "acquired" : "recovery_required",
      acquiredAt: row.acquired_at!, heartbeatAt: row.updated_at, releasedAt: row.released_at,
      nativeDispatchId: row.dispatch_id
    };
  });
}

/** @internal Only the store creates this closure; no raw database write API escapes it. */
export function createSqliteWorkerAdmission(database: Database, ownerKey: string, now: () => Date, options: WorkerAdmissionOptions): WorkerAdmission {
  const limit = options.maxActiveWorkers === undefined ? 10 : options.maxActiveWorkers;
  if (limit !== "unlimited" && (!Number.isSafeInteger(limit) || typeof limit !== "number" || limit <= 0)) {
    throw new TypeError('maxActiveWorkers must be a positive safe integer or "unlimited"');
  }
  const ttl = options.leaseTtlMs ?? 30_000;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new TypeError("leaseTtlMs must be a positive safe integer");
  const token = randomUUID();
  let closed = false;
  const coordinator = () => database.prepare("SELECT * FROM hq_worker_coordinator WHERE singleton = 1").get() as CoordinatorRow | undefined;
  const epoch = database.transaction(() => {
    const previous = coordinator();
    const timestamp = now().getTime();
    if (previous && previous.expires_at > timestamp) throw new Error("coordinator_owned");
    // One trusted HQ owner per admission journal, independent of channel/session identity.
    if (previous && previous.owner_key !== ownerKey) throw new Error("coordinator_owner_mismatch");
    const nextEpoch = (previous?.epoch ?? 0) + 1;
    if (!Number.isSafeInteger(nextEpoch)) throw new Error("coordinator_epoch_exhausted");
    const held = database.prepare(`SELECT 1 FROM hq_worker_attempts WHERE state IN ${OCCUPIED} LIMIT 1`).get();
    database.prepare(`INSERT INTO hq_worker_coordinator(singleton, owner_key, epoch, token, expires_at, ready)
      VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
      epoch=excluded.epoch, token=excluded.token, expires_at=excluded.expires_at, ready=excluded.ready
    `).run(ownerKey, nextEpoch, token, timestamp + ttl, held ? 0 : 1);
    return nextEpoch;
  }).immediate();

  function mutate<T>(operation: () => T): T {
    return database.transaction(() => {
      const owner = coordinator();
      const timestamp = now().getTime();
      if (closed || owner?.epoch !== epoch || owner.token !== token || owner.expires_at <= timestamp) throw new Error("coordinator_fenced");
      database.prepare("UPDATE hq_worker_coordinator SET expires_at = ? WHERE singleton = 1").run(timestamp + ttl);
      return operation();
    }).immediate();
  }
  function row(attemptId: string): AttemptRow | undefined {
    return database.prepare("SELECT * FROM hq_worker_attempts WHERE attempt_id = ? AND owner_key = ?").get(attemptId, ownerKey) as AttemptRow | undefined;
  }
  function requireRow(attemptId: string): AttemptRow {
    const result = row(attemptId);
    if (!result) throw new Error("attempt_not_found");
    return result;
  }
  function authorized(item: NativeWorkItem): boolean {
    return !!database.prepare(`SELECT 1 FROM request_contexts rc
      JOIN progress_requests r ON r.request_id = rc.request_id
      JOIN work_contexts c ON c.context_id = rc.context_id
      JOIN context_agents a ON a.context_id = c.context_id
      WHERE rc.request_id = ? AND rc.context_id = ? AND r.owner_key = ? AND c.owner_key = ? AND a.generation = ?
    `).get(item.requestId, item.contextId, ownerKey, ownerKey, item.generation);
  }
  function updateState(attempt: AttemptRow, state: WorkerAttemptState): void {
    database.prepare("UPDATE hq_worker_attempts SET state = ?, updated_at = ? WHERE attempt_id = ?").run(state, now().toISOString(), attempt.attempt_id);
  }
  function settle(attemptId: string, dispatchId: string, outcome: WorkerOutcome, verdict: WorkerResourceVerdict): boolean {
    if (!["succeeded", "failed", "stopped"].includes(outcome)) throw new TypeError("invalid_worker_outcome");
    if (!["released", "retained_idle", "transferred", "unknown"].includes(verdict)) throw new TypeError("invalid_resource_verdict");
    const attempt = row(attemptId);
    if (!attempt || attempt.dispatch_id !== dispatchId || attempt.receipt_json === null) return false;
    if (attempt.outcome !== null && attempt.outcome !== outcome) throw new Error("outcome_collision");
    if (attempt.state === "settled") return true; // A replay cannot resurrect released ownership.
    const released = verdict === "released" || verdict === "retained_idle";
    database.prepare(`UPDATE hq_worker_attempts SET state = ?, outcome = ?, resource_verdict = ?,
      updated_at = ?, released_at = ? WHERE attempt_id = ?`).run(
      released ? "settled" : verdict === "transferred" ? "transferred" : "release_unknown",
      outcome, verdict, now().toISOString(), released ? now().toISOString() : null, attemptId
    );
    return true;
  }
  return {
    enqueue(rawItem) {
      mutate(() => {
        const item = NativeWorkItemSchema.parse(rawItem);
        item.resources = [...normalizeResourceAccesses(item.resources)];
        const existing = row(item.attemptId);
        if (existing) {
          if (!isDeepStrictEqual(parseItem(existing), item)) throw new Error("attempt_collision");
          return;
        }
        if (!authorized(item)) throw new Error("attempt_ownership_or_generation_mismatch");
        if (item.dependsOn.includes(item.attemptId) || new Set(item.dependsOn).size !== item.dependsOn.length) throw new Error("invalid_attempt_dependencies");
        database.prepare(`INSERT INTO hq_worker_attempts(attempt_id, owner_key, request_id, context_id, item_json, state, updated_at)
          VALUES (?, ?, ?, ?, ?, 'queued', ?)`
        ).run(item.attemptId, ownerKey, item.requestId, item.contextId, JSON.stringify(item), now().toISOString());
      });
    },
    claimNext() {
      return mutate(() => {
        if (coordinator()?.ready !== 1) return undefined;
        const count = database.prepare(`SELECT COUNT(*) AS n FROM hq_worker_attempts WHERE state IN ${OCCUPIED}`).get() as { n: number };
        if (limit !== "unlimited" && count.n >= limit) return undefined;
        const queue = database.prepare("SELECT * FROM hq_worker_attempts WHERE owner_key = ? AND state = 'queued' ORDER BY sequence").all(ownerKey) as AttemptRow[];
        const held = database.prepare(`SELECT r.resource_key, r.mode FROM hq_worker_resources r JOIN hq_worker_attempts a ON a.attempt_id = r.attempt_id WHERE a.state IN ${OCCUPIED}
          UNION ALL SELECT resource_key, mode FROM execution_reservations WHERE state != 'released'`).all() as Array<{ resource_key: string; mode: "read" | "write" }>;
        const waiting: NativeWorkItem["resources"] = [];
        for (const candidate of queue) {
          const item = parseItem(candidate);
          if (!authorized(item)) continue;
          if (!item.dependsOn.every(id => { const parent = row(id); return parent?.state === "settled" && parent.outcome === "succeeded"; })) continue;
          const resources = claimResources(item);
          const conflict = resources.some(resource =>
            held.some(other => resourcesOverlap(resource.resourceKey, other.resource_key) && (resource.mode === "write" || other.mode === "write")) ||
            waiting.some(other => resourcesOverlap(resource.resourceKey, other.resourceKey) && (resource.mode === "write" || other.mode === "write"))
          );
          if (conflict) { waiting.push(...resources); continue; }
          const timestamp = now().toISOString();
          database.prepare(`UPDATE hq_worker_attempts SET state = 'launching', claim_epoch = ?, reconciled_epoch = ?, acquired_at = ?, updated_at = ? WHERE attempt_id = ?`).run(epoch, epoch, timestamp, timestamp, item.attemptId);
          const insert = database.prepare("INSERT INTO hq_worker_resources(attempt_id, resource_key, mode) VALUES (?, ?, ?)");
          for (const resource of resources) insert.run(item.attemptId, resource.resourceKey, resource.mode);
          return item;
        }
        return undefined;
      });
    },
    assertLaunchAuthorized(attemptId) {
      return mutate(() => {
        const attempt = requireRow(attemptId);
        const item = parseItem(attempt);
        if (!authorized(item) || !["launching", "unknown"].includes(attempt.state)) {
          throw new Error("native_attempt_not_admitted");
        }
        return item;
      });
    },
    bindReceipt(rawReceipt) {
      mutate(() => {
        const receipt = NativeWorkerReceiptSchema.parse(rawReceipt);
        const attempt = requireRow(receipt.attemptId);
        if (attempt.state === "queued") throw new Error("attempt_not_admitted");
        if (attempt.no_launch_proof_json !== null) throw new Error("attempt_proven_not_launched");
        const item = parseItem(attempt);
        if (receipt.worktreeId !== item.worktreeId || !isDeepStrictEqual(receipt.requested, item.profile) ||
          (item.resumeTerminalHandle !== undefined && receipt.terminalHandle !== item.resumeTerminalHandle)) throw new Error("receipt_mismatch");
        if (attempt.receipt_json !== null) {
          if (!isDeepStrictEqual(JSON.parse(attempt.receipt_json), receipt)) throw new Error("receipt_collision");
          return;
        }
        const terminalKey = `terminal:${receipt.terminalHandle}`;
        if (database.prepare(`SELECT 1 FROM hq_worker_resources r JOIN hq_worker_attempts a ON a.attempt_id = r.attempt_id
          WHERE a.state IN ${OCCUPIED} AND r.resource_key = ? AND a.attempt_id != ?`).get(terminalKey, receipt.attemptId)) throw new Error("terminal_occupied");
        if (database.prepare("SELECT 1 FROM hq_worker_attempts WHERE dispatch_id = ?").get(receipt.dispatchId)) throw new Error("receipt_collision");
        database.prepare("INSERT INTO hq_worker_resources(attempt_id, resource_key, mode) VALUES (?, ?, 'write') ON CONFLICT(attempt_id, resource_key) DO UPDATE SET mode = 'write'").run(receipt.attemptId, terminalKey);
        database.prepare(`UPDATE hq_worker_attempts SET receipt_json = ?, dispatch_id = ?, state = ?, updated_at = ? WHERE attempt_id = ?`).run(
          JSON.stringify(receipt), receipt.dispatchId, attempt.state === "launching" || attempt.state === "unknown" ? "active" : attempt.state, now().toISOString(), receipt.attemptId
        );
      });
    },
    settle(attemptId, dispatchId, outcome, resourceVerdict) {
      return mutate(() => {
        const attempt = row(attemptId);
        if (!attempt || !authorized(parseItem(attempt))) return false;
        return settle(attemptId, dispatchId, outcome, resourceVerdict);
      });
    },
    markUnknown(attemptId) {
      mutate(() => {
        const attempt = requireRow(attemptId);
        if (attempt.state === "queued") throw new Error("attempt_not_admitted");
        if (attempt.state === "settled") return;
        updateState(attempt, attempt.state === "release_pending" || attempt.state === "release_unknown" ? "release_unknown" : "unknown");
      });
    },
    recoverProvenNoLaunch(rawProof) {
      return mutate(() => {
        const proof = AuthoritativeNoLaunchProofSchema.parse(rawProof);
        const attempt = requireRow(proof.attemptId);
        if (attempt.state === "queued") throw new Error("attempt_not_admitted");
        const item = parseItem(attempt);
        if (proof.worktreeId !== item.worktreeId || !isDeepStrictEqual(proof.requested, item.profile)) {
          throw new Error("no_launch_proof_mismatch");
        }
        if (attempt.receipt_json !== null) throw new Error("receipt_already_bound");
        if (attempt.no_launch_proof_json !== null) {
          if (!isDeepStrictEqual(JSON.parse(attempt.no_launch_proof_json), proof)) {
            throw new Error("no_launch_proof_collision");
          }
          return true;
        }
        if (!["launching", "unknown"].includes(attempt.state)) {
          throw new Error("no_launch_proof_state_mismatch");
        }
        if (attempt.dispatch_id !== null && attempt.dispatch_id !== proof.dispatchId) {
          throw new Error("no_launch_proof_dispatch_mismatch");
        }
        if (proof.dispatchId && database.prepare("SELECT 1 FROM hq_worker_attempts WHERE dispatch_id = ? AND attempt_id != ?").get(proof.dispatchId, proof.attemptId)) {
          throw new Error("receipt_collision");
        }
        const timestamp = now().toISOString();
        database.prepare(`UPDATE hq_worker_attempts SET state = 'settled', dispatch_id = ?,
          outcome = 'failed', resource_verdict = 'released', no_launch_proof_json = ?,
          reconciled_epoch = ?, updated_at = ?, released_at = ? WHERE attempt_id = ?`
        ).run(proof.dispatchId ?? null, JSON.stringify(proof), epoch, timestamp, timestamp, proof.attemptId);
        return true;
      });
    },
    beginRelease(attemptId, dispatchId) {
      return mutate(() => {
        const attempt = row(attemptId);
        if (!attempt || attempt.dispatch_id !== dispatchId || attempt.receipt_json === null) return false;
        if (attempt.state !== "settled") updateState(attempt, "release_pending");
        return true;
      });
    },
    snapshot() {
      const result = database.prepare(`SELECT COALESCE(SUM(state IN ${OCCUPIED}), 0) AS active,
        COALESCE(SUM(state = 'queued'), 0) AS queued FROM hq_worker_attempts`).get() as { active: number; queued: number };
      return { active: result.active, queued: result.queued };
    },
    listAttempts() {
      const rows = database.prepare("SELECT * FROM hq_worker_attempts WHERE owner_key = ? ORDER BY sequence").all(ownerKey) as AttemptRow[];
      return rows.map(attempt => ({
        sequence: attempt.sequence,
        item: parseItem(attempt),
        state: attempt.state,
        receipt: attempt.receipt_json === null ? null : NativeWorkerReceiptSchema.parse(JSON.parse(attempt.receipt_json)),
        outcome: attempt.outcome,
        resourceVerdict: attempt.resource_verdict,
        claimEpoch: attempt.claim_epoch,
        reconciledEpoch: attempt.reconciled_epoch,
        noLaunchProof: attempt.no_launch_proof_json === null
          ? null
          : AuthoritativeNoLaunchProofSchema.parse(JSON.parse(attempt.no_launch_proof_json))
      }));
    },
    reconcile(attemptId, observation) {
      mutate(() => {
        const attempt = requireRow(attemptId);
        if (attempt.state === "queued") throw new Error("attempt_not_admitted");
        if (observation.state === "settled") {
          if (!settle(attemptId, observation.dispatchId, observation.outcome, observation.resourceVerdict)) throw new Error("reconciliation_dispatch_mismatch");
        } else if (attempt.state !== "settled") {
          if (observation.state === "active") {
            if (attempt.receipt_json === null) throw new Error("receipt_required");
            if (observation.dispatchId !== attempt.dispatch_id) throw new Error("reconciliation_dispatch_mismatch");
          }
          // Observing a settled worker's cleanup never erases the durable outcome/cleanup phase.
          if (attempt.outcome === null && !["release_pending", "release_unknown", "transferred"].includes(attempt.state)) updateState(attempt, observation.state);
        }
        database.prepare("UPDATE hq_worker_attempts SET reconciled_epoch = ? WHERE attempt_id = ?").run(epoch, attemptId);
      });
    },
    finishReconciliation() {
      mutate(() => {
        if (database.prepare(`SELECT 1 FROM hq_worker_attempts WHERE state IN ${OCCUPIED} AND (reconciled_epoch IS NULL OR reconciled_epoch != ?) LIMIT 1`).get(epoch)) throw new Error("reconciliation_required");
        database.prepare("UPDATE hq_worker_coordinator SET ready = 1 WHERE singleton = 1").run();
      });
    },
    heartbeat() { mutate(() => {}); },
    close() {
      mutate(() => { database.prepare("UPDATE hq_worker_coordinator SET expires_at = ? WHERE singleton = 1").run(now().getTime()); });
      closed = true;
    }
  };
}

function parseItem(row: AttemptRow): NativeWorkItem {
  return NativeWorkItemSchema.parse(JSON.parse(row.item_json));
}

function claimResources(item: NativeWorkItem): NativeWorkItem["resources"] {
  if (item.resumeTerminalHandle === undefined) return item.resources;
  const key = `terminal:${item.resumeTerminalHandle}`;
  return [...item.resources.filter(resource => resource.resourceKey !== key), { resourceKey: key, mode: "write" }];
}
