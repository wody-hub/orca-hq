import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeWorkItem, NativeWorkerReceipt } from "@orca-hq/core";
import { openProgressStore, type SqliteProgressStore } from "../src/progress-store.js";
import {
  createWorkerAdmission,
  type AuthoritativeNoLaunchProof
} from "../src/worker-admission.js";

const stores: SqliteProgressStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hq-admission-"));
  directories.push(dir);
  const databasePath = join(dir, "progress.sqlite");
  let clock = 1_800_000_000_000;
  const open = () => {
    const store = openProgressStore({ databasePath, ownerKey: "owner", now: () => new Date(clock) });
    stores.push(store);
    return store;
  };
  return { store: open(), open, advance: (ms: number) => { clock += ms; } };
}
function item(store: SqliteProgressStore, id: string, patch: Partial<NativeWorkItem> = {}): NativeWorkItem {
  const work: NativeWorkItem = {
    attemptId: id, requestId: `req_${id}`, contextId: `ctx_${id}`, generation: 1,
    projectId: "project", worktreeId: "project::/tmp/native-work", objective: "Inspect project",
    access: "read", resources: [{ resourceKey: "checkout:/tmp/native-work", mode: "read" }],
    dependsOn: [], profile: { agent: "codex", model: "gpt-5.6-sol", effort: "high", reason: "bounded analysis" },
    ...patch
  };
  store.acceptRequest({ requestId: work.requestId, sessionId: `channel_${id}`, text: "Inspect project" });
  if (!store.getContext(work.contextId)) store.createContext({ contextId: work.contextId, originSessionId: `channel_${id}`, title: id, objective: "Inspect" });
  store.assignRequestContext({ requestId: work.requestId, contextId: work.contextId, partId: "0", relation: "new", instruction: "Inspect" });
  store.setContextAgent({ contextId: work.contextId, agentId: `agent_${work.contextId}`, generation: work.generation, currentRequestId: work.requestId, state: "executing" });
  return work;
}
function receipt(work: NativeWorkItem): NativeWorkerReceipt {
  return { attemptId: work.attemptId, runId: "run_1", taskId: `task_${work.attemptId}`, dispatchId: `dispatch_${work.attemptId}`, terminalHandle: `term_${work.attemptId}`, worktreeId: work.worktreeId, requested: work.profile, effective: { agent: "codex", model: "gpt-5.6-sol", effort: "high" } };
}
function release(admission: ReturnType<typeof createWorkerAdmission>, work: NativeWorkItem) {
  admission.bindReceipt(receipt(work));
  admission.settle(work.attemptId, receipt(work).dispatchId, "succeeded", "released");
}

describe("durable native worker admission", () => {
  it("releases a claimed receipt-free attempt only with an exact authoritative no-launch proof", () => {
    const { store } = fixture();
    const admission = createWorkerAdmission({ store, maxActiveWorkers: 1 });
    const neverStarted = item(store, "never-started");
    const next = item(store, "next");
    admission.enqueue(neverStarted);
    admission.enqueue(next);
    expect(admission.claimNext()?.attemptId).toBe(neverStarted.attemptId);
    expect(admission.assertLaunchAuthorized(neverStarted.attemptId)).toMatchObject({
      attemptId: neverStarted.attemptId,
      worktreeId: neverStarted.worktreeId,
      profile: neverStarted.profile
    });

    const proof: AuthoritativeNoLaunchProof = {
      kind: "orca_authoritative_no_launch",
      attemptId: neverStarted.attemptId,
      launchMutationRequestId: "mutation_worker_start",
      runId: "run_1",
      taskId: "task_never-started",
      worktreeId: neverStarted.worktreeId,
      requested: neverStarted.profile,
      failedStage: "terminal_create",
      observedAt: "2026-09-08T12:00:00.000Z",
      effects: [
        { kind: "worktree", action: "reused", id: neverStarted.worktreeId },
        { kind: "setup", action: "not_applicable", state: "not_applicable" }
      ],
      residualResources: []
    };

    expect(admission.recoverProvenNoLaunch(proof)).toBe(true);
    expect(admission.listAttempts()[0]).toMatchObject({
      state: "settled",
      receipt: null,
      outcome: "failed",
      resourceVerdict: "released",
      noLaunchProof: proof
    });
    expect(admission.snapshot()).toEqual({ active: 0, queued: 1 });
    expect(admission.claimNext()?.attemptId).toBe(next.attemptId);
    expect(() => admission.bindReceipt(receipt(neverStarted)))
      .toThrow("attempt_proven_not_launched");
  });

  it("does not release a claimed attempt for an unverified or mismatched no-launch claim", () => {
    const { store } = fixture();
    const admission = createWorkerAdmission({ store, maxActiveWorkers: 1 });
    const work = item(store, "uncertain");
    admission.enqueue(work);
    admission.claimNext();
    admission.markUnknown(work.attemptId);

    expect(() => admission.recoverProvenNoLaunch({
      kind: "orca_authoritative_no_launch",
      attemptId: work.attemptId,
      launchMutationRequestId: "mutation_worker_start",
      runId: "run_1",
      taskId: "task_uncertain",
      worktreeId: "other::/workspace/other",
      requested: work.profile,
      failedStage: "unknown",
      observedAt: "2026-09-08T12:00:00.000Z",
      effects: [],
      residualResources: []
    })).toThrow("no_launch_proof_mismatch");
    expect(admission.snapshot()).toEqual({ active: 1, queued: 0 });
  });

  it.each([undefined, 12] as const)("claims finite capacity %s then admits exactly one FIFO successor after proven release", (maxActiveWorkers) => {
    const { store } = fixture();
    const admission = createWorkerAdmission({ store, ...(maxActiveWorkers === undefined ? {} : { maxActiveWorkers }) });
    const count = maxActiveWorkers ?? 10;
    const items = Array.from({ length: count + 1 }, (_, i) => item(store, String(i)));
    for (const work of items) admission.enqueue(work);
    const claimed = Array.from({ length: count }, () => admission.claimNext());
    expect(claimed.every(Boolean)).toBe(true);
    expect(admission.claimNext()).toBeUndefined();
    expect(admission.snapshot()).toEqual({ active: count, queued: 1 });
    release(admission, items[0]!);
    expect(admission.claimNext()?.attemptId).toBe(items[count]!.attemptId);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "10"])("rejects invalid capacity %s without acquiring coordinator ownership", (maxActiveWorkers) => {
    const { store } = fixture();
    expect(() => createWorkerAdmission({ store, maxActiveWorkers: maxActiveWorkers as number })).toThrow("maxActiveWorkers");
    expect(createWorkerAdmission({ store }).snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("unlimited removes only capacity waits and keeps resource exclusion", () => {
    const { store } = fixture();
    const admission = createWorkerAdmission({ store, maxActiveWorkers: "unlimited" });
    for (let i = 0; i < 13; i++) admission.enqueue(item(store, String(i)));
    const writer = item(store, "writer", { access: "write", resources: [{ resourceKey: "/tmp/native-work/child", mode: "write" }] });
    admission.enqueue(writer);
    for (let i = 0; i < 13; i++) expect(admission.claimNext()).toBeDefined();
    expect(admission.claimNext()).toBeUndefined();
    expect(admission.snapshot()).toEqual({ active: 13, queued: 1 });
  });

  it("deduplicates normalized identical attempts across channel submit/retry but rejects changed identity", () => {
    const { store } = fixture();
    const admission = createWorkerAdmission({ store });
    const original = item(store, "slack");
    admission.enqueue(original);
    admission.enqueue({ ...original, resources: [{ resourceKey: "/tmp/native-work", mode: "read" }] });
    expect(() => admission.enqueue({ ...original, objective: "Different work" })).toThrow("attempt_collision");
    const retry = item(store, "telegram-retry", { contextId: original.contextId });
    admission.enqueue(retry);
    expect(admission.claimNext()?.attemptId).toBe("slack");
    expect(admission.claimNext()?.attemptId).toBe("telegram-retry");
    expect(admission.snapshot()).toEqual({ active: 2, queued: 0 });
    release(admission, original);
    admission.enqueue(original);
    expect(admission.claimNext()).toBeUndefined();
  });

  it("holds all resources atomically and prevents readers overtaking a blocked writer while allowing unrelated work", () => {
    const { store } = fixture();
    const admission = createWorkerAdmission({ store });
    const holder = item(store, "holder", { resources: [{ resourceKey: "external:db", mode: "write" }] });
    admission.enqueue(holder); admission.claimNext();
    const writer = item(store, "writer", { access: "write", resources: [{ resourceKey: "/tmp/free", mode: "write" }, { resourceKey: "external:db", mode: "write" }] });
    const reader = item(store, "reader", { resources: [{ resourceKey: "/tmp/free/child", mode: "read" }] });
    const unrelated = item(store, "unrelated", { resources: [{ resourceKey: "external:other", mode: "write" }] });
    for (const work of [writer, reader, unrelated]) admission.enqueue(work);
    expect(admission.claimNext()?.attemptId).toBe("unrelated");
    expect(store.listExecutionReservations().filter(r => r.reservationId === "writer")).toHaveLength(0);
    expect(admission.claimNext()).toBeUndefined();
    release(admission, holder);
    expect(admission.claimNext()?.attemptId).toBe("writer");
    expect(admission.claimNext()).toBeUndefined();
    release(admission, writer);
    expect(admission.claimNext()?.attemptId).toBe("reader");
  });

  it("does not let blocked dependencies monopolize a resource ahead of their prerequisite", () => {
    const { store } = fixture();
    const admission = createWorkerAdmission({ store });
    const parent = item(store, "parent");
    admission.enqueue(item(store, "child", { dependsOn: [parent.attemptId], access: "write", resources: [{ resourceKey: "/tmp/native-work", mode: "write" }] }));
    admission.enqueue(parent);
    expect(admission.claimNext()?.attemptId).toBe("parent");
    expect(admission.claimNext()).toBeUndefined();
    release(admission, parent);
    expect(admission.claimNext()?.attemptId).toBe("child");
  });

  it("fences every mutation of an expired/superseded coordinator across two SQLite connections", async () => {
    const f = fixture();
    const secondStore = f.open();
    const first = createWorkerAdmission({ store: f.store, leaseTtlMs: 100 });
    const work = item(f.store, "work");
    first.enqueue(work); first.claimNext(); first.bindReceipt(receipt(work));
    expect(() => createWorkerAdmission({ store: secondStore, leaseTtlMs: 100 })).toThrow("coordinator_owned");
    f.advance(101);
    expect(() => first.heartbeat()).toThrow("coordinator_fenced");
    const second = createWorkerAdmission({ store: secondStore, leaseTtlMs: 100 });
    const mutations = [
      () => first.enqueue(work), () => first.claimNext(), () => first.bindReceipt(receipt(work)),
      () => first.assertLaunchAuthorized(work.attemptId),
      () => first.settle(work.attemptId, receipt(work).dispatchId, "succeeded", "released"),
      () => first.markUnknown(work.attemptId), () => first.beginRelease(work.attemptId, receipt(work).dispatchId),
      () => first.reconcile(work.attemptId, { state: "unknown" }), () => first.finishReconciliation(),
      () => first.heartbeat(), () => first.close()
    ];
    const results = await Promise.allSettled(mutations.map(async mutate => mutate()));
    expect(results.every(result => result.status === "rejected" && String(result.reason).includes("coordinator_fenced"))).toBe(true);
    expect(second.snapshot()).toEqual({ active: 1, queued: 0 });
    second.reconcile(work.attemptId, { state: "active", dispatchId: receipt(work).dispatchId }); second.finishReconciliation();
    expect(second.settle(work.attemptId, receipt(work).dispatchId, "succeeded", "retained_idle")).toBe(true);
  });

  it("reopens above a lowered limit, reconciles every persisted owner before admission, and never evicts workers", () => {
    const f = fixture();
    const first = createWorkerAdmission({ store: f.store, maxActiveWorkers: 12 });
    const items = Array.from({ length: 13 }, (_, i) => item(f.store, String(i)));
    items.forEach(work => first.enqueue(work));
    for (let i = 0; i < 12; i++) { first.claimNext(); first.bindReceipt(receipt(items[i]!)); }
    first.close(); f.store.close();
    const next = createWorkerAdmission({ store: f.open(), maxActiveWorkers: 10 });
    expect(next.snapshot()).toEqual({ active: 12, queued: 1 });
    expect(next.claimNext()).toBeUndefined();
    expect(() => next.finishReconciliation()).toThrow("reconciliation_required");
    for (const work of items.slice(0, 12)) next.reconcile(work.attemptId, { state: "active", dispatchId: receipt(work).dispatchId });
    next.finishReconciliation();
    release(next, items[0]!); release(next, items[1]!);
    expect(next.snapshot()).toEqual({ active: 10, queued: 1 });
    expect(next.claimNext()).toBeUndefined();
    release(next, items[2]!);
    expect(next.claimNext()?.attemptId).toBe("12");
  });

  it("persists launch uncertainty indefinitely and requires matching observations to reopen the restart barrier", () => {
    const f = fixture();
    const first = createWorkerAdmission({ store: f.store, maxActiveWorkers: 1 });
    const work = item(f.store, "lost"); first.enqueue(work); first.claimNext(); first.markUnknown(work.attemptId);
    first.enqueue(item(f.store, "queued"));
    f.advance(86_400_000); f.store.close();
    const next = createWorkerAdmission({ store: f.open(), maxActiveWorkers: 1 });
    expect(next.listAttempts()[0]).toMatchObject({ item: { attemptId: "lost" }, state: "unknown", receipt: null });
    expect(() => next.reconcile("lost", { state: "active", dispatchId: receipt(work).dispatchId })).toThrow("receipt_required");
    next.reconcile("lost", { state: "unknown" }); next.finishReconciliation();
    expect(next.claimNext()).toBeUndefined();
    next.bindReceipt(receipt(work)); release(next, work);
    expect(next.claimNext()?.attemptId).toBe("queued");
  });

  it("refuses receipts before claim, changed dispatch/placement/profile and duplicate terminal ownership", () => {
    const { store } = fixture();
    const admission = createWorkerAdmission({ store });
    const a = item(store, "a"), b = item(store, "b");
    admission.enqueue(a); admission.enqueue(b);
    expect(() => admission.bindReceipt(receipt(a))).toThrow("attempt_not_admitted");
    admission.claimNext(); admission.claimNext();
    expect(() => admission.bindReceipt({ ...receipt(a), worktreeId: "elsewhere" })).toThrow("receipt_mismatch");
    expect(() => admission.bindReceipt({ ...receipt(a), requested: { ...a.profile, model: "other" } })).toThrow("receipt_mismatch");
    admission.bindReceipt(receipt(a)); admission.bindReceipt(receipt(a));
    expect(() => admission.bindReceipt({ ...receipt(a), dispatchId: "stale" })).toThrow("receipt_collision");
    expect(() => admission.bindReceipt({ ...receipt(b), terminalHandle: receipt(a).terminalHandle })).toThrow("terminal_occupied");
    const before = admission.snapshot();
    expect(admission.settle(a.attemptId, "stale", "succeeded", "released")).toBe(false);
    expect(admission.snapshot()).toEqual(before);
  });

  it.each(["unknown", "transferred", "released", "retained_idle"] as const)("settlement verdict %s preserves truthful occupancy and duplicate delivery is idempotent", (verdict) => {
    const { store } = fixture();
    const admission = createWorkerAdmission({ store, maxActiveWorkers: 1 });
    const work = item(store, "work"); admission.enqueue(work); admission.claimNext(); admission.bindReceipt(receipt(work));
    admission.enqueue(item(store, "next"));
    expect(admission.settle(work.attemptId, receipt(work).dispatchId, "succeeded", verdict)).toBe(true);
    admission.settle(work.attemptId, receipt(work).dispatchId, "succeeded", verdict);
    const occupied = verdict === "unknown" || verdict === "transferred";
    expect(admission.snapshot()).toEqual({ active: occupied ? 1 : 0, queued: 1 });
    expect(Boolean(admission.claimNext())).toBe(!occupied);
    if (!occupied) {
      admission.markUnknown(work.attemptId);
      admission.settle(work.attemptId, receipt(work).dispatchId, "succeeded", "unknown");
      expect(admission.snapshot()).toEqual({ active: 1, queued: 0 });
    }
  });

  it("counts release_pending and release_unknown across restart until confirmed retained idle", () => {
    const f = fixture();
    const first = createWorkerAdmission({ store: f.store, maxActiveWorkers: 1 });
    const work = item(f.store, "work"); first.enqueue(work); first.claimNext(); first.bindReceipt(receipt(work));
    expect(first.beginRelease(work.attemptId, "stale")).toBe(false);
    first.beginRelease(work.attemptId, receipt(work).dispatchId);
    expect(first.listAttempts()[0]?.state).toBe("release_pending");
    first.close();
    const next = createWorkerAdmission({ store: f.open(), maxActiveWorkers: 1 });
    next.settle(work.attemptId, receipt(work).dispatchId, "failed", "unknown");
    expect(next.listAttempts()[0]?.state).toBe("release_unknown");
    expect(next.snapshot().active).toBe(1);
    next.reconcile(work.attemptId, { state: "settled", dispatchId: receipt(work).dispatchId, outcome: "failed", resourceVerdict: "retained_idle" });
    next.finishReconciliation();
    expect(next.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("rejects unassigned ownership and stale queued generations without consuming a slot", () => {
    const { store } = fixture();
    const admission = createWorkerAdmission({ store });
    const work = item(store, "work");
    expect(() => admission.enqueue({ ...work, requestId: "missing" })).toThrow();
    expect(() => admission.enqueue({ ...work, generation: 2 })).toThrow();
    admission.enqueue(work);
    store.setContextAgent({ contextId: work.contextId, agentId: "new", generation: 2, currentRequestId: work.requestId, state: "executing" });
    expect(admission.claimNext()).toBeUndefined();
    expect(admission.snapshot()).toEqual({ active: 0, queued: 1 });
  });
});


it("fences normal completion after context generation advances, but exact cleanup reconciliation can release the old attempt", () => {
  const { store } = fixture();
  const admission = createWorkerAdmission({ store });
  const old = item(store, "old"); admission.enqueue(old); admission.claimNext(); admission.bindReceipt(receipt(old));
  const next = item(store, "new", { contextId: old.contextId, generation: 2 }); admission.enqueue(next);
  const before = admission.snapshot();
  expect(admission.settle(old.attemptId, receipt(old).dispatchId, "succeeded", "released")).toBe(false);
  expect(admission.snapshot()).toEqual(before);
  expect(admission.listAttempts()[0]?.outcome).toBeNull();
  expect(() => admission.reconcile(old.attemptId, { state: "settled", dispatchId: "wrong", outcome: "succeeded", resourceVerdict: "released" })).toThrow("reconciliation_dispatch_mismatch");
  admission.reconcile(old.attemptId, { state: "settled", dispatchId: receipt(old).dispatchId, outcome: "succeeded", resourceVerdict: "released" });
  expect(admission.snapshot()).toEqual({ active: 0, queued: 1 });
  expect(store.getRequest(next.requestId)?.state).toBe("queued");
});

it("serializes sibling writers and concurrent retained-terminal reacquisition before launch effects", () => {
  const { store } = fixture();
  const admission = createWorkerAdmission({ store });
  const a = item(store, "a", { resources: [{ resourceKey: "/tmp/siblings", mode: "write" }], access: "write" });
  const b = item(store, "b", { contextId: a.contextId, resources: [{ resourceKey: "/tmp/siblings", mode: "write" }], access: "write" });
  admission.enqueue(a); admission.enqueue(b); expect(admission.claimNext()?.attemptId).toBe("a");
  expect(admission.claimNext()).toBeUndefined(); release(admission, a);
  expect(admission.claimNext()?.attemptId).toBe("b"); release(admission, b);
  const c = item(store, "c", { resumeTerminalHandle: "retained_term" });
  const d = item(store, "d", { resumeTerminalHandle: "retained_term" });
  admission.enqueue(c); admission.enqueue(d);
  expect(admission.claimNext()?.attemptId).toBe("c");
  expect(admission.claimNext()).toBeUndefined();
  admission.bindReceipt({ ...receipt(c), terminalHandle: "retained_term" });
  admission.settle(c.attemptId, receipt(c).dispatchId, "succeeded", "retained_idle");
  expect(admission.claimNext()?.attemptId).toBe("d");
});

it("allows only one scheduler to acquire and claim when two real threads contend on separate SQLite connections", async () => {
  const f = fixture();
  const seed = createWorkerAdmission({ store: f.store, maxActiveWorkers: 1 });
  seed.enqueue(item(f.store, "one")); seed.enqueue(item(f.store, "two")); seed.close();
  const databasePath = join(directories.at(-1)!, "progress.sqlite");
  // Test-only TypeScript loader: exercise current source in isolated threads without rebuilding dist.
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { registerHooks } = require("node:module");
    const { readFileSync, existsSync } = require("node:fs");
    const { pathToFileURL, fileURLToPath } = require("node:url");
    const ts = require("typescript");
    registerHooks({
      resolve(specifier, context, next) {
        if (workerData.aliases[specifier]) return next(pathToFileURL(workerData.aliases[specifier]).href, context);
        if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
          const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
          if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
        }
        return next(specifier, context);
      },
      load(url, context, next) {
        if (!url.endsWith(".ts")) return next(url, context);
        return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText };
      }
    });
    (async () => {
      const { openProgressStore } = await import(workerData.moduleURL);
      const store = openProgressStore({ databasePath: workerData.databasePath, ownerKey: "owner", now: () => new Date(1800000000000) });
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try {
        const admission = store.createWorkerAdmission({ maxActiveWorkers: 1 });
        const claims = [admission.claimNext()?.attemptId, admission.claimNext()?.attemptId];
        parentPort.postMessage({ claims, snapshot: admission.snapshot() });
      } catch (error) { parentPort.postMessage({ error: error.message }); }
      finally { store.close(); }
    })().catch(error => { throw error; });
  `;
  const barrier = new SharedArrayBuffer(4);
  const workers: Worker[] = [];
  let ready = 0;
  try {
    const results = await Promise.all(Array.from({ length: 2 }, () => new Promise<{ claims?: string[]; snapshot?: { active: number; queued: number }; error?: string }>((resolve, reject) => {
      const worker = new Worker(source, { eval: true, workerData: {
        databasePath, barrier, moduleURL: new URL("../src/progress-store.ts", import.meta.url).href,
        aliases: {
          "@orca-hq/core": fileURLToPath(new URL("../../../packages/core/src/index.ts", import.meta.url)),
          "@orca-hq/persistence": fileURLToPath(new URL("../../../packages/persistence/src/index.ts", import.meta.url))
        }
      } });
      workers.push(worker);
      worker.on("error", reject);
      worker.on("exit", code => { if (code !== 0) reject(new Error(`scheduler_thread_exit:${code}`)); });
      worker.on("message", message => {
        if (message.ready) {
          if (++ready === 2) { Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0); }
        } else resolve(message);
      });
    })));
    expect(results.filter(result => result.error)).toEqual([{ error: "coordinator_owned" }]);
    expect(results.find(result => result.claims)).toEqual({ claims: ["one", undefined], snapshot: { active: 1, queued: 1 } });
    expect(seed.snapshot()).toEqual({ active: 1, queued: 1 });
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}, 15_000);

it("keeps a persisted launching attempt behind the restart barrier until exact receipt reconciliation", () => {
  const f = fixture();
  const first = createWorkerAdmission({ store: f.store, maxActiveWorkers: 2 });
  const live = item(f.store, "live"); first.enqueue(live); first.claimNext();
  first.enqueue(item(f.store, "next")); first.close(); f.store.close();
  const second = createWorkerAdmission({ store: f.open(), maxActiveWorkers: 2 });
  expect(second.listAttempts()[0]?.state).toBe("launching");
  expect(second.claimNext()).toBeUndefined();
  second.bindReceipt(receipt(live));
  expect(() => second.reconcile(live.attemptId, { state: "active", dispatchId: "stale" })).toThrow("reconciliation_dispatch_mismatch");
  expect(() => second.finishReconciliation()).toThrow("reconciliation_required");
  second.reconcile(live.attemptId, { state: "active", dispatchId: receipt(live).dispatchId });
  second.finishReconciliation();
  expect(second.claimNext()?.attemptId).toBe("next");
});
