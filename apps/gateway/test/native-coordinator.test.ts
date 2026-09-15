import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeWorkItem, NativeWorkerReceipt } from "@orca-hq/core";
import { openProgressStore } from "../src/progress-store.js";
import { createWorkerAdmission } from "../src/worker-admission.js";
import { createNativeCoordinator, type NativeDelivery } from "../src/native-coordinator.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
function fixture(limit: number | "unlimited" = 10) {
  const dir = mkdtempSync(join(tmpdir(), "native-coordinator-"));
  const store = openProgressStore({ databasePath: join(dir, "db"), ownerKey: "local" });
  const admission = createWorkerAdmission({ store, maxActiveWorkers: limit });
  const work: NativeWorkItem = { attemptId: "a", requestId: "req", contextId: "ctx", generation: 1,
    projectId: "p", worktreeId: "p::/tmp/project", objective: "Analyze project", access: "read",
    resources: [{ resourceKey: "checkout:/tmp/project", mode: "read" }], dependsOn: [],
    profile: { agent: "codex", model: "gpt-5.6-sol", effort: "high", reason: "analysis" } };
  store.acceptRequest({ requestId: "req", sessionId: "s", text: work.objective });
  store.createContext({ contextId: "ctx", originSessionId: "s", title: "Project", objective: work.objective, projectIds: ["p"] });
  store.assignRequestContext({ requestId: "req", contextId: "ctx", partId: "0", relation: "new", instruction: work.objective });
  store.setContextAgent({ contextId: "ctx", agentId: "agent", generation: 1, currentRequestId: "req", state: "running" });
  const receipt = (item: NativeWorkItem): NativeWorkerReceipt => ({ attemptId: item.attemptId, runId: "run", taskId: `task_${item.attemptId}`, dispatchId: `dispatch_${item.attemptId}`, terminalHandle: `term_${item.attemptId}`, worktreeId: item.worktreeId, requested: item.profile, effective: { agent: "codex", model: item.profile.model, effort: "high" } });
  const order: string[] = [];
  const relay = {
    startNativeWork: vi.fn(async (item: NativeWorkItem) => ({ state: "ready" as const, receipt: receipt(item) })),
    getNativeLaunch: vi.fn(() => { throw Error("native_launch_not_found"); }),
    checkDelivery: vi.fn(async () => undefined as NativeDelivery | undefined),
    acknowledgeDelivery: vi.fn(async () => { order.push("ack"); }),
    cleanupNative: vi.fn(async () => { order.push("cleanup"); return { verdict: "retained_idle" as const }; }),
    sendNativeGuidance: vi.fn(async () => ({ messageId: "mail" })),
    replyNativeQuestion: vi.fn(async () => ({ messageId: "reply" })),
  };
  const planner = { plan: vi.fn(async () => [work]) };
  const coordinator = createNativeCoordinator({ planner, admission, relay, store, retentionPolicy: "retain", pollMs: 10 });
  disposers.push(async () => { await coordinator.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = { id: "req-0", text: work.objective, source: "slack" as const, userId: "U123", execution: { contextId: "ctx", requestId: "req", generation: 1, assertActive() {}, async reserve() {}, async beforeNative() {}, async onNative() {} } };
  const done = (id = "a", messageId = "done"): NativeDelivery => ({ runId: "run", deliveryId: `delivery_${messageId}`, messages: [{ id: messageId, type: "worker_done", body: "Analysis finished", taskId: `task_${id}`, dispatchId: `dispatch_${id}`, outcome: "succeeded" }] });
  return { store, admission, work, receipt, relay, planner, coordinator, input, done, order };
}
it("waits for ready identity and settled delivery, then cleans before ack exactly once", async () => {
  const f = fixture();
  let ready!: () => void;
  f.relay.startNativeWork.mockImplementation(async item => { await new Promise<void>(resolve => { ready = resolve; }); return { state: "ready", receipt: f.receipt(item) }; });
  await f.coordinator.start();
  const completed = vi.fn();
  const result = f.coordinator.execute(f.input).then(value => { completed(); return value; });
  await vi.waitFor(() => expect(f.relay.startNativeWork).toHaveBeenCalledOnce());
  expect(f.store.readEvents({ sessionId: "s", after: 0 }).events.map(e => e.kind)).toContain("worker.launching");
  expect(f.store.readEvents({ sessionId: "s", after: 0 }).events.map(e => e.kind)).not.toContain("worker.ready");
  expect(completed).not.toHaveBeenCalled();
  ready();
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  await f.coordinator.processDelivery(f.done());
  expect((await result).text).toContain("Analysis finished");
  await f.coordinator.processDelivery(f.done());
  expect(f.order).toEqual(["cleanup", "ack"]);
  expect(f.admission.snapshot()).toEqual({ active: 0, queued: 0 });
});
it("persists questions, ignores stale completion and retains capacity during uncertain cleanup", async () => {
  const f = fixture();
  await f.coordinator.start();
  void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  f.relay.cleanupNative.mockResolvedValueOnce({ verdict: "unknown", recovery: { dispatchId: "dispatch_a", nextAction: "worker-show" } } as never);
  const delivery = f.done();
  delivery.messages.push({ id: "question", type: "question", body: "Which target?", taskId: "task_a", dispatchId: "dispatch_a" }, { id: "stale", type: "worker_done", body: "stale", taskId: "task_a", dispatchId: "old", outcome: "succeeded" });
  await f.coordinator.processDelivery(delivery);
  expect(f.coordinator.pendingQuestions()).toMatchObject([{ id: "question", body: "Which target?" }]);
  expect(f.admission.snapshot().active).toBe(1);
  expect(f.relay.acknowledgeDelivery).not.toHaveBeenCalled();
  expect(f.store.nativeJournal().get("message", "done")).toMatchObject({ phase: "cleanup_pending" });
  await f.coordinator.processDelivery(delivery);
  expect(f.admission.snapshot().active).toBe(0);
  expect(f.relay.acknowledgeDelivery).toHaveBeenCalledOnce();
});
it.each([10, "unlimited"] as const)("admits fanout through the shared %s limit after planner cleanup", async limit => {
  const f = fixture(limit);
  await f.coordinator.start();
  void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  const unrelated = { ...f.work, attemptId: "unrelated" };
  f.admission.enqueue(unrelated);
  const delivery = f.done();
  delivery.messages[0]!.fanout = Array.from({ length: 12 }, (_, i) => ({ id: `child${i}`, objective: `Analyze ${i}`, access: "read" as const, dependsOn: [] }));
  await f.coordinator.processDelivery(delivery);
  expect(f.admission.listAttempts().find(a => a.item.attemptId === "a")?.state).toBe("settled");
  expect(f.admission.snapshot()).toEqual(limit === 10 ? { active: 10, queued: 3 } : { active: 13, queued: 0 });
  expect(f.order[0]).toBe("cleanup");
  expect(f.relay.startNativeWork.mock.calls.every(([item]) => item.attemptId === "a" || f.admission.listAttempts().some(a => a.item.attemptId === item.attemptId))).toBe(true);
});
it("quarantines an invalid fanout DAG without rejecting the accepted result or stranding the slot", async () => {
  const f = fixture(); await f.coordinator.start(); void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  const delivery = f.done();
  delivery.messages[0]!.fanout = [{ id: "child", objective: "bad", access: "read", dependsOn: ["missing"] }];
  await f.coordinator.processDelivery(delivery);
  expect(f.coordinator.quarantined()).toMatchObject([{ reason: "native_fanout_invalid", detail: { error: expect.stringContaining("unknown_fanout_dependency") } }]);
  // No child is admitted from a rejected DAG, but the parent's own result and slot still settle.
  expect(f.admission.listAttempts().map(a => a.item.attemptId)).toEqual(["a"]);
  expect(f.admission.listAttempts()[0]).toMatchObject({ state: "settled", outcome: "succeeded" });
  expect(f.relay.cleanupNative).toHaveBeenCalledOnce(); expect(f.relay.acknowledgeDelivery).toHaveBeenCalledOnce();
  expect(f.store.readEvents({ sessionId: "s", after: 0 }).events.map(e => e.kind)).toContain("worker.recovery_required");
  expect(f.store.nativeJournal().get("delivery", delivery.deliveryId)).toMatchObject({ phase: "acknowledged" });
});
it("quarantines a poison message beside a valid result and keeps the next delivery flowing", async () => {
  const f = fixture(); await f.coordinator.start(); void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  f.admission.enqueue({ ...f.work, attemptId: "b" });
  await vi.waitFor(() => expect(f.admission.listAttempts().find(a => a.item.attemptId === "b")?.state).toBe("active"));
  // `cancelled` is worker-authored text outside the accepted outcome enum: the batch must survive it.
  const poisoned: NativeDelivery = { runId: "run", deliveryId: "poisoned", messages: [
    { id: "poison", type: "worker_done", body: "stopped early", taskId: "task_a", dispatchId: "dispatch_a", outcome: "cancelled" } as never,
    { id: "done_b", type: "worker_done", body: "B finished", taskId: "task_b", dispatchId: "dispatch_b", outcome: "succeeded" }] };
  await f.coordinator.processDelivery(poisoned);
  expect(f.coordinator.quarantined()).toMatchObject([{ id: "poisoned:0", reason: "native_message_invalid" }]);
  expect(f.admission.listAttempts().find(a => a.item.attemptId === "b")).toMatchObject({ state: "settled", outcome: "succeeded" });
  // The rejected sender keeps its capacity slot and is surfaced for recovery rather than settled.
  expect(f.admission.listAttempts().find(a => a.item.attemptId === "a")?.state).toBe("active");
  expect(f.store.readEvents({ sessionId: "s", after: 0 }).events.filter(e => e.kind === "worker.recovery_required")).toHaveLength(1);
  expect(f.store.nativeJournal().get("delivery", "poisoned")).toMatchObject({ phase: "acknowledged" });
  const polls = f.relay.checkDelivery.mock.calls.length;
  await vi.waitFor(() => expect(f.relay.checkDelivery.mock.calls.length).toBeGreaterThan(polls));
  await f.coordinator.processDelivery(f.done());
  expect(f.admission.listAttempts().find(a => a.item.attemptId === "a")).toMatchObject({ state: "settled", outcome: "succeeded" });
  expect(f.relay.acknowledgeDelivery).toHaveBeenCalledTimes(2);
});
it("restores guidance after restart only for a verified live owned receipt", async () => {
  const f = fixture(); await f.coordinator.start(); void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  f.relay.getNativeLaunch.mockReturnValue({ attemptId: "a", runId: "run", taskId: "task_a", dispatchId: "dispatch_a", receipt: f.receipt(f.work) } as never);
  await f.coordinator.close();
  // A bound receipt only proves the launch happened, so an unproven worker stays uncertain.
  const uncertainAdmission = createWorkerAdmission({ store: f.store });
  const uncertain = createNativeCoordinator({ store: f.store, admission: uncertainAdmission, planner: f.planner, retentionPolicy: "retain",
    relay: { ...f.relay, observeNativeWorker: vi.fn(async () => ({ live: false, recovery: { dispatch: null } })) } });
  await uncertain.start();
  expect(uncertainAdmission.listAttempts()[0]?.state).toBe("unknown");
  expect(uncertainAdmission.snapshot()).toEqual({ active: 1, queued: 0 });
  await expect(uncertain.guidance("task_a", "Keep going", "g")).rejects.toThrow("native_guidance_requires_active_worker");
  await uncertain.close();
  const admission = createWorkerAdmission({ store: f.store });
  const observeNativeWorker = vi.fn(async () => ({ live: true }));
  const restarted = createNativeCoordinator({ store: f.store, admission, planner: f.planner, retentionPolicy: "retain", relay: { ...f.relay, observeNativeWorker } });
  disposers.push(() => restarted.close());
  await restarted.start();
  expect(observeNativeWorker).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: "dispatch_a", taskId: "task_a" }));
  expect(admission.listAttempts()[0]).toMatchObject({ state: "active" });
  expect(await restarted.guidance("task_a", "Keep going", "g")).toMatchObject({ jobId: "task_a" });
  expect(f.relay.startNativeWork).toHaveBeenCalledOnce();
});
it("sends idempotent active guidance as durable mail and rejects stale generation", async () => {
  const f = fixture(); await f.coordinator.start(); void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  await f.coordinator.guidance("task_a", "Include tests", "guidance");
  await f.coordinator.guidance("task_a", "Include tests", "guidance");
  expect(f.relay.sendNativeGuidance).toHaveBeenCalledOnce();
  expect(f.store.nativeJournal().get("guidance", "guidance")).toMatchObject({ delivered: true, dispatchId: "dispatch_a" });
  f.store.setContextAgent({ contextId: "ctx", agentId: "agent", generation: 2, state: "running", currentRequestId: "req" });
  await f.coordinator.processDelivery(f.done());
  expect(f.admission.snapshot().active).toBe(1); expect(f.relay.cleanupNative).not.toHaveBeenCalled();
  await expect(f.coordinator.guidance("task_a", "Do this", "g2")).rejects.toThrow("native_guidance_requires_active_worker");
});
it("restarts from persisted result and question without relaunching, then resumes cleanup and ack", async () => {
  const f = fixture(); await f.coordinator.start(); void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  const delivery = f.done(); delivery.messages.push({ id: "q", type: "question", body: "Which path?", taskId: "task_a", dispatchId: "dispatch_a" });
  f.relay.cleanupNative.mockResolvedValueOnce({ verdict: "unknown" } as never);
  await f.coordinator.processDelivery(delivery);
  await f.coordinator.close();
  const admission = createWorkerAdmission({ store: f.store });
  const restarted = createNativeCoordinator({ store: f.store, admission, relay: f.relay, planner: f.planner, retentionPolicy: "retain" });
  disposers.push(() => restarted.close());
  await restarted.start();
  expect(restarted.pendingQuestions()).toMatchObject([{ id: "q" }]);
  expect(admission.snapshot().active).toBe(1);
  await restarted.processDelivery(delivery);
  expect(admission.snapshot().active).toBe(0);
  expect(f.relay.startNativeWork).toHaveBeenCalledOnce();
  expect(f.relay.acknowledgeDelivery).toHaveBeenCalledOnce();
  await restarted.answerQuestion("q", "src only", "answer");
  expect(restarted.pendingQuestions()).toEqual([]);
});
it("reconciles a request result after restart without executing the planner again", async () => {
  const f = fixture(); await f.coordinator.start(); void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  f.store.updateRequest({ requestId: "req", state: "executing" });
  await f.coordinator.close();
  f.store.recoverInterruptedRequests();
  const admission = createWorkerAdmission({ store: f.store });
  const restarted = createNativeCoordinator({ store: f.store, admission, relay: f.relay, planner: f.planner, retentionPolicy: "retain" });
  disposers.push(() => restarted.close()); await restarted.start();
  await restarted.processDelivery(f.done());
  expect(f.store.getRequest("req")).toMatchObject({ state: "completed", result: { text: "Analysis finished" } });
  expect(f.planner.plan).toHaveBeenCalledOnce(); expect(f.relay.startNativeWork).toHaveBeenCalledOnce();
});
it("replays a crash after result persistence before cleanup, and an ack loss, idempotently", async () => {
  const f = fixture(); await f.coordinator.start(); void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  const delivery = f.done();
  // Durable state at the real crash boundary: accepted result committed, effect not started.
  f.store.nativeJournal().put("delivery", delivery.deliveryId, { delivery, phase: "received" });
  f.store.nativeJournal().put("message", "done", { message: delivery.messages[0], runId: "run", phase: "applied", attemptId: "a" });
  f.relay.acknowledgeDelivery.mockRejectedValueOnce(Error("lost ack"));
  await expect(f.coordinator.processDelivery(delivery)).rejects.toThrow("lost ack");
  expect(f.admission.snapshot().active).toBe(0);
  await f.coordinator.processDelivery(delivery);
  expect(f.store.nativeJournal().get("delivery", delivery.deliveryId)).toMatchObject({ phase: "acknowledged" });
  expect(f.relay.startNativeWork).toHaveBeenCalledOnce();
  expect(f.relay.cleanupNative).toHaveBeenCalledOnce();
});
it("keeps uncertain receipt-free launches occupied across restart without auto-relaunch", async () => {
  const f = fixture(1);
  f.relay.startNativeWork.mockResolvedValueOnce({ state: "recovery_required", attemptId: "a", runId: "run", reason: "lost launch", residualResources: [] } as never);
  await f.coordinator.start();
  expect((await f.coordinator.execute(f.input)).state).toBe("recovery_required");
  await f.coordinator.close();
  const admission = createWorkerAdmission({ store: f.store, maxActiveWorkers: 1 });
  const restarted = createNativeCoordinator({ store: f.store, admission, relay: f.relay, planner: f.planner, retentionPolicy: "retain" });
  disposers.push(() => restarted.close()); await restarted.start();
  admission.enqueue({ ...f.work, attemptId: "next" });
  expect(admission.claimNext()).toBeUndefined();
  expect(admission.snapshot()).toEqual({ active: 1, queued: 1 });
  expect(f.relay.startNativeWork).toHaveBeenCalledOnce();
});
it("returns stop capacity only after exact native stop proof and cleanup", async () => {
  const f = fixture(); await f.coordinator.start(); void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  Object.assign(f.relay, { stopNative: vi.fn(async () => true) });
  f.relay.cleanupNative.mockResolvedValue({ verdict: "released" } as never);
  expect(await f.coordinator.stop("task_a")).toMatchObject({ state: "completed" });
  expect(f.admission.listAttempts()[0]).toMatchObject({ state: "settled", outcome: "stopped", resourceVerdict: "released" });
});
it("unlimited still excludes a conflicting writer and keeps dependency children queued", async () => {
  const f = fixture("unlimited"); await f.coordinator.start(); void f.coordinator.execute(f.input);
  await vi.waitFor(() => expect(f.admission.listAttempts()[0]?.state).toBe("active"));
  f.admission.enqueue({ ...f.work, attemptId: "writer", access: "write", resources: [{ resourceKey: "checkout:/tmp/project", mode: "write" }] });
  expect(f.admission.claimNext()).toBeUndefined();
  expect(f.admission.snapshot()).toEqual({ active: 1, queued: 1 });
});
