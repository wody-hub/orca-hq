import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect, vi } from "vitest";
import { openProgressStore } from "../src/progress-store.js";
import { createExecutionReservations } from "../src/execution-reservations.js";
import { createContextRouter } from "../src/context-router.js";
import { createProgressRuntime } from "../src/progress-runtime.js";
import type {
  CommandJob,
  ManagedCommandInput,
} from "../src/managed-commands.js";
it("returns observed global job content inline without creating a context or using an executor slot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-global-jobs-"));
  const store = openProgressStore({
    databasePath: join(directory, "progress.sqlite"),
    ownerKey: "local",
  });
  const execute = vi.fn(async () => ({ text: "fabricated" }));
  const readJobs = vi.fn(async () => ({
    text: "현재 활성 작업 1개\n작업 task_live · GH · 실행 중",
  }));
  const runtime = createProgressRuntime({
    store,
    reservations: createExecutionReservations(store),
    catalog: { list: async () => [] },
    getJob: () => undefined,
    router: createContextRouter({
      propose: async () => ({ parts: [], reply: "작업 정보가 없습니다." }),
    }),
    execute,
    readJobs,
  });
  try {
    await runtime.start();
    runtime.submit({
      requestId: "global-jobs",
      sessionId: "s",
      text: "지금 돌아가고 있는 작업 내용들 리스트업해줘",
    });
    await vi.waitFor(() =>
      expect(store.getRequest("global-jobs")?.state).toBe("completed"),
    );
    expect(store.getRequest("global-jobs")?.result?.text).toContain(
      "작업 task_live · GH · 실행 중",
    );
    expect(readJobs).toHaveBeenCalledOnce();
    expect(readJobs).toHaveBeenCalledWith("global-jobs");
    expect(execute).not.toHaveBeenCalled();
    expect(store.listContexts()).toEqual([]);
    expect(store.listRequestAssignments("global-jobs")).toEqual([]);
    expect(runtime.executor.activeContexts).toBe(0);
    expect(
      runtime.submit({
        requestId: "global-jobs",
        sessionId: "s",
        text: "지금 돌아가고 있는 작업 내용들 리스트업해줘",
      }),
    ).toMatchObject({ accepted: false });
    expect(readJobs).toHaveBeenCalledOnce();
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("preserves an observed empty global job list as a successful lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-global-empty-"));
  const store = openProgressStore({
    databasePath: join(directory, "progress.sqlite"),
    ownerKey: "local",
  });
  const runtime = createProgressRuntime({
    store,
    reservations: createExecutionReservations(store),
    catalog: { list: async () => [] },
    getJob: () => undefined,
    router: createContextRouter({ propose: async () => ({ parts: [] }) }),
    execute: async () => ({ text: "must not execute" }),
    readJobs: async () => ({
      text: "현재 활성 작업 0개 (마지막 관찰 스냅샷 기준)",
    }),
  });
  try {
    await runtime.start();
    runtime.submit({
      requestId: "global-empty",
      sessionId: "s",
      text: "지금 돌아가고 있는 작업 내용들 리스트업해줘",
    });
    await vi.waitFor(() =>
      expect(store.getRequest("global-empty")?.state).toBe("completed"),
    );
    expect(store.getRequest("global-empty")?.result?.text).toContain(
      "현재 활성 작업 0개",
    );
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("reports global job lookup failures as unavailable instead of an empty list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-global-error-"));
  const store = openProgressStore({
    databasePath: join(directory, "progress.sqlite"),
    ownerKey: "local",
  });
  const runtime = createProgressRuntime({
    store,
    reservations: createExecutionReservations(store),
    catalog: { list: async () => [] },
    getJob: () => undefined,
    router: createContextRouter({ propose: async () => ({ parts: [] }) }),
    execute: async () => ({ text: "must not execute" }),
    readJobs: async () => {
      throw new Error("private cache diagnostic");
    },
  });
  try {
    await runtime.start();
    runtime.submit({
      requestId: "global-error",
      sessionId: "s",
      text: "지금 돌아가고 있는 작업 내용들 리스트업해줘",
    });
    await vi.waitFor(() =>
      expect(store.getRequest("global-error")?.state).toBe("failed"),
    );
    const text = store.getRequest("global-error")?.result?.text ?? "";
    expect(text).toContain("작업 목록을 조회하지 못했습니다");
    expect(text).not.toContain("0개");
    expect(text).not.toContain("private cache diagnostic");
    expect(store.listContexts()).toEqual([]);
    expect(runtime.executor.activeContexts).toBe(0);
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("holds real checkout reservation until native completion and prevents stale completion releasing another request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-runtime-"));
  const store = openProgressStore({
    databasePath: join(directory, "progress.sqlite"),
    ownerKey: "local",
  });
  const jobs = new Map<string, CommandJob>();
  let count = 0;
  const runtime = createProgressRuntime({
    store,
    reservations: createExecutionReservations(store),
    router: createContextRouter({
      propose: async ({ request }) => ({
        parts: [
          {
            action: "new",
            title: request.text,
            objective: request.text,
            projectIds: ["p"],
            text: request.text,
          },
        ],
      }),
    }),
    catalog: {
      list: async () => [
        {
          id: "p",
          name: "P",
          absolutePath: directory,
          aliases: [],
          enabled: true,
          sensitivePaths: [],
          setupPolicy: "inherit",
        },
      ],
    },
    getJob: (id) => jobs.get(id),
    execute: async (input) => {
      await input.execution!.beforeNative();
      await input.execution!.reserve([
        { resourceKey: directory, mode: "write" },
      ]);
      const id = "job" + ++count;
      const job = {
        id,
        projectId: "p",
        projectName: "P",
        prompt: "work",
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      jobs.set(id, job);
      await input.execution!.onNative(id);
      return { text: "native running", jobId: id };
    },
  });
  try {
    await runtime.start();
    runtime.submit({ requestId: "a", sessionId: "s", text: "A" });
    await vi.waitFor(() =>
      expect(store.getRequest("a")?.state).toBe("completed"),
    );
    runtime.submit({ requestId: "b", sessionId: "s", text: "B" });
    await vi.waitFor(() =>
      expect(store.getRequest("b")?.contextIds).toHaveLength(1),
    );
    expect(count).toBe(1);
    const first = jobs.get("job1")!;
    const completed = {
      ...first,
      state: "succeeded",
      updatedAt: new Date().toISOString(),
    };
    jobs.set(first.id, completed);
    await runtime.notify(completed);
    await vi.waitFor(() => expect(count).toBe(2));
    await vi.waitFor(() =>
      expect(store.getRequest("b")?.state).toBe("completed"),
    );
    await runtime.notify(completed);
    expect(
      store
        .listExecutionReservations()
        .filter((r) => r.requestId === "b" && r.state === "acquired"),
    ).toHaveLength(1);
    expect(runtime.executor.activeContexts).toBe(1);
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("preserves clarification source and resolves only a model-validated pending answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-question-"));
  const store = openProgressStore({
    databasePath: join(directory, "progress.sqlite"),
    ownerKey: "local",
  });
  const execute = vi.fn(async (_input: ManagedCommandInput) => ({
    text: "done",
  }));
  const runtime = createProgressRuntime({
    store,
    reservations: createExecutionReservations(store),
    catalog: { list: async () => [] },
    getJob: () => undefined,
    execute,
    router: createContextRouter({
      propose: async ({ request }) =>
        request.requestId === "a"
          ? { parts: [], question: "API를 검토할까요?" }
          : {
              parts: [
                {
                  action: "new",
                  title: "API",
                  objective: "review",
                  projectIds: [],
                  text: "검토",
                },
              ],
              answersRequestId: "a",
            },
    }),
  });
  try {
    await runtime.start();
    runtime.submit({
      requestId: "a",
      sessionId: "s",
      text: "수정하지 말고 검토",
    });
    await vi.waitFor(() =>
      expect(store.getRequest("a")?.state).toBe("awaiting_input"),
    );
    runtime.submit({ requestId: "b", sessionId: "s", text: "네" });
    await vi.waitFor(() =>
      expect(store.getRequest("b")?.state).toBe("completed"),
    );
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining("수정하지 말고 검토"),
    });
    expect(store.getRequest("a")?.state).toBe("completed");
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("stops one model turn through the control route while another context remains active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-stop-"));
  const store = openProgressStore({
    databasePath: join(directory, "progress.sqlite"),
    ownerKey: "local",
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runtime = createProgressRuntime({
    store,
    reservations: createExecutionReservations(store),
    catalog: { list: async () => [] },
    getJob: () => undefined,
    router: createContextRouter({
      propose: async ({ request }) => ({
        parts: [
          {
            action: "new",
            title: request.text,
            objective: request.text,
            projectIds: [],
            text: request.text,
          },
        ],
      }),
    }),
    execute: async (input) => {
      if (input.text === "A")
        await new Promise<void>((resolve) =>
          input.signal!.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      else await gate;
      return { text: "done" };
    },
  });
  try {
    await runtime.start();
    runtime.submit({ requestId: "a", sessionId: "s", text: "A" });
    runtime.submit({ requestId: "b", sessionId: "s", text: "B" });
    await vi.waitFor(() =>
      expect(store.getRequest("b")?.state).toBe("executing"),
    );
    const contextId = store.getRequest("a")!.contextIds[0]!;
    runtime.submit({
      requestId: "stop",
      sessionId: "s",
      text: "/stop",
      contextHint: { mode: "continue", contextId },
    });
    await vi.waitFor(() =>
      expect(store.getRequest("stop")?.state).toBe("completed"),
    );
    await vi.waitFor(() => expect(store.getRequest("a")?.state).toBe("failed"));
    expect(store.getRequest("b")?.state).toBe("executing");
    release();
    await vi.waitFor(() =>
      expect(store.getRequest("b")?.state).toBe("completed"),
    );
  } finally {
    release();
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("keeps native execution and matching dispatch reservation alive after its model fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-native-failure-"));
  const store = openProgressStore({
    databasePath: join(directory, "progress.sqlite"),
    ownerKey: "local",
  });
  let job: CommandJob | undefined;
  const runtime = createProgressRuntime({
    store,
    reservations: createExecutionReservations(store),
    catalog: { list: async () => [] },
    getJob: () => job,
    router: createContextRouter({
      propose: async () => ({
        parts: [
          {
            action: "new",
            title: "work",
            objective: "work",
            projectIds: [],
            text: "work",
          },
        ],
      }),
    }),
    execute: async (input) => {
      await input.execution!.beforeNative();
      await input.execution!.reserve([
        { resourceKey: directory, mode: "write" },
      ]);
      job = {
        id: "job",
        dispatchId: "dispatch",
        execution: {
          contextId: input.execution!.contextId,
          requestId: input.execution!.requestId,
          generation: input.execution!.generation,
        },
        projectId: "p",
        projectName: "P",
        prompt: "work",
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await input.execution!.onNative(job.id);
      return {
        text: "Model disconnected; worker retained",
        state: "recovery_required",
      };
    },
  });
  try {
    await runtime.start();
    runtime.submit({ requestId: "r", sessionId: "s", text: "work" });
    await vi.waitFor(() =>
      expect(store.getRequest("r")?.state).toBe("recovery_required"),
    );
    const contextId = store.getRequest("r")!.contextIds[0]!;
    expect(store.getContext(contextId)?.state).toBe("worker_running");
    expect(runtime.executor.activeContexts).toBe(1);
    expect(store.listExecutionReservations()[0]?.nativeDispatchId).toBe(
      "dispatch",
    );
    job = { ...job!, state: "succeeded", updatedAt: new Date().toISOString() };
    await runtime.notify(job);
    expect(runtime.executor.activeContexts).toBe(0);
    expect(store.listExecutionReservations()[0]?.state).toBe("released");
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("resumes an assigned but unstarted queued part after restart without asking the model to reroute it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-assigned-restart-"));
  const databasePath = join(directory, "progress.sqlite");
  let store = openProgressStore({ databasePath, ownerKey: "local" });
  store.acceptRequest({ requestId: "r", sessionId: "s", text: "original" });
  store.claimNextRequest("old-router");
  store.createContext({
    contextId: "fixed",
    originSessionId: "s",
    title: "Fixed context",
    objective: "fixed",
  });
  store.assignRequestContext({
    requestId: "r",
    partId: "0",
    contextId: "fixed",
    relation: "new",
    instruction: "durably assigned instruction; preserve constraints",
  });
  store.close();
  store = openProgressStore({ databasePath, ownerKey: "local" });
  const propose = vi.fn(async () => ({
    parts: [],
    question: "must not be called",
  }));
  const execute = vi.fn(async (_input: ManagedCommandInput) => ({
    text: "done",
  }));
  const runtime = createProgressRuntime({
    store,
    reservations: createExecutionReservations(store),
    router: createContextRouter({ propose }),
    catalog: { list: async () => [] },
    getJob: () => undefined,
    execute,
  });
  try {
    await runtime.start();
    await vi.waitFor(() =>
      expect(store.getRequest("r")?.state).toBe("completed"),
    );
    expect(propose).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "context:fixed",
      text: "durably assigned instruction; preserve constraints",
    });
    expect(store.getRequest("r")?.contextIds).toEqual(["fixed"]);
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function retentionFixture() {
  const directory = await mkdtemp(join(tmpdir(), "progress-retention-"));
  const databasePath = join(directory, "progress.sqlite");
  const store = openProgressStore({ databasePath, ownerKey: "local" });
  let executions = 0;
  const runtime = createProgressRuntime({
    store,
    reservations: createExecutionReservations(store),
    catalog: { list: async () => [] },
    getJob: () => undefined,
    pollMs: 24 * 60 * 60 * 1000,
    router: createContextRouter({
      propose: async ({ request }) => ({ parts: [{ action: "new", title: request.text, objective: request.text, projectIds: [], text: request.text }] }),
    }),
    execute: async () => { executions++; return { text: "Executed exactly once" }; },
  });
  function seed(requestId: string, occurredAt: string) {
    store.acceptRequest({ requestId, sessionId: "retention", text: requestId });
    store.completeRequest({ requestId, eventKey: `${requestId}:complete`, state: "completed", text: `Original ${requestId}`, occurredAt });
  }
  return {
    store, runtime, databasePath, seed,
    executions: () => executions,
    async close() { await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

it("prunes completed detail older than 30 days at startup and hourly, and stops maintenance on close", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
  const f = await retentionFixture();
  const keys = () => f.store.readEvents({ after: 0 }).events.map(e => e.eventKey);
  try {
    f.seed("expired", "2026-08-08T23:59:59.999Z");
    f.seed("boundary", "2026-08-09T00:00:00.000Z");
    f.seed("recent", "2026-09-07T00:00:00.000Z");
    await f.runtime.start();
    expect(keys()).not.toContain("expired:complete");
    expect(keys()).toContain("boundary:complete");
    expect(keys()).toContain("recent:complete");
    expect(f.store.getRequest("expired")?.result?.text).toBe("Original expired");
    expect(f.runtime.submit({ requestId: "expired", sessionId: "retention", text: "expired" })).toMatchObject({ accepted: false });
    await f.runtime.start();
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(keys()).toContain("boundary:complete");
    await vi.advanceTimersByTimeAsync(1);
    expect(keys()).not.toContain("boundary:complete");
    expect(keys()).toContain("recent:complete");
    expect(f.executions()).toBe(0);
    await f.runtime.close();
    f.seed("after-close", "2026-07-01T00:00:00.000Z");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(keys()).toContain("after-close:complete");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await f.close();
    vi.useRealTimers();
  }
});

it("rolls back a failed SQLite retention sweep without failing or replaying execution, then retries next hour", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
  const f = await retentionFixture();
  const { openDatabase } = await import("@orca-hq/persistence");
  const database = openDatabase(f.databasePath);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    f.seed("expired", "2026-07-01T00:00:00.000Z");
    database.exec(`CREATE TRIGGER fail_retention BEFORE DELETE ON progress_events BEGIN SELECT RAISE(FAIL, 'private storage diagnostic'); END;`);
    await f.runtime.start();
    expect(f.store.readEvents({ after: 0 }).compacted).toBe(false);
    expect(f.store.readEvents({ after: 0 }).events.some(e => e.eventKey === "expired:complete")).toBe(true);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private storage diagnostic");
    f.runtime.submit({ requestId: "fresh", sessionId: "retention", text: "New execution" });
    await vi.waitFor(() => expect(f.store.getRequest("fresh")?.state).toBe("completed"));
    expect(f.executions()).toBe(1);
    expect(f.store.getRequest("fresh")?.result?.text).toBe("Executed exactly once");
    database.exec("DROP TRIGGER fail_retention");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.store.readEvents({ after: 0 }).events.some(e => e.eventKey === "expired:complete")).toBe(false);
    expect(f.store.readEvents({ after: 0 }).compacted).toBe(true);
    expect(f.executions()).toBe(1);
    expect(f.store.getRequest("expired")?.result?.text).toBe("Original expired");
  } finally {
    warning.mockRestore();
    database.close();
    await f.close();
    vi.useRealTimers();
  }
});

it("retains old completed HQ detail through startup and hourly maintenance while native ownership is uncertain", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
  const f = await retentionFixture();
  try {
    f.seed("native", "2026-07-01T00:00:00.000Z");
    const identity = { requestId: "native", contextId: "native-context", generation: 1, reservationId: "native-reservation" };
    f.store.createContext({ contextId: identity.contextId, originSessionId: "retention", title: "Native", objective: "Native work" });
    f.store.assignRequestContext({ ...identity, partId: "part", relation: "new", instruction: "Native work" });
    f.store.setContextAgent({ ...identity, agentId: "agent", currentRequestId: "native", state: "running" });
    f.store.tryReserveExecution({ ...identity, agentId: "agent", resources: [{ resourceKey: "checkout:/tmp/native", mode: "write" }] });
    f.store.linkReservationDispatch({ ...identity, nativeDispatchId: "native-dispatch" });
    await f.runtime.start();
    expect(f.store.listExecutionReservations()[0]?.state).toBe("recovery_required");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.store.readEvents({ after: 0 }).events.some(e => e.eventKey === "native:complete")).toBe(true);
    expect(f.store.readEvents({ after: 0 }).compacted).toBe(false);
    f.store.releaseExecutionReservation({ ...identity, nativeCompletion: { dispatchId: "native-dispatch", state: "succeeded" } });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.store.readEvents({ after: 0 }).events.some(e => e.eventKey === "native:complete")).toBe(false);
    expect(f.store.getRequest("native")?.result?.text).toBe("Original native");
    expect(f.executions()).toBe(0);
  } finally {
    await f.close();
    vi.useRealTimers();
  }
});

it.each(["returned failure", "thrown failure"])("settles each multipart outcome durably before its sibling and aggregates in assignment order (%s)", async (failureMode) => {
  const directory = await mkdtemp(join(tmpdir(), "progress-multipart-"));
  const databasePath = join(directory, "progress.sqlite");
  const store = openProgressStore({ databasePath, ownerKey: "local" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = createProgressRuntime({
    store, reservations: createExecutionReservations(store), catalog: { list: async () => [] }, getJob: () => undefined,
    router: createContextRouter({ propose: async () => ({ parts: [
      { action: "new", title: "good", objective: "good", projectIds: [], text: "good part" },
      { action: "new", title: "bad", objective: "bad", projectIds: [], text: "bad part" },
    ] }) }),
    execute: async input => {
      if (input.text.endsWith("bad part")) {
        if (failureMode === "thrown failure") throw new Error("private model diagnostic");
        return { text: "failed part result", state: "failed" };
      }
      await gate;
      return { text: "successful part result" };
    },
  });
  try {
    await runtime.start();
    runtime.submit({ requestId: "multi", sessionId: "s", text: "Do both; never edit files" });
    await vi.waitFor(() => expect(store.listContexts().find(c => c.title === "bad")?.state).toBe("failed"));
    const bad = store.listContexts().find(c => c.title === "bad")!;
    expect(store.getRequest("multi")?.state).toBe("executing");
    expect(store.readEvents({ contextId: bad.contextId, after: 0 }).events.filter(e => ["request.completed", "request.failed", "recovery.required"].includes(e.kind)).map(e => e.kind)).toEqual(["request.failed"]);
    const reopened = openProgressStore({ databasePath, ownerKey: "local" });
    try { expect(reopened.listRequestAssignments("multi")[1]).toMatchObject({ outcome: { state: "failed" } }); }
    finally { reopened.close(); }
    expect(store.readEvents({ after: 0 }).events.filter(e => e.contextId === null && ["request.completed", "request.failed", "recovery.required"].includes(e.kind))).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(store.getRequest("multi")?.state).toBe("failed"));
    const good = store.listContexts().find(c => c.title === "good")!;
    expect(store.readEvents({ contextId: good.contextId, after: 0 }).events.filter(e => ["request.completed", "request.failed", "recovery.required"].includes(e.kind)).map(e => e.kind)).toEqual(["request.completed"]);
    const text = store.getRequest("multi")!.result!.text;
    expect(text).not.toContain("private model diagnostic");
    expect(text.indexOf("successful part result")).toBeLessThan(text.indexOf(failureMode === "returned failure" ? "failed part result" : "업무 실행에 실패했습니다"));
    expect(store.readEvents({ after: 0 }).events.filter(e => e.contextId === null && ["request.completed", "request.failed", "recovery.required"].includes(e.kind))).toHaveLength(1);
  } finally { release(); await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(["checkout:/tmp/retry-secondary", "external:retry-database"])("reacquires all persisted native-attempt resources before retry when %s is held", async (blockedResource) => {
  const directory = await mkdtemp(join(tmpdir(), "progress-retry-resources-"));
  const databasePath = join(directory, "progress.sqlite");
  let store = openProgressStore({ databasePath, ownerKey: "local" });
  const original = { requestId: "original", contextId: "ctx-original", reservationId: "res-original", generation: 1, agentId: "agent-original" };
  const blocker = { requestId: "blocker", contextId: "ctx-blocker", reservationId: "res-blocker", generation: 1, agentId: "agent-blocker" };
  for (const identity of [original, blocker]) {
    store.acceptRequest({ requestId: identity.requestId, sessionId: "s", text: identity.requestId });
    store.createContext({ contextId: identity.contextId, originSessionId: "s", title: identity.requestId, objective: identity.requestId });
    store.assignRequestContext({ ...identity, partId: "0", relation: "new", instruction: identity.requestId });
    store.setContextAgent({ ...identity, currentRequestId: identity.requestId, state: "completed" });
    store.completeRequest({ requestId: identity.requestId, eventKey: `${identity.requestId}:complete`, state: "completed", text: "Original HQ response" });
  }
  const { realpath } = await import("node:fs/promises");
  const checkoutRoot = await realpath(directory);
  const resources = [
    { resourceKey: `checkout:${checkoutRoot}/primary`, mode: "write" as const },
    { resourceKey: `checkout:${checkoutRoot}/secondary`, mode: "write" as const },
    { resourceKey: "external:retry-database", mode: "write" as const },
  ];
  store.tryReserveExecution({ ...original, resources });
  store.linkReservationDispatch({ ...original, nativeDispatchId: "original-dispatch" });
  store.linkContextJob({ ...original, jobId: "job", dispatchId: "original-dispatch" });
  store.releaseExecutionReservation({ ...original, nativeCompletion: { dispatchId: "original-dispatch", state: "failed" } });
  store.tryReserveExecution({ ...blocker, resources: [{ resourceKey: blockedResource.startsWith("checkout:") ? resources[1]!.resourceKey : blockedResource, mode: "write" }] });
  store.close();
  store = openProgressStore({ databasePath, ownerKey: "local" });
  const job: CommandJob = { id: "job", dispatchId: "original-dispatch", execution: original, state: "failed", worktreePath: `${checkoutRoot}/primary`, projectId: "p", projectName: "P", prompt: "Mutate primary, secondary and external target", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let launched = false;
  const runtime = createProgressRuntime({
    store, reservations: createExecutionReservations(store), catalog: { list: async () => [] }, getJob: id => id === "job" ? job : undefined,
    router: createContextRouter({ propose: async () => ({ parts: [] }) }),
    execute: async input => { await input.execution!.beforeNative("job"); launched = true; return { text: "Retry boundary reached" }; },
  });
  try {
    await runtime.start();
    runtime.submit({ requestId: "retry", sessionId: "s", text: "Retry", contextHint: { mode: "continue", contextId: original.contextId } });
    await vi.waitFor(() => expect(store.readEvents({ after: 0 }).events.some(e => e.requestId === "retry" && e.kind === "agent.waiting" && e.payload.reason === "resources")).toBe(true));
    expect(launched).toBe(false);
    expect(store.listExecutionReservations().filter(r => r.requestId === "retry")).toHaveLength(0);
    store.releaseExecutionReservation(blocker);
    await vi.waitFor(() => expect(launched).toBe(true));
    expect(store.listExecutionReservations().filter(r => r.requestId === "retry").map(r => r.resourceKey)).toEqual(resources.map(r => r.resourceKey));
  } finally { await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(["missing", "ambiguous", "wrong dispatch"])("rejects native retry with %s resource provenance instead of launching with only the primary checkout", async (provenance) => {
  const directory = await mkdtemp(join(tmpdir(), "progress-retry-unknown-"));
  const store = openProgressStore({ databasePath: join(directory, "progress.sqlite"), ownerKey: "local" });
  const identity = { requestId: "original", contextId: "ctx", agentId: "agent", generation: 1 };
  store.acceptRequest({ requestId: "original", sessionId: "s", text: "Original" });
  store.createContext({ contextId: "ctx", originSessionId: "s", title: "Original", objective: "Original" });
  store.assignRequestContext({ ...identity, partId: "0", relation: "new", instruction: "Original" });
  store.setContextAgent({ ...identity, currentRequestId: "original", state: "completed" });
  store.completeRequest({ requestId: "original", eventKey: "original:complete", state: "completed", text: "Finished" });
  store.linkContextJob({ ...identity, jobId: "job", dispatchId: "old-dispatch" });
  if (provenance !== "missing") {
    for (const reservationId of provenance === "ambiguous" ? ["a", "b"] : ["a"]) {
      const reservation = { ...identity, reservationId };
      store.tryReserveExecution({ ...reservation, resources: [{ resourceKey: "checkout:/tmp/primary", mode: "write" }] });
      store.linkReservationDispatch({ ...reservation, nativeDispatchId: "old-dispatch" });
      store.releaseExecutionReservation({ ...reservation, nativeCompletion: { dispatchId: "old-dispatch", state: "failed" } });
    }
  }
  const job: CommandJob = { id: "job", dispatchId: provenance === "wrong dispatch" ? "new-dispatch" : "old-dispatch", state: "failed", worktreePath: "/tmp/primary", projectId: "p", projectName: "P", prompt: "Original native work", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let launched = false;
  let rejection = "";
  const runtime = createProgressRuntime({
    store, reservations: createExecutionReservations(store), catalog: { list: async () => [] }, getJob: () => job,
    router: createContextRouter({ propose: async () => ({ parts: [] }) }),
    execute: async input => {
      try { await input.execution!.beforeNative("job"); }
      catch (error) { rejection = (error as Error).message; throw error; }
      launched = true;
      return { text: "Should never launch" };
    },
  });
  try {
    await runtime.start();
    runtime.submit({ requestId: "retry", sessionId: "s", text: "Retry", contextHint: { mode: "continue", contextId: "ctx" } });
    await vi.waitFor(() => expect(store.getRequest("retry")?.state).toBe("recovery_required"));
    expect(rejection).toBe("native_resource_provenance_unknown");
    expect(launched).toBe(false);
    expect(store.listExecutionReservations().filter(r => r.requestId === "retry")).toHaveLength(0);
  } finally { await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

it("reports unknown native effects separately from a successful multipart sibling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-multipart-unknown-"));
  const store = openProgressStore({ databasePath: join(directory, "progress.sqlite"), ownerKey: "local" });
  const runtime = createProgressRuntime({
    store, reservations: createExecutionReservations(store), catalog: { list: async () => [] }, getJob: () => undefined,
    router: createContextRouter({ propose: async () => ({ parts: [
      { action: "new", title: "known", objective: "known", projectIds: [], text: "known part" },
      { action: "new", title: "uncertain", objective: "uncertain", projectIds: [], text: "uncertain part" },
    ] }) }),
    execute: async input => {
      if (input.text.endsWith("uncertain part")) {
        await input.execution!.reserve([{ resourceKey: "external:uncertain-effect", mode: "write" }]);
        input.execution!.markNativeAttempt!();
        return { text: "Native receipt unavailable" };
      }
      return { text: "Known success" };
    },
  });
  try {
    await runtime.start();
    runtime.submit({ requestId: "multi", sessionId: "s", text: "Two parts" });
    await vi.waitFor(() => expect(store.getRequest("multi")?.state).toBe("recovery_required"));
    expect(store.listRequestAssignments("multi").map(a => a.outcome?.state)).toEqual(["completed", "recovery_required"]);
    expect(store.getRequest("multi")?.result?.text).toContain("Known success");
    expect(store.getRequest("multi")?.result?.text).toContain("결과 확인 필요");
    expect(store.listExecutionReservations()[0]?.state).toBe("recovery_required");
    expect(runtime.executor.activeContexts).toBe(1);
  } finally { await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
