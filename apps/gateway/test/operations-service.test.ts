import { it, expect, vi } from "vitest";
import { openDatabase } from "@orca-hq/persistence";
import { SqliteProgressStore } from "../src/progress-store.js";
import { OperationsJournal } from "../src/operations-journal.js";
import { OperationsService } from "../src/operations-service.js";
const terminal = {
  handle: "term",
  ptyId: "pty",
  incarnationId: "inc",
  connected: true,
  writable: true,
  worktreeId: "wt",
  executionHostId: "local",
};
const worker = () => ({
  dispatch: {
    id: "d",
    taskId: "task",
    runId: "run",
    status: "dispatched",
    processIncarnation: "pty:inc",
  },
  worker: {
    dispatchId: "d",
    state: "ready",
    stage: "input_accepted",
    agentTerminalHandle: "term",
  },
  projection: {
    dispatchId: "d",
    taskId: "task",
    runId: "run",
    outcome: "in_progress",
    stage: { worker: "ready", dispatch: "dispatched" },
    liveness: { verdict: "live" },
    resource: {
      state: "owned",
      ownerDispatchId: "d",
      releaseState: "not_requested",
    },
  },
  observation: { status: "live", exactWorker: true },
  terminal: { ...terminal },
  terminalResource: {
    id: "res",
    ownershipState: "owned",
    releaseState: "not_requested",
    ownerDispatchId: "d",
    terminalHandle: "term",
    endpointIncarnation: "pty:inc",
  },
});
function fixture() {
  const db = openDatabase(":memory:"),
    store = new SqliteProgressStore(openDatabase(":memory:"), {
      databasePath: ":memory:",
      ownerKey: "local",
    });
  let w = worker();
  const effects: unknown[] = [];
  const execute = vi.fn(async (op: any) => {
    let result: unknown;
    switch (op.kind) {
      case "operations_show_worker":
        result = w;
        break;
      case "show_run":
        result = {
          run: {
            id: "run",
            objective: "work",
            coordinator_handle: "owner",
            consumer_generation: 1,
          },
        };
        break;
      case "show_terminal":
        result = {
          terminal:
            op.terminalHandle === "owner"
              ? {
                  ...terminal,
                  handle: "owner",
                  ptyId: "ownerpty",
                  incarnationId: "ownerinc",
                }
              : terminal,
        };
        break;
      case "list_tasks":
        result = {
          runId: "run",
          tasks: [
            {
              id: "task",
              run_id: "run",
              status: "pending",
              created_by_terminal_handle: "owner",
              created_by_process_incarnation: "ownerpty:ownerinc",
              created_by_run_generation: 1,
            },
          ],
        };
        break;
      case "operations_inbox":
        result = {
          messages: [
            {
              id: "q",
              type: "question",
              subject: "?",
              body: "hi",
              run_id: "run",
              to_handle: "run:run",
            },
          ],
          count: 1,
        };
        break;
      case "operations_status":
        result = {
          runtime: {
            state: "ready",
            reachable: true,
            appVersion: "1.4.203",
            capabilities: [
              "orchestration.contract.v1",
              "orchestration.worker-stop-verdict.v1",
            ],
          },
        };
        break;
      default:
        effects.push(op);
        result = { dispatchId: "d", state: "accepted", verdict: "accepted" };
    }
    return { id: "r", ok: true, result, _meta: { runtimeId: "runtime" } };
  });
  const submit = vi.fn(async () => ({ accepted: true }));
  const service = new OperationsService({
    store,
    journal: new OperationsJournal(db),
    orca: { execute },
    submit,
    capacity: {
      limit: 10,
      source: "default",
      snapshot: () => ({ active: 2, queued: 1 }),
      attempts: () => [{ state: "unknown" }, { state: "active" }],
    },
  });
  return {
    service,
    store,
    db,
    effects,
    execute,
    submit,
    get w() {
      return w;
    },
    close() {
      db.close();
      store.close();
    },
  };
}
it("reads HQ snapshots without touching a held watch lease and reports HQ-only capacity", async () => {
  const f = fixture();
  try {
    f.store.createContext({
      contextId: "ctx",
      originSessionId: "s",
      objective: "work",
      title: "secret token=abc",
      summary: "hello",
      projectIds: [],
    });
    const lease = f.store.acquireViewerLease({
      contextId: "ctx",
      viewerInstanceId: "watch",
    });
    const acquire = vi.spyOn(f.store, "acquireViewerLease"),
      release = vi.spyOn(f.store, "releaseViewerLease");
    expect(f.service.contexts().contexts).toHaveLength(1);
    expect(f.service.events({ after: 0, contextId: "ctx" }).compacted).toBe(
      false,
    );
    const status = await f.service.status();
    expect(status.hq.capacity).toMatchObject({
      active: 2,
      queued: 1,
      limit: 10,
      source: "default",
      byState: { unknown: 1, active: 1 },
      updateSupported: false,
    });
    expect(status.metrics.tokens.available).toBe(false);
    expect(
      f.store.heartbeatViewerLease({
        contextId: "ctx",
        viewerInstanceId: "watch",
        leaseToken: lease.leaseToken!,
      }),
    ).toEqual({ ok: true });
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it.each([
  "unknown",
  "unverifiable",
  "release_pending",
  "release_unknown",
  "transferred",
])("rejects %s liveness before a stop effect", async (state) => {
  const f = fixture();
  try {
    f.w.projection.liveness.verdict = state;
    const r = await f.service.mutate(
      "stop",
      "d",
      { runId: "run", expectedIncarnation: "inc" },
      "req",
    );
    expect(r.state).toBe("rejected");
    expect(f.effects).toHaveLength(0);
  } finally {
    f.close();
  }
});
it("uses trusted sender and explicit run for live followup and rejects changed incarnation", async () => {
  const f = fixture();
  try {
    expect(
      (
        await f.service.mutate(
          "followup",
          "d",
          { runId: "run", expectedIncarnation: "other", body: "hi" },
          "bad",
        )
      ).state,
    ).toBe("rejected");
    expect(
      (
        await f.service.mutate(
          "followup",
          "d",
          { runId: "run", expectedIncarnation: "inc", body: "hi" },
          "good",
        )
      ).state,
    ).toBe("accepted");
    expect(f.effects).toEqual([
      {
        kind: "operations_send",
        dispatchId: "d",
        body: "hi",
        senderHandle: "owner",
        runId: "run",
        retryRequestId: "good",
      },
    ]);
  } finally {
    f.close();
  }
});
it("requires fresh question and pending same-run task, and refuses unsafe release", async () => {
  const f = fixture();
  try {
    expect(
      (
        await f.service.mutate(
          "reply",
          "absent",
          { runId: "run", body: "hi" },
          "absent",
        )
      ).state,
    ).toBe("rejected");
    expect(
      (
        await f.service.mutate(
          "reply",
          "q",
          { runId: "run", body: "hi" },
          "reply",
        )
      ).state,
    ).toBe("accepted");
    expect(
      (
        await f.service.mutate(
          "dispatch",
          "task",
          { runId: "run", terminalHandle: "term", expectedIncarnation: "inc", inject: true },
          "dispatch",
        )
      ).state,
    ).toBe("accepted");
    expect(
      (
        await f.service.mutate(
          "release",
          "d",
          { runId: "run", expectedIncarnation: "inc" },
          "release",
        )
      ).state,
    ).toBe("rejected");
    expect(f.effects).toHaveLength(2);
    expect(f.effects[1]).toMatchObject({ kind: "operations_dispatch", inject: true });
  } finally {
    f.close();
  }
});

it("requires an explicit boolean inject choice before dispatch authorization", async () => {
  // Break caught: an omitted or stringly inject value must not reach the typed Orca operation boundary.
  const f = fixture();
  try {
    await expect(f.service.mutate("dispatch", "task", { runId: "run", terminalHandle: "term", expectedIncarnation: "inc" }, "missing-inject")).rejects.toThrow();
    await expect(f.service.mutate("dispatch", "task", { runId: "run", terminalHandle: "term", expectedIncarnation: "inc", inject: "true" }, "string-inject")).rejects.toThrow();
    expect(f.effects).toHaveLength(0);
  } finally {
    f.close();
  }
});

it("rejects lifecycle controls when capability or runtime identity is unproven", async () => {
  const f = fixture();
  try {
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (op) =>
      op.kind === "operations_status"
        ? {
            id: "r",
            ok: true,
            result: {
              runtime: {
                state: "ready",
                reachable: true,
                appVersion: "1.4.203",
                capabilities: [],
              },
            },
            _meta: { runtimeId: "runtime" },
          }
        : original(op),
    );
    expect(
      (
        await f.service.mutate(
          "stop",
          "d",
          { runId: "run", expectedIncarnation: "inc" },
          "req",
        )
      ).state,
    ).toBe("rejected");
    expect(f.effects).toHaveLength(0);
  } finally {
    f.close();
  }
});
it("returns a durable unknown if a successful process reports an ambiguous verdict", async () => {
  const f = fixture();
  try {
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (op) =>
      op.kind === "operations_stop"
        ? {
            id: "r",
            ok: true,
            result: {
              dispatchId: "d",
              state: "release_unknown",
              verdict: "unknown",
            },
            _meta: { runtimeId: "runtime" },
          }
        : original(op),
    );
    const a = await f.service.mutate(
      "stop",
      "d",
      { runId: "run", expectedIncarnation: "inc" },
      "req",
    );
    const b = await f.service.mutate(
      "stop",
      "d",
      { runId: "run", expectedIncarnation: "inc" },
      "req",
    );
    expect(a.state).toBe("unknown");
    expect(a).toEqual(b);
    expect(
      f.execute.mock.calls.filter(([op]) => op.kind === "operations_stop"),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});
it("paginates contexts without losing records after the first hundred", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 101; i++)
      f.store.createContext({
        contextId: `ctx${i}`,
        originSessionId: "s",
        title: "t",
        objective: "work",
      });
    const first = f.service.contexts(),
      second = f.service.contexts(undefined, first.cursor);
    expect(first.contexts).toHaveLength(100);
    expect(second.contexts).toHaveLength(1);
  } finally {
    f.close();
  }
});
it("routes stored native questions through the existing HQ answer submission", async () => {
  const f = fixture();
  try {
    f.store.acceptRequest({ requestId: "hqreq", sessionId: "s", text: "work" });
    f.store.nativeJournal().put("question", "q", {
      id: "q",
      attemptId: "a",
      type: "question",
      body: "question",
    });
    f.store.appendEvent({
      eventKey: "qevent",
      requestId: "hqreq",
      contextId: null,
      kind: "clarification.required",
      source: "orca",
      payload: { text: "question", messageId: "q" },
    });
    expect(
      (
        await f.service.mutate(
          "reply",
          "q",
          { runId: "run", body: "answer" },
          "answer",
        )
      ).state,
    ).toBe("accepted");
    expect(f.submit).toHaveBeenCalledWith({
      requestId: "answer",
      sessionId: "s",
      text: "/answer q answer",
    });
    expect(f.effects).toHaveLength(0);
  } finally {
    f.close();
  }
});
it("fences a runtime replacement observed during authorization", async () => {
  const f = fixture();
  try {
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (op) => {
      const r = await original(op);
      return op.kind === "show_terminal"
        ? { ...r, _meta: { runtimeId: "replacement" } }
        : r;
    });
    expect(
      (
        await f.service.mutate(
          "stop",
          "d",
          { runId: "run", expectedIncarnation: "inc" },
          "req",
        )
      ).state,
    ).toBe("rejected");
    expect(f.effects).toHaveLength(0);
  } finally {
    f.close();
  }
});
it("permits exact settled retained resource release and accepts only known effect verdicts", async () => {
  const f = fixture();
  try {
    f.w.projection.outcome = "succeeded";
    f.w.dispatch.status = "completed";
    f.w.projection.liveness.verdict = "exited";
    f.w.terminalResource.releaseState = "retained";
    expect(
      (
        await f.service.mutate(
          "release",
          "d",
          { runId: "run", expectedIncarnation: "inc" },
          "req",
        )
      ).state,
    ).toBe("accepted");
  } finally {
    f.close();
  }
});
it("rejects native sender failures and leaves unrecognized effect states unknown", async () => {
  const f = fixture();
  try {
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (op) => {
      if (op.kind === "operations_stop")
        throw Object.assign(Error("rejected"), {
          code: "orca_command_failed",
          orcaCode: "no_active_sender_terminal",
        });
      return original(op);
    });
    expect(
      (
        await f.service.mutate(
          "stop",
          "d",
          { runId: "run", expectedIncarnation: "inc" },
          "req",
        )
      ).state,
    ).toBe("rejected");
    f.execute.mockImplementation(async (op) =>
      op.kind === "operations_stop"
        ? {
            id: "r",
            ok: true,
            result: {
              dispatchId: "d",
              state: "surprising",
              verdict: "surprising",
            },
            _meta: { runtimeId: "runtime" },
          }
        : original(op),
    );
    expect(
      (
        await f.service.mutate(
          "stop",
          "d",
          { runId: "run", expectedIncarnation: "inc" },
          "other",
        )
      ).state,
    ).toBe("unknown");
  } finally {
    f.close();
  }
});
it("redacts nested public secrets and does not synthesize Run status", async () => {
  const f = fixture();
  try {
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (op) =>
      op.kind === "list_runs"
        ? {
            id: "r",
            ok: true,
            result: {
              runs: [
                {
                  id: "run",
                  objective: "xoxb-12345-abcdef token=private",
                  secret: "must-not-leak",
                },
              ],
              nextCursor: null,
            },
            _meta: { runtimeId: "runtime" },
          }
        : original(op),
    );
    const page = await f.service.runs();
    expect(JSON.stringify(page)).not.toContain("xoxb-12345-abcdef");
    expect(JSON.stringify(page)).not.toContain("private");
    expect(JSON.stringify(page)).not.toContain("must-not-leak");
    expect((page as any).runs[0]).not.toHaveProperty("status");
  } finally {
    f.close();
  }
});
it("pages clarification events and preserves compaction sequence evidence and receipt-only links", () => {
  const f = fixture();
  try {
    f.store.acceptRequest({ requestId: "r", sessionId: "s", text: "work" });
    f.store.updateRequest({ requestId: "r", state: "awaiting_input" });
    for (let i = 0; i < 3; i++)
      f.store.appendEvent({
        eventKey: `q${i}`,
        requestId: "r",
        contextId: null,
        kind: "clarification.required",
        source: "hq",
        payload: {
          text: `question ${i}`,
          runId: "run",
          taskId: "task",
          dispatchId: "d",
          terminalHandle: "term",
        },
      });
    const page = f.service.questions(0, 2);
    expect(page.questions).toHaveLength(1);
    expect(f.service.questions(Number(page.cursor), 2).questions).toHaveLength(
      2,
    );
    expect(
      f.service
        .events({ after: 0, limit: 4 })
        .events.every((e) => e.receiptLink === undefined),
    ).toBe(true);
  } finally {
    f.close();
  }
});
it.each([false, true])("keeps exhausted question cursors monotonic with compaction=%s", (compact) => {
  const f = fixture();
  try {
    f.store.acceptRequest({ requestId: "r", sessionId: "s", text: "work" });
    f.store.updateRequest({ requestId: "r", state: "awaiting_input" });
    f.store.appendEvent({ requestId: "r", contextId: null, eventKey: "q", kind: "clarification.required", source: "hq", occurredAt: "2026-07-01T00:00:00.000Z", payload: { text: "Which project?" } });
    if (compact) {
      f.store.completeRequest({ requestId: "r", eventKey: "complete", state: "completed", text: "done", occurredAt: "2026-07-01T00:00:01.000Z" });
      f.store.pruneCompletedEvents("2026-08-01T00:00:00.000Z");
    }
    const history = f.store.readEvents({ after: 0, limit: 100 });
    expect(history.compacted).toBe(compact);
    let after = 0, seen = 0;
    for (let i = 0; i < 10; i++) {
      const page = f.service.questions(after, 1);
      const next = Number(page.cursor);
      expect(next).toBeGreaterThanOrEqual(after);
      seen += page.questions.length;
      if (next === after) break;
      after = next;
    }
    expect(after).toBe(history.latestSeq);
    expect(seen).toBe(compact ? 0 : 1);
    for (let i = 0; i < 3; i++)
      expect(f.service.questions(after, 1)).toMatchObject({ questions: [], cursor: String(after) });
  } finally { f.close(); }
});
it("turns public source_changed into a conflict instead of an empty log page", async () => {
  const f = fixture();
  try {
    f.execute.mockRejectedValue(
      Object.assign(Error("changed"), { orcaCode: "source_changed" }),
    );
    await expect(f.service.output("d", "terminal")).rejects.toMatchObject({
      status: 409,
      code: "source_changed",
    });
  } finally {
    f.close();
  }
});
it("rejects unregistered route suffixes and request identity collisions", async () => {
  const f = fixture();
  try {
    await expect(
      f.service.route(
        "GET",
        new URL("http://127.0.0.1/api/operations/orca/workers/d/not-a-route"),
        undefined,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.service.submit(
        { requestId: "body", sessionId: "s", text: "work" },
        "header",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.submit).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it("does not authorize a replacement coordinator process from handle alone", async () => {
  const f = fixture();
  try {
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (op) =>
      op.kind === "show_terminal" && op.terminalHandle === "owner"
        ? {
            id: "r",
            ok: true,
            result: {
              terminal: {
                ...terminal,
                handle: "owner",
                ptyId: "ownerpty",
                incarnationId: "replacement",
              },
            },
            _meta: { runtimeId: "runtime" },
          }
        : original(op),
    );
    expect(
      (
        await f.service.mutate(
          "reply",
          "q",
          { runId: "run", body: "answer" },
          "req",
        )
      ).state,
    ).toBe("rejected");
    expect(f.effects).toHaveLength(0);
  } finally {
    f.close();
  }
});
it("rechecks target liveness immediately after sender proof before issuing control", async () => {
  const f = fixture();
  try {
    const original = f.execute.getMockImplementation()!;
    let reads = 0;
    f.execute.mockImplementation(async (op) => {
      if (op.kind === "operations_show_worker" && ++reads === 2)
        f.w.observation.status = "unverifiable";
      return original(op);
    });
    expect(
      (
        await f.service.mutate(
          "stop",
          "d",
          { runId: "run", expectedIncarnation: "inc" },
          "req",
        )
      ).state,
    ).toBe("rejected");
    expect(f.effects).toHaveLength(0);
  } finally {
    f.close();
  }
});
it("preserves host omission and terminal inventory scope without inventing coverage", async () => {
  const f = fixture();
  try {
    f.execute.mockImplementation(async (op) => {
      const results: Record<string, unknown> = {
        operations_list_projects: {
          projects: [{ id: "p", displayName: "project", kind: "repo" }],
        },
        list_project_setups: {
          setups: [
            {
              id: "setup",
              projectId: "p",
              repoId: "repo",
              hostId: "remote",
              path: "/workspace",
            },
          ],
        },
        list_worktrees: {
          worktrees: [{ id: "wt", projectHostSetupId: "setup" }],
          hostScope: { hostIds: ["local"], omittedHostIds: ["remote"] },
          truncated: false,
        },
        list_terminals: {
          terminals: [terminal],
          hostScope: { hostIds: ["local"], omittedHostIds: ["remote"] },
          truncated: false,
        },
      };
      return {
        id: "r",
        ok: true,
        result: results[op.kind],
        _meta: { runtimeId: "runtime" },
      };
    });
    const result = (await f.service.resources()) as any;
    expect(result.projects[0].hostScope).toBe("not_covered");
    expect(result.projects[0].setups[0].hostScope.omittedHostIds).toEqual([
      "remote",
    ]);
    expect(result.projects[0].setups[0].worktrees[0].terminals[0].handle).toBe(
      "term",
    );
  } finally {
    f.close();
  }
});
it("bounds inventory fanout with explicit uncovered evidence instead of unbounded reads", async () => {
  const f = fixture();
  try {
    f.execute.mockImplementation(async (op) => ({
      id: "r",
      ok: true,
      result:
        op.kind === "operations_list_projects"
          ? { projects: [{ id: "p" }] }
          : op.kind === "list_project_setups"
            ? {
                setups: Array.from({ length: 100 }, (_, i) => ({
                  id: `setup${i}`,
                  projectId: "p",
                  repoId: `repo${i}`,
                  hostId: "local",
                })),
              }
            : op.kind === "list_worktrees"
              ? {
                  worktrees: [
                    {
                      id: "wt",
                      projectHostSetupId: `setup${String(op.repoId).slice(4)}`,
                    },
                  ],
                  hostScope: { hostIds: ["local"], omittedHostIds: [] },
                  truncated: false,
                }
              : {
                  terminals: [terminal],
                  hostScope: { hostIds: ["local"], omittedHostIds: [] },
                  truncated: false,
                },
      _meta: { runtimeId: "runtime" },
    }));
    const result = await f.service.resources();
    expect(f.execute.mock.calls.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(result)).toContain("request_read_budget_exhausted");
  } finally {
    f.close();
  }
});
it("keeps the server-owned source tag when a passthrough receipt carries another source", async () => {
  const f = fixture();
  try {
    f.execute.mockResolvedValue({
      id: "r",
      ok: true,
      result: { source: "hq", runs: [] },
      _meta: { runtimeId: "runtime" },
    });
    expect((await f.service.runs()).source).toBe("orca");
  } finally {
    f.close();
  }
});
it.each([
  [
    "wrong Dispatch",
    (w: any) => {
      w.dispatch.id = "other";
    },
  ],
  [
    "wrong task",
    (w: any) => {
      w.projection.taskId = "other";
    },
  ],
  [
    "wrong run",
    (w: any) => {
      w.dispatch.runId = "other";
    },
  ],
  [
    "inexact observation",
    (w: any) => {
      w.observation.exactWorker = false;
    },
  ],
  [
    "missing terminal",
    (w: any) => {
      w.terminal = null;
    },
  ],
  [
    "wrong resource owner",
    (w: any) => {
      w.terminalResource.ownerDispatchId = "other";
    },
  ],
  [
    "changed incarnation",
    (w: any) => {
      w.terminal.incarnationId = "other";
    },
  ],
  [
    "unverifiable PTY",
    (w: any) => {
      w.observation.status = "unverifiable";
    },
  ],
  [
    "disconnected terminal",
    (w: any) => {
      w.terminal.connected = false;
    },
  ],
  [
    "read-only terminal",
    (w: any) => {
      w.terminal.writable = false;
    },
  ],
  [
    "unknown resource release",
    (w: any) => {
      w.terminalResource.releaseState = "release_unknown";
    },
  ],
  [
    "unknown projected ownership",
    (w: any) => {
      w.projection.resource.state = "unexpected";
    },
  ],
])("rejects %s before effect", async (_name, change) => {
  const f = fixture();
  try {
    change(f.w);
    expect(
      (
        await f.service.mutate(
          "stop",
          "d",
          { runId: "run", expectedIncarnation: "inc" },
          "req",
        )
      ).state,
    ).toBe("rejected");
    expect(f.effects).toHaveLength(0);
  } finally {
    f.close();
  }
});
it("records missing gate evidence as rejected when no effect has started", async () => {
  const f = fixture();
  try {
    delete (f.w as any).projection;
    expect(
      (
        await f.service.mutate(
          "stop",
          "d",
          { runId: "run", expectedIncarnation: "inc" },
          "req",
        )
      ).state,
    ).toBe("rejected");
    expect(f.effects).toHaveLength(0);
  } finally {
    f.close();
  }
});
it("preserves stale-cursor compaction snapshots and links only complete ready receipts", () => {
  const f = fixture();
  try {
    f.store.acceptRequest({ requestId: "r", sessionId: "s", text: "work" });
    f.store.createContext({
      contextId: "ctx",
      originSessionId: "s",
      title: "context",
      objective: "work",
    });
    f.store.assignRequestContext({
      requestId: "r",
      partId: "p",
      contextId: "ctx",
      relation: "new",
      instruction: "work",
    });
    const ready = f.store.appendEvent({
      requestId: "r",
      contextId: "ctx",
      eventKey: "ready",
      kind: "worker.ready",
      source: "orca",
      generation: 1,
      payload: {
        attemptId: "a",
        worktreeId: "wt",
        requested: { agent: "codex", model: "model", reason: "work" },
        effective: { agent: "codex" },
        runId: "run",
        taskId: "task",
        dispatchId: "d",
        terminalHandle: "term",
      },
    });
    expect(
      f.service
        .events({ after: 0, contextId: "ctx" })
        .events.find((e) => e.seq === ready.seq)?.receiptLink,
    ).toEqual({
      runId: "run",
      taskId: "task",
      dispatchId: "d",
      terminalHandle: "term",
    });
    f.store.appendEvent({
      requestId: "r",
      contextId: "ctx",
      eventKey: "detail",
      kind: "hq.progress",
      source: "hq",
      occurredAt: "2026-07-01T00:00:00.000Z",
      payload: { text: "old" },
    });
    f.store.completeRequest({
      requestId: "r",
      eventKey: "complete",
      state: "completed",
      text: "done",
      occurredAt: "2026-07-01T00:00:01.000Z",
    });
    f.store.pruneCompletedEvents("2026-08-01T00:00:00.000Z");
    const page = f.service.events({ after: 0, contextId: "ctx" });
    expect(page.compacted).toBe(true);
    expect(page.snapshots[0]?.contextId).toBe("ctx");
    expect(page.latestSeq).toBeGreaterThanOrEqual(ready.seq);
  } finally {
    f.close();
  }
});
it("accepts the public 2048-character output cursor contract", async () => {
  const f = fixture();
  try {
    f.execute.mockResolvedValue({
      id: "r",
      ok: true,
      _meta: { runtimeId: "runtime" },
      result: {
        dispatchId: "d",
        source: "terminal",
        cursor: "c".repeat(1024),
        archived: false,
        warnings: [],
        terminal: { lines: ["line"] },
      },
    });
    const page = (await f.service.route(
      "GET",
      new URL(
        "http://127.0.0.1/api/operations/orca/workers/d/output?source=terminal&cursor=" +
          "c".repeat(1024),
      ),
      undefined,
    )) as any;
    expect(page.cursor).toHaveLength(1024);
  } finally {
    f.close();
  }
});
it("enforces the raw 8000-character request bound before trimming", async () => {
  const f = fixture();
  try {
    await expect(
      f.service.submit(
        { requestId: "r", sessionId: "s", text: " ".repeat(8000) + "x" },
        "r",
      ),
    ).rejects.toBeDefined();
    expect(f.submit).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
