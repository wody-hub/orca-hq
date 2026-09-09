import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createContextRouter } from "../../apps/gateway/src/context-router.js";
import { createExecutionReservations } from "../../apps/gateway/src/execution-reservations.js";
import { startManagedControl } from "../../apps/gateway/src/managed-control.js";
import { createProgressControl } from "../../apps/gateway/src/progress-control.js";
import { createProgressRuntime, type ProgressRuntimeOptions } from "../../apps/gateway/src/progress-runtime.js";
import { openProgressStore } from "../../apps/gateway/src/progress-store.js";
import { createProgressClient } from "../../packages/installer/src/progress-client.js";
import type { CommandJob } from "../../apps/gateway/src/managed-commands.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(execute: ProgressRuntimeOptions["execute"], getJob: ProgressRuntimeOptions["getJob"] = () => undefined, router?: ProgressRuntimeOptions["router"], readJobs?: ProgressRuntimeOptions["readJobs"]) {
  const directory = await mkdtemp(join(tmpdir(), "hq-e2e-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = openProgressStore({ databasePath: join(directory, "progress.sqlite"), ownerKey: "local" });
  const runtime = createProgressRuntime({
    store,
    reservations: createExecutionReservations(store),
    router: router ?? createContextRouter({
      async propose({ request }) {
        return { parts: [{ action: "new", title: request.text, objective: request.text, projectIds: [], text: request.text }] };
      }
    }),
    execute,
    getJob,
    ...(readJobs ? { readJobs } : {}),
    catalog: { async list() { return []; } },
    pollMs: 10
  });
  const socketPath = join(directory, "control.sock");
  const server = await startManagedControl({
    socketPath,
    execute: async () => ({ text: "legacy control remains responsive" }),
    progress: createProgressControl(runtime, { pollMs: 5, heartbeatMs: 20 })
  });
  cleanup.push(async () => {
    await server.stop();
    await runtime.close();
    store.close();
  });
  await runtime.start();
  return { store, runtime, client: createProgressClient({ socketPath, idleTimeoutMs: 1000 }) };
}

it("durably accepts five overlapping executions, queues the sixth, and serializes a followup through the real socket", async () => {
  const gates = Array.from({ length: 7 }, deferred);
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  const test = await fixture(async input => {
    const index = Number(input.text);
    started.push(input.text);
    active += 1;
    peak = Math.max(peak, active);
    await input.onProgress?.(`actual execution ${index}`);
    await gates[index]!.promise;
    active -= 1;
    return { text: `finished ${index}` };
  });
  try {
    for (let index = 0; index < 6; index += 1) {
      await expect(test.client.submitRequest({ requestId: `r_${index}`, sessionId: "s", text: String(index) }))
        .resolves.toMatchObject({ state: "queued" });
    }
    await vi.waitFor(() => expect(started).toHaveLength(5));
    expect(active).toBe(5);
    const first = await test.client.getRequest("r_0");
    await test.client.submitRequest({ requestId: "r_follow", sessionId: "s", text: "6", contextHint: { mode: "continue", contextId: first.contextIds[0]! } });
    await vi.waitFor(() => expect(test.runtime.executor.queued).toBe(2));
    expect((await test.client.listContexts("s"))).toHaveLength(6);
    expect((await test.client.getRequest("r_5")).contextIds).toHaveLength(1);
    expect(started).not.toContain("5");
    expect(started).not.toContain("6");

    gates[1]!.resolve();
    await vi.waitFor(() => expect(started).toContain("5"));
    expect(started).not.toContain("6");
    gates[0]!.resolve();
    await vi.waitFor(() => expect(started).toContain("6"));
    expect(peak).toBe(5);
  } finally {
    gates.forEach(gate => gate.resolve());
  }
  await vi.waitFor(async () => expect((await test.client.getRequest("r_follow")).state).toBe("completed"));
});

it("answers the user's global job lookup over the socket without creating a context or executing an agent", async () => {
  const execute = vi.fn<ProgressRuntimeOptions["execute"]>(async () => { throw new Error("lookup must not execute"); });
  const propose = vi.fn(async () => { throw new Error("exact global lookup must not ask an uninformed model"); });
  const readJobs = vi.fn(async () => ({ text: "최근 관측 작업: task_observed · running" }));
  const test = await fixture(execute, undefined, createContextRouter({ propose }), readJobs);
  const input = { requestId: "inline_job_lookup", sessionId: "s", text: "지금 돌아가고 있는 작업 내용들 리스트업해줘" };
  await test.client.submitRequest(input);
  await vi.waitFor(async () => expect((await test.client.getRequest(input.requestId)).state).toBe("completed"));
  const result = await test.client.getRequest(input.requestId);
  expect(result.result?.text).toBe("최근 관측 작업: task_observed · running");
  expect(result.contextIds).toEqual([]);
  expect(await test.client.listContexts("s")).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
  expect(readJobs).toHaveBeenCalledOnce();
  expect(test.runtime.executor.activeContexts).toBe(0);
  expect(test.store.readEvents({ sessionId: "s", after: 0 }).events.some(event => event.kind === "context.assigned" || event.kind === "agent.started")).toBe(false);
  await test.client.submitRequest(input);
  expect(readJobs).toHaveBeenCalledOnce();
});

it("retains native work and checkout ownership until terminal evidence allows the waiting context to proceed", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "hq-checkout-"));
  cleanup.push(() => rm(checkout, { recursive: true, force: true }));
  const now = new Date().toISOString();
  let nativeJob: CommandJob = {
    id: "job_native", projectId: "p", projectName: "isolated fixture", prompt: "work",
    state: "running", worktreePath: checkout, createdAt: now, updatedAt: now
  };
  const acquired: string[] = [];
  const test = await fixture(async input => {
    await input.execution!.reserve([{ resourceKey: checkout, mode: "write" }]);
    acquired.push(input.text);
    if (input.text === "first") {
      await input.execution!.beforeNative();
      await input.execution!.onNative(nativeJob.id);
      return { text: "native worker continues", jobId: nativeJob.id };
    }
    return { text: "second acquired after native completion" };
  }, () => nativeJob);
  try {
    await test.client.submitRequest({ requestId: "native_first", sessionId: "s", text: "first" });
    await vi.waitFor(async () => expect((await test.client.getRequest("native_first")).state).toBe("completed"));
    expect(test.runtime.executor.activeContexts).toBe(1);
    await test.client.submitRequest({ requestId: "native_second", sessionId: "s", text: "second" });
    await vi.waitFor(() => {
      const events = test.store.readEvents({ after: 0, sessionId: "s" }).events;
      expect(events.some(event => event.kind === "agent.waiting" && event.payload.reason === "resources")).toBe(true);
    });
    expect(acquired).toEqual(["first"]);
    nativeJob = { ...nativeJob, state: "recovery_required", updatedAt: new Date(Date.now() + 1).toISOString() };
    await test.runtime.notify(nativeJob);
    expect(test.store.listExecutionReservations().some(reservation => reservation.state === "recovery_required")).toBe(true);
    expect(acquired).toEqual(["first"]);
    nativeJob = { ...nativeJob, state: "succeeded", updatedAt: new Date(Date.now() + 2).toISOString() };
    await test.runtime.notify(nativeJob);
    await vi.waitFor(async () => expect((await test.client.getRequest("native_second")).state).toBe("completed"));
    expect(acquired).toEqual(["first", "second"]);
    expect(test.store.listExecutionReservations().every(reservation => reservation.state === "released")).toBe(true);
  } finally {
    nativeJob = { ...nativeJob, state: "succeeded" };
    await test.runtime.notify(nativeJob);
  }
});

it("replays persisted progress after viewer disconnect without resubmitting or cancelling execution", async () => {
  const gate = deferred();
  const execute = vi.fn<ProgressRuntimeOptions["execute"]>(async input => {
    await input.onProgress?.("검토 진행 중");
    await gate.promise;
    return { text: "검토 완료" };
  });
  const test = await fixture(execute);
  const input = { requestId: "r_replay", sessionId: "s", text: "review" };
  try {
    await test.client.submitRequest(input);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const status = await test.client.getRequest(input.requestId);
    const contextId = status.contextIds[0]!;
    const lease = await test.client.acquireViewerLease(contextId, "viewer_a");
    expect(lease.acquired).toBe(true);
    expect((await test.client.acquireViewerLease(contextId, "viewer_b")).acquired).toBe(false);
    let cursor = 0;
    for await (const frame of test.client.streamEvents({ contextId, after: 0 })) {
      if ("seq" in frame) cursor = frame.seq;
      if (frame.kind === "hq.progress") break;
    }
    await test.client.releaseViewerLease(contextId, { viewerInstanceId: "viewer_a", leaseToken: lease.leaseToken! });
    await test.client.submitRequest(input);
    expect(execute).toHaveBeenCalledOnce();
    expect((await test.client.getRequest(input.requestId)).state).toBe("executing");
    gate.resolve();
    await vi.waitFor(async () => expect((await test.client.getRequest(input.requestId)).state).toBe("completed"));
    expect(test.store.readEvents({ contextId, after: cursor }).events.some(event => event.kind === "request.completed")).toBe(true);
    const replayed: number[] = [];
    for await (const frame of test.client.streamEvents({ contextId, after: cursor })) {
      if ("seq" in frame) replayed.push(frame.seq);
      if (frame.kind === "request.completed") break;
    }
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every(seq => seq > cursor)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    await expect(test.client.submitRequest({ ...input, text: "different instruction" })).rejects.toMatchObject({ status: 409 });
  } finally {
    gate.resolve();
  }
});

it("reports one model failure without changing another context's execution or successful result", async () => {
  const gate = deferred();
  const test = await fixture(async input => {
    if (input.text === "fail") return { text: "model connection failed", state: "failed" };
    await gate.promise;
    return { text: "independent success" };
  });
  try {
    await test.client.submitRequest({ requestId: "isolated_good", sessionId: "s", text: "good" });
    await vi.waitFor(async () => expect((await test.client.getRequest("isolated_good")).state).toBe("executing"));
    await test.client.submitRequest({ requestId: "isolated_bad", sessionId: "s", text: "fail" });
    await vi.waitFor(async () => expect((await test.client.getRequest("isolated_bad")).state).toBe("failed"));
    expect((await test.client.getRequest("isolated_good")).state).toBe("executing");
    gate.resolve();
    await vi.waitFor(async () => expect((await test.client.getRequest("isolated_good")).result?.text).toBe("independent success"));
    const bad = await test.client.getRequest("isolated_bad");
    expect((await test.client.getContext(bad.contextIds[0]!)).state).toBe("failed");
  } finally {
    gate.resolve();
  }
});

it("keeps a long Korean result and duplicate-request identity after completed detail is compacted", async () => {
  const resultText = "검토 결과입니다. ".repeat(1000);
  const execute = vi.fn(async () => ({ text: resultText }));
  const test = await fixture(execute);
  const input = { requestId: "long_result", sessionId: "s", text: "long report" };
  await test.client.submitRequest(input);
  await vi.waitFor(async () => expect((await test.client.getRequest(input.requestId)).state).toBe("completed"));
  expect((await test.client.getRequest(input.requestId)).result?.text).toBe(resultText);
  test.store.pruneCompletedEvents(new Date(Date.now() + 1000).toISOString());
  await expect(test.client.submitRequest(input)).resolves.toMatchObject({ requestId: input.requestId });
  expect((await test.client.getRequest(input.requestId)).state).toBe("completed");
  expect(execute).toHaveBeenCalledOnce();
});

it("keeps multipart context outcomes separate and returns the aggregate only after every part settles", async () => {
  const gate = deferred();
  const test = await fixture(async input => {
    if (input.text.includes("bad part")) return { text: "failed part result", state: "failed" };
    await gate.promise;
    return { text: "successful part result" };
  }, undefined, createContextRouter({
    async propose() {
      return { parts: [
        { action: "new", title: "good", objective: "good", projectIds: [], text: "good part" },
        { action: "new", title: "bad", objective: "bad", projectIds: [], text: "bad part" }
      ] };
    }
  }));
  try {
    await test.client.submitRequest({ requestId: "multipart", sessionId: "s", text: "two independent parts" });
    await vi.waitFor(async () => expect((await test.client.listContexts("s")).find(context => context.title === "bad")?.state).toBe("failed"));
    expect((await test.client.getRequest("multipart")).state).toBe("executing");
    expect(test.store.readEvents({ sessionId: "s", after: 0 }).events.filter(event => event.contextId === null && ["request.completed", "request.failed", "recovery.required"].includes(event.kind))).toHaveLength(0);
    gate.resolve();
    await vi.waitFor(async () => expect((await test.client.getRequest("multipart")).state).toBe("failed"));
    const contexts = await test.client.listContexts("s");
    const good = contexts.find(context => context.title === "good")!;
    const bad = contexts.find(context => context.title === "bad")!;
    const finals = (contextId: string) => test.store.readEvents({ contextId, after: 0 }).events.filter(event => ["request.completed", "request.failed", "recovery.required"].includes(event.kind));
    expect(finals(good.contextId).map(event => event.kind)).toEqual(["request.completed"]);
    expect(finals(bad.contextId).map(event => event.kind)).toEqual(["request.failed"]);
    const result = (await test.client.getRequest("multipart")).result!.text;
    expect(result).toContain("successful part result");
    expect(result).toContain("failed part result");
    expect(result.indexOf("successful part result")).toBeLessThan(result.indexOf("failed part result"));
  } finally {
    gate.resolve();
  }
});
