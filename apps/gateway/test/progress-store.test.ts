import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { openDatabase } from "@orca-hq/persistence";
import { afterEach, describe, expect, it } from "vitest";

import {
  createProgressStore,
  ProgressEventCollisionError,
  ProgressEventContextMismatchError,
  ProgressRequestCollisionError,
  ViewerLeaseConflictError,
  openProgressStore,
  type SqliteProgressStore
} from "../src/progress-store.js";

const stores: SqliteProgressStore[] = [];
const directories: string[] = [];

async function fixture(ownerKey = "owner", options?: {
  now?: () => Date;
  tokenFactory?: () => string;
  databasePath?: string;
}): Promise<{ store: SqliteProgressStore; directory: string; databasePath: string }> {
  const directory = options?.databasePath === undefined
    ? await mkdtemp(join(tmpdir(), "hq-progress-"))
    : join(options.databasePath, "..");
  if (options?.databasePath === undefined) directories.push(directory);
  const databasePath = options?.databasePath ?? join(directory, "progress.sqlite");
  const store = openProgressStore({
    databasePath,
    ownerKey,
    ...(options?.now === undefined ? {} : { now: options.now }),
    ...(options?.tokenFactory === undefined ? {} : { tokenFactory: options.tokenFactory })
  });
  stores.push(store);
  return { store, directory, databasePath };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  const { rm } = await import("node:fs/promises");
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("durable progress store", () => {
  it("atomically accepts one request and treats only identical replays as idempotent", async () => {
    const { store, databasePath, directory } = await fixture();
    const input = { requestId: "req_1", sessionId: "session_1", text: "Inspect gateway" };

    const accepted = store.acceptRequest(input);
    const replay = store.acceptRequest(input);

    expect(accepted.accepted).toBe(true);
    expect(accepted.request.state).toBe("queued");
    expect(accepted.event).toMatchObject({ seq: 1, kind: "request.accepted", contextId: null });
    expect(replay).toEqual({ ...accepted, accepted: false });
    expect(store.readEvents({ after: 0, sessionId: "session_1" }).events).toHaveLength(1);
    expect(() => store.acceptRequest({ ...input, text: "Different mutation" }))
      .toThrow(ProgressRequestCollisionError);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
  });

  it("claims queued work FIFO and saves a terminal result with its event in one transaction", async () => {
    let clock = Date.parse("2026-09-08T00:00:00.000Z");
    const { store, databasePath } = await fixture("owner", { now: () => new Date(clock) });
    store.acceptRequest({ requestId: "req_1", sessionId: "session_1", text: "First" });
    clock += 1;
    store.acceptRequest({ requestId: "req_2", sessionId: "session_1", text: "Second" });

    const firstClaim = store.claimNextRequest("router_1");
    expect(firstClaim?.request.requestId).toBe("req_1");
    expect(firstClaim?.input).toEqual({ requestId: "req_1", sessionId: "session_1", text: "First" });
    expect(store.getRequestInput("req_1")).toEqual(firstClaim?.input);
    expect(store.getRequest("req_1")?.state).toBe("classifying");
    expect(store.claimNextRequest("router_2")?.request.requestId).toBe("req_2");
    expect(store.claimNextRequest("router_3")).toBeUndefined();

    const completion = {
      requestId: "req_1",
      eventKey: "request:req_1:completed",
      state: "completed" as const,
      text: "Finished",
      jobId: "job_1"
    };
    store.completeRequest(completion);
    expect(store.completeRequest(completion).result?.text).toBe("Finished");
    expect(() => store.completeRequest({ ...completion, text: "Different result" }))
      .toThrow(ProgressEventCollisionError);
    expect(store.getRequest("req_1")).toEqual({
      requestId: "req_1",
      sessionId: "session_1",
      state: "completed",
      contextIds: [],
      result: { text: "Finished", jobId: "job_1" }
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = await fixture("owner", { databasePath });
    expect(reopened.store.getRequest("req_1")?.result?.text).toBe("Finished");
    expect(reopened.store.readEvents({ after: 0 }).events.at(-1)?.kind).toBe("request.completed");
  });

  it("marks only interrupted claimed or executing requests as recovery-required", async () => {
    const { store } = await fixture();
    store.acceptRequest({ requestId: "req_claimed", sessionId: "session_1", text: "Claimed" });
    store.acceptRequest({ requestId: "req_executing", sessionId: "session_1", text: "Executing" });
    store.acceptRequest({ requestId: "req_queued", sessionId: "session_1", text: "Queued" });
    store.acceptRequest({ requestId: "req_agent", sessionId: "session_1", text: "Agent started" });
    store.claimNextRequest("router");
    store.claimNextRequest("router");
    store.updateRequest({ requestId: "req_executing", state: "executing" });
    store.claimNextRequest("router");
    store.claimNextRequest("router");
    store.createContext({ contextId: "ctx_agent", originSessionId: "session_1", title: "Agent", objective: "Agent" });
    store.assignRequestContext({ requestId: "req_agent", partId: "part", contextId: "ctx_agent", relation: "new", instruction: "Agent" });
    store.setContextAgent({ contextId: "ctx_agent", agentId: "agent", state: "running", generation: 1, currentRequestId: "req_agent" });

    expect(store.recoverInterruptedRequests({ requeueClassifying: true }).map(({ requestId }) => requestId))
      .toEqual(["req_executing"]);
    expect(store.getRequest("req_claimed")?.state).toBe("queued");
    expect(store.getRequest("req_queued")?.state).toBe("queued");
    expect(store.getRequest("req_agent")?.state).toBe("queued");
    expect(store.readEvents({ after: 0 }).events.filter(({ kind }) => kind === "recovery.required"))
      .toHaveLength(1);
    expect(store.recoverInterruptedRequests()).toEqual([]);

    const { store: defaultStore } = await fixture();
    defaultStore.acceptRequest({ requestId: "req_default", sessionId: "session_1", text: "Default recovery" });
    defaultStore.claimNextRequest("router");
    expect(defaultStore.recoverInterruptedRequests().map(({ requestId }) => requestId))
      .toEqual(["req_default"]);
    expect(defaultStore.getRequest("req_default")?.state).toBe("recovery_required");
  });

  it("stores many request-context and context-job links in owner-scoped snapshots", async () => {
    const { store, databasePath } = await fixture();
    store.acceptRequest({ requestId: "req_multi", sessionId: "session_1", text: "Inspect FE and BE" });
    for (const contextId of ["ctx_fe", "ctx_be"]) {
      store.createContext({
        contextId,
        originSessionId: "session_1",
        title: contextId === "ctx_fe" ? "Frontend" : "Backend",
        objective: "Inspect",
        projectIds: contextId === "ctx_fe" ? ["web"] : ["api", "batch"]
      });
      store.assignRequestContext({
        requestId: "req_multi",
        partId: contextId,
        contextId,
        relation: "new",
        instruction: `Inspect ${contextId}`
      });
    }
    store.linkContextJob({ contextId: "ctx_be", jobId: "job_1", requestId: "req_multi", dispatchId: "dispatch_1" });
    store.linkContextJob({ contextId: "ctx_be", jobId: "job_2", requestId: "req_multi" });
    store.setContextAgent({
      contextId: "ctx_be",
      agentId: "agent_be",
      state: "executing",
      generation: 3,
      currentRequestId: "req_multi"
    });
    store.appendEvent({
      eventKey: "request:req_multi:ctx_be",
      requestId: "req_multi",
      contextId: "ctx_be",
      kind: "context.assigned",
      source: "system",
      payload: { text: "Assigned", contextId: "ctx_be", title: "Backend", relation: "new" }
    });

    expect(store.getRequest("req_multi")?.contextIds).toEqual(["ctx_be", "ctx_fe"]);
    expect(store.getContext("ctx_be")).toMatchObject({
      contextId: "ctx_be",
      projectIds: ["api", "batch"],
      jobIds: ["job_1", "job_2"],
      lastSeq: 2
    });
    expect(store.listContexts("session_1")).toHaveLength(2);
    expect(store.getContextAgent("ctx_be")).toMatchObject({
      contextId: "ctx_be",
      agentId: "agent_be",
      generation: 3,
      currentRequestId: "req_multi"
    });
    expect(store.listRequestAssignments("req_multi")).toEqual([
      expect.objectContaining({ contextId: "ctx_be", instruction: "Inspect ctx_be" }),
      expect.objectContaining({ contextId: "ctx_fe", instruction: "Inspect ctx_fe" })
    ]);
    expect(store.listRequestContexts("req_multi")).toEqual(store.listRequestAssignments("req_multi"));
    expect(store.listContextJobs("ctx_be")).toEqual([
      { contextId: "ctx_be", jobId: "job_1", requestId: "req_multi", dispatchId: "dispatch_1" },
      { contextId: "ctx_be", jobId: "job_2", requestId: "req_multi" }
    ]);
    store.acceptRequest({ requestId: "req_retry", sessionId: "session_1", text: "Retry job 1" });
    store.assignRequestContext({ requestId: "req_retry", partId: "retry", contextId: "ctx_be", relation: "continue", instruction: "Retry" });
    store.rebindContextJob({
      contextId: "ctx_be",
      jobId: "job_1",
      requestId: "req_retry",
      dispatchId: "dispatch_2"
    });
    expect(store.listContextJobs("ctx_be").filter(({ jobId }) => jobId === "job_1")).toEqual([
      { contextId: "ctx_be", jobId: "job_1", requestId: "req_multi", dispatchId: "dispatch_1" },
      { contextId: "ctx_be", jobId: "job_1", requestId: "req_retry", dispatchId: "dispatch_2" }
    ]);

    const other = await fixture("other", { databasePath });
    expect(other.store.getRequest("req_multi")).toBeUndefined();
    expect(other.store.listContexts()).toEqual([]);
  });

  it("deduplicates event identities, detects collisions, and filters resumable cursors", async () => {
    const { store } = await fixture();
    store.acceptRequest({ requestId: "req_1", sessionId: "session_1", text: "One" });
    store.createContext({ contextId: "ctx_1", originSessionId: "session_1", title: "One", objective: "One" });
    store.assignRequestContext({ requestId: "req_1", partId: "part_1", contextId: "ctx_1", relation: "new", instruction: "One" });
    const input = {
      eventKey: "tool:req_1:1",
      requestId: "req_1",
      contextId: "ctx_1",
      kind: "tool.started" as const,
      source: "tool" as const,
      payload: { text: "Reading" }
    };
    const first = store.appendEvent(input);
    expect(store.appendEvent(input)).toEqual(first);
    expect(() => store.appendEvent({ ...input, payload: { text: "Writing" } }))
      .toThrow(ProgressEventCollisionError);
    expect(store.readEvents({ after: first.seq - 1, contextId: "ctx_1" }).events)
      .toEqual([first]);
    const resumed = store.readEvents({ after: first.seq, contextId: "ctx_1" });
    expect(resumed.events).toEqual([]);
    expect(resumed.oldestSeq).toBe(first.seq);
    store.createContext({ contextId: "ctx_other", originSessionId: "session_1", title: "Other", objective: "Other" });
    expect(() => store.appendEvent({ ...input, eventKey: "tool:wrong-context", contextId: "ctx_other" }))
      .toThrow(ProgressEventContextMismatchError);
  });

  it("rejects malformed native worker identity before persisting the event", async () => {
    const { store } = await fixture();
    store.acceptRequest({ requestId: "req_native", sessionId: "session_1", text: "Native" });
    store.createContext({
      contextId: "ctx_native",
      originSessionId: "session_1",
      title: "Native",
      objective: "Native"
    });
    store.assignRequestContext({
      requestId: "req_native",
      partId: "part_native",
      contextId: "ctx_native",
      relation: "new",
      instruction: "Native"
    });
    const lastSeqBeforeRejectedEvent = store.getContext("ctx_native")?.lastSeq;

    expect(() => store.appendEvent({
      eventKey: "attempt:attempt_1:ready",
      requestId: "req_native",
      contextId: "ctx_native",
      kind: "worker.ready",
      source: "orca",
      payload: {
        attemptId: "attempt_1",
        worktreeId: "repo_orca-hq::/workspace/orca-hq",
        requested: {
          agent: "codex",
          model: "gpt-5.6-sol",
          reason: "General implementation"
        }
      },
      generation: 1
    })).toThrow("native_worker_identity_required");
    expect(store.readEvents({ after: 0, contextId: "ctx_native" }).events).toEqual([]);
    expect(store.getContext("ctx_native")?.lastSeq).toBe(lastSeqBeforeRejectedEvent);
  });

  it("compacts only terminal request detail and returns authoritative snapshots to stale cursors", async () => {
    const { store } = await fixture("owner", {
      now: () => new Date("2026-07-01T00:00:00.000Z")
    });
    store.acceptRequest({ requestId: "req_old", sessionId: "session_1", text: "Old" });
    store.createContext({ contextId: "ctx_old", originSessionId: "session_1", title: "Old", objective: "Old" });
    store.assignRequestContext({ requestId: "req_old", partId: "part", contextId: "ctx_old", relation: "new", instruction: "Old" });
    store.appendEvent({
      eventKey: "old:progress",
      requestId: "req_old",
      contextId: "ctx_old",
      kind: "hq.progress",
      source: "hq",
      occurredAt: "2026-07-01T00:00:00.000Z",
      payload: { text: "Old detail" }
    });
    store.completeRequest({
      requestId: "req_old",
      eventKey: "old:complete",
      state: "completed",
      text: "Old result",
      occurredAt: "2026-07-01T00:00:01.000Z"
    });
    store.acceptRequest({ requestId: "req_active", sessionId: "session_1", text: "Active" });
    store.appendEvent({
      eventKey: "active:old-timestamp",
      requestId: "req_active",
      contextId: null,
      kind: "hq.progress",
      source: "hq",
      occurredAt: "2026-07-01T00:00:00.000Z",
      payload: { text: "Must stay while active" }
    });

    const lastSeq = store.getContext("ctx_old")!.lastSeq;
    expect(store.pruneCompletedEvents("2026-08-01T00:00:00.000Z")).toBe(2);
    expect(store.acceptRequest({ requestId: "req_old", sessionId: "session_1", text: "Old" }).accepted)
      .toBe(false);
    const page = store.readEvents({ after: 0, sessionId: "session_1" });
    expect(page.compacted).toBe(true);
    expect(page.events.map(({ eventKey }) => eventKey)).toEqual([
      "request:req_old:accepted",
      "request:req_active:accepted",
      "active:old-timestamp"
    ]);
    expect(page.snapshots).toContainEqual(expect.objectContaining({ contextId: "ctx_old" }));
    expect(store.getContext("ctx_old")?.lastSeq).toBe(lastSeq);
    expect(store.getRequest("req_old")?.result?.text).toBe("Old result");
  });

  it.each(["executing", "awaiting_input", "recovery_required"] as const)(
    "retains old %s request detail without marking its cursor compacted",
    async (state) => {
      const { store } = await fixture("owner", { now: () => new Date("2026-07-01T00:00:00.000Z") });
      store.acceptRequest({ requestId: "active", sessionId: "s", text: "Unresolved work" });
      store.appendEvent({ requestId: "active", contextId: null, eventKey: "active:detail", kind: "hq.progress", source: "hq", payload: { text: "Keep evidence" } });
      store.updateRequest({ requestId: "active", state });
      const before = store.readEvents({ after: 0 });

      expect(store.pruneCompletedEvents("2026-08-01T00:00:00.000Z")).toBe(0);
      expect(store.readEvents({ after: 0 })).toEqual(before);
    }
  );

  it.each([
    { state: "acquired", linked: true },
    { state: "recovery_required", linked: true },
    { state: "recovery_required", linked: false }
  ] as const)("retains completed response detail while reservation is $state (linked=$linked)", async ({ state, linked }) => {
    const { store } = await fixture("owner", { now: () => new Date("2026-07-01T00:00:00.000Z") });
    const input = { requestId: "native", sessionId: "s", text: "Run native work" };
    const identity = { requestId: "native", contextId: "ctx", generation: 1, reservationId: "res" };
    const receipt = store.acceptRequest(input);
    store.createContext({ contextId: "ctx", originSessionId: "s", title: "Native", objective: "Work" });
    store.assignRequestContext({ requestId: "native", contextId: "ctx", partId: "p", relation: "new", instruction: "Work" });
    store.setContextAgent({ contextId: "ctx", currentRequestId: "native", agentId: "agent", generation: 1, state: "running" });
    expect(store.tryReserveExecution({ ...identity, agentId: "agent", resources: [{ resourceKey: "checkout:/tmp/native", mode: "write" }] }).acquired).toBe(true);
    if (linked) store.linkReservationDispatch({ ...identity, nativeDispatchId: "dispatch" });
    if (state === "recovery_required") store.markReservationRecoveryRequired(identity);
    store.appendEvent({ requestId: "native", contextId: "ctx", eventKey: "native:detail", kind: "hq.progress", source: "hq", payload: { text: "Native execution evidence" } });
    const completed = store.completeRequest({ requestId: "native", eventKey: "native:complete", state: "completed", text: "HQ response finished; native pending", jobId: "job" });
    const before = store.readEvents({ after: 0 });

    expect(store.pruneCompletedEvents("2026-08-01T00:00:00.000Z")).toBe(0);
    expect(store.readEvents({ after: 0 })).toEqual(before);
    expect(store.listExecutionReservations()[0]?.state).toBe(state);

    store.releaseExecutionReservation({ ...identity, ...(linked ? { nativeCompletion: { dispatchId: "dispatch", state: "succeeded" as const } } : {}) });
    expect(store.pruneCompletedEvents("2026-08-01T00:00:00.000Z")).toBe(2);
    expect(store.getRequest("native")).toEqual(completed);
    expect(store.acceptRequest(input)).toEqual({ accepted: false, request: completed, event: receipt.event });
    expect(store.readEvents({ after: 0 }).compacted).toBe(true);
  });

  it("bounds each SQLite prune batch and preserves another owner's detail and replay receipt", async () => {
    const { store, databasePath } = await fixture("owner", { now: () => new Date("2026-07-01T00:00:00.000Z") });
    const input = { requestId: "old", sessionId: "s", text: "Old work" };
    const receipt = store.acceptRequest(input);
    for (let i = 0; i < 1001; i++) store.appendEvent({ requestId: "old", contextId: null, eventKey: `detail:${i}`, kind: "hq.progress", source: "hq", payload: { text: "Old detail" } });
    const completed = store.completeRequest({ requestId: "old", eventKey: "old:complete", state: "failed", text: "Original failure result" });
    const { store: other } = await fixture("another-owner", { databasePath, now: () => new Date("2026-07-01T00:00:00.000Z") });
    other.acceptRequest({ requestId: "other", sessionId: "other", text: "Other owner" });
    other.completeRequest({ requestId: "other", eventKey: "other:complete", state: "completed", text: "Keep" });
    const otherEvents = other.readEvents({ after: 0 });

    expect(store.pruneCompletedEvents("2026-08-01T00:00:00.000Z")).toBe(1000);
    expect(store.readEvents({ after: 0 }).events.map(e => e.eventKey)).toEqual(["request:old:accepted", "detail:1000", "old:complete"]);
    expect(store.pruneCompletedEvents("2026-08-01T00:00:00.000Z")).toBe(2);
    expect(store.pruneCompletedEvents("2026-08-01T00:00:00.000Z")).toBe(0);
    expect(store.acceptRequest(input)).toEqual({ accepted: false, request: completed, event: receipt.event });
    expect(other.readEvents({ after: 0 })).toEqual(otherEvents);
  });

  it("keeps completion replay idempotent after its display event has been pruned", async () => {
    const { store } = await fixture("owner", { now: () => new Date("2026-07-01T00:00:00.000Z") });
    store.acceptRequest({ requestId: "old", sessionId: "s", text: "Old work" });
    const completion = { requestId: "old", eventKey: "old:complete", state: "completed" as const, text: "Original result", jobId: "original-job" };
    const original = store.completeRequest(completion);
    store.pruneCompletedEvents("2026-08-01T00:00:00.000Z");
    const page = store.readEvents({ after: 0 });

    expect(store.completeRequest(completion)).toEqual(original);
    expect(store.readEvents({ after: 0 })).toEqual(page);
    expect(() => store.completeRequest({ ...completion, text: "Replacement result" })).toThrow(ProgressEventCollisionError);
    expect(() => store.completeRequest({ ...completion, jobId: "different-job" })).toThrow(ProgressEventCollisionError);
    expect(store.getRequest("old")).toEqual(original);
  });

  it("migrates existing assignments and atomically persists replay-safe outcomes with their viewer final", async () => {
    const old = await fixture();
    old.store.acceptRequest({ requestId: "multi", sessionId: "s", text: "Work" });
    old.store.createContext({ contextId: "ctx", originSessionId: "s", title: "Work", objective: "Work" });
    old.store.assignRequestContext({ requestId: "multi", contextId: "ctx", partId: "0", relation: "new", instruction: "Work" });
    old.store.close();
    const legacy = openDatabase(old.databasePath);
    legacy.exec("ALTER TABLE request_contexts DROP COLUMN outcome_json");
    legacy.close();
    const { store } = await fixture("owner", { databasePath: old.databasePath });
    const database = openDatabase(old.databasePath);
    const completion = { requestId: "multi", partId: "0", eventKey: "multi:part:0", outcome: { state: "failed" as const, text: "Original part result" } };
    try {
      database.exec("CREATE TRIGGER fail_assignment BEFORE UPDATE ON request_contexts BEGIN SELECT RAISE(FAIL, 'fixture failure'); END;");
      const before = store.readEvents({ after: 0 });
      expect(() => store.completeAssignment(completion)).toThrow("fixture failure");
      expect(store.readEvents({ after: 0 })).toEqual(before);
      expect(store.listRequestAssignments("multi")[0]?.outcome).toBeUndefined();
      database.exec("DROP TRIGGER fail_assignment");
      store.completeAssignment(completion);
      expect(store.listRequestAssignments("multi")[0]?.outcome).toEqual(completion.outcome);
      expect(store.readEvents({ contextId: "ctx", after: 0 }).events.map(e => e.kind)).toEqual(["request.failed"]);
      expect(store.getRequest("multi")?.state).toBe("queued");
      const final = store.readEvents({ after: 0 });
      store.completeAssignment(completion);
      expect(store.readEvents({ after: 0 })).toEqual(final);
      expect(() => store.completeAssignment({ ...completion, outcome: { state: "completed", text: "Changed result" } })).toThrow();
      store.completeRequest({ requestId: "multi", eventKey: "multi:aggregate", state: "failed", text: "Aggregate" });
      store.pruneCompletedEvents("2099-01-01T00:00:00.000Z");
      store.completeAssignment(completion);
      expect(store.listRequestAssignments("multi")[0]?.outcome).toEqual(completion.outcome);
      expect(store.readEvents({ after: 0 }).events.map(e => e.kind)).toEqual(["request.accepted"]);
    } finally { database.close(); }
  });

  it("keeps a long Unicode result in the snapshot while bounding its display event", async () => {
    const { store } = await fixture();
    const text = "완료".repeat(5_000);
    store.acceptRequest({ requestId: "req_long", sessionId: "session_1", text: "Long result" });
    store.completeRequest({
      requestId: "req_long",
      eventKey: "request:req_long:completed",
      state: "completed",
      text
    });
    expect(store.getRequest("req_long")?.result?.text).toBe(text);
    const event = store.readEvents({ after: 0 }).events.at(-1)!;
    expect(event.kind).toBe("request.completed");
    expect(String(event.payload.text).length).toBeLessThan(text.length);
    expect(Buffer.byteLength(JSON.stringify(event.payload), "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(() => store.completeRequest({
      requestId: "req_long",
      eventKey: "request:req_long:completed",
      state: "completed",
      text: `${text.slice(0, -1)}다`
    })).toThrow(ProgressEventCollisionError);
    expect(store.getRequest("req_long")?.result?.text).toBe(text);
  });

  it("atomically leases one viewer and rejects stale tokens after expiry", async () => {
    let clock = Date.parse("2026-09-08T00:00:00.000Z");
    const now = () => new Date(clock);
    const firstFixture = await fixture("owner", { now, tokenFactory: () => "a".repeat(64) });
    firstFixture.store.createContext({ contextId: "ctx_1", originSessionId: "session_1", title: "One", objective: "One" });
    const secondFixture = await fixture("owner", {
      databasePath: firstFixture.databasePath,
      now,
      tokenFactory: () => "b".repeat(64)
    });

    const first = firstFixture.store.acquireViewerLease({ contextId: "ctx_1", viewerInstanceId: "viewer_1" });
    expect(first).toMatchObject({ acquired: true, viewerInstanceId: "viewer_1", leaseToken: "a".repeat(64) });
    expect(secondFixture.store.acquireViewerLease({ contextId: "ctx_1", viewerInstanceId: "viewer_2" }))
      .toMatchObject({ acquired: false, viewerInstanceId: "viewer_1" });
    expect(() => firstFixture.store.heartbeatViewerLease({
      contextId: "ctx_1",
      viewerInstanceId: "viewer_1",
      leaseToken: "wrong".repeat(16)
    })).toThrow(ViewerLeaseConflictError);

    clock += 20_001;
    const second = secondFixture.store.acquireViewerLease({ contextId: "ctx_1", viewerInstanceId: "viewer_2" });
    expect(second).toMatchObject({ acquired: true, leaseToken: "b".repeat(64) });
    expect(() => firstFixture.store.heartbeatViewerLease({
      contextId: "ctx_1",
      viewerInstanceId: "viewer_1",
      leaseToken: first.leaseToken!
    })).toThrow(ViewerLeaseConflictError);
    expect(secondFixture.store.heartbeatViewerLease({
      contextId: "ctx_1",
      viewerInstanceId: "viewer_2",
      leaseToken: second.leaseToken!
    })).toEqual({ ok: true });
    expect(secondFixture.store.releaseViewerLease({
      contextId: "ctx_1",
      viewerInstanceId: "viewer_2",
      leaseToken: second.leaseToken!
    })).toEqual({ ok: true });
  });

  it("creates the complete nine-table progress schema", async () => {
    const { store, databasePath } = await fixture();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const database = openDatabase(databasePath);
    try {
      const names = (database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name IN (
          'progress_requests','work_contexts','context_agents','execution_reservations',
          'request_contexts','context_projects','context_jobs','progress_events','progress_viewers'
        ) ORDER BY name
      `).all() as Array<{ name: string }>).map(({ name }) => name);
      expect(names).toHaveLength(9);
    } finally {
      database.close();
    }
  });

  it("exports the stable createProgressStore factory alias", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hq-progress-create-"));
    directories.push(directory);
    const store = createProgressStore({
      databasePath: join(directory, "progress.sqlite"),
      ownerKey: "owner"
    });
    stores.push(store);
    expect(store.listContexts()).toEqual([]);
  });
});

it("keeps the native admission schema additive and exposes no raw native table mutations", async () => {
  const { store, databasePath } = await fixture();
  store.acceptRequest({ requestId: "legacy", sessionId: "s", text: "Existing work" });
  const admission = store.createWorkerAdmission({ maxActiveWorkers: 1 });
  expect(admission.snapshot()).toEqual({ active: 0, queued: 0 });
  admission.close(); store.close();
  const reopened = await fixture("owner", { databasePath });
  expect(reopened.store.getRequest("legacy")?.state).toBe("queued");
  expect(reopened.store.createWorkerAdmission({}).snapshot()).toEqual({ active: 0, queued: 0 });
});


it("never prunes native recovery evidence while a completed request still holds an occupied attempt", async () => {
  const { store } = await fixture();
  store.acceptRequest({ requestId: "r", sessionId: "s", text: "Work" });
  store.createContext({ contextId: "c", originSessionId: "s", title: "Work", objective: "Work" });
  store.assignRequestContext({ requestId: "r", contextId: "c", partId: "0", relation: "new", instruction: "Work" });
  store.setContextAgent({ contextId: "c", agentId: "a", generation: 1, currentRequestId: "r", state: "executing" });
  const profile = { agent: "codex" as const, model: "gpt-5.6-sol", reason: "test" };
  const admission = store.createWorkerAdmission({});
  admission.enqueue({ attemptId: "attempt", requestId: "r", contextId: "c", generation: 1, projectId: "p", worktreeId: "p::/tmp/work", objective: "Work", access: "read", resources: [{ resourceKey: "/tmp/work", mode: "read" }], dependsOn: [], profile });
  admission.claimNext(); admission.markUnknown("attempt");
  store.completeRequest({ requestId: "r", eventKey: "r:done", state: "completed", text: "Result recorded before cleanup" });
  expect(store.pruneCompletedEvents("2099-01-01T00:00:00.000Z")).toBe(0);
  expect(store.readEvents({ after: 0 }).events).toHaveLength(2);
  admission.bindReceipt({ attemptId: "attempt", runId: "run", taskId: "task", dispatchId: "dispatch", terminalHandle: "term", worktreeId: "p::/tmp/work", requested: profile, effective: { agent: "codex" } });
  admission.settle("attempt", "dispatch", "succeeded", "retained_idle");
  expect(store.pruneCompletedEvents("2099-01-01T00:00:00.000Z")).toBe(1);
  expect(admission.listAttempts()[0]?.receipt?.dispatchId).toBe("dispatch");
});
