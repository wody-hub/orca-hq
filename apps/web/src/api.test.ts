import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationsApi, OperationsApiError } from "./api.js";

const observedAt = "2026-09-15T09:00:00.000Z";
function response(status: number, body?: unknown): Response { return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function status() { return { collectedAt: observedAt, hq: { state: "running", capacity: { limit: 10, source: "default", active: 1, queued: 0, byState: { executing: 1 }, updateSupported: false, reason: "restart_safe_mutation_contract_unavailable" } }, orca: { state: "ready", reachable: true, version: "1.4.203", features: {} }, metrics: { tokens: { available: false, reason: "not_collected" }, cost: { available: false, reason: "not_collected" } } }; }
function store(initial?: string) { let value = initial; return { getItem: vi.fn(() => value ?? null), setItem: vi.fn((_key: string, next: string) => { value = next; }), removeItem: vi.fn(() => { value = undefined; }) }; }

describe("operations API", () => {
  afterEach(() => { window.history.replaceState({}, "", "/"); });

  it("redeems a single-use claim and removes the fragment before the request settles", async () => {
    window.history.replaceState({}, "", `/#claim=${"a".repeat(43)}`);
    let hashDuringFetch = "not-called";
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { hashDuringFetch = window.location.hash; return response(200, { csrf: "csrf", expiresAt: observedAt }); });
    const storage = store();
    await createOperationsApi(fetcher, storage).bootstrap();
    expect(hashDuringFetch).toBe("");
    expect(fetcher).toHaveBeenCalledWith("/auth/local/claim", expect.objectContaining({ credentials: "same-origin", body: JSON.stringify({ claim: "a".repeat(43) }) }));
    expect(storage.setItem).toHaveBeenCalledWith("orca-hq.operations.csrf", "csrf");
  });

  it("removes a failed claim fragment without exposing it in the error URL", async () => {
    window.history.replaceState({}, "", `/#claim=${"b".repeat(43)}`);
    const api = createOperationsApi(vi.fn<typeof fetch>().mockResolvedValue(response(401, { error: "claim_expired" })), store());
    await expect(api.bootstrap()).rejects.toMatchObject({ status: 401, code: "claim_expired" });
    expect(window.location.hash).toBe("");
  });

  it("also clears a malformed claim fragment before rejecting locally", async () => {
    window.history.replaceState({}, "", "/#claim=short-secret");
    const fetcher = vi.fn<typeof fetch>();
    await expect(createOperationsApi(fetcher, store()).bootstrap()).rejects.toMatchObject({ status: 400, code: "claim_invalid" });
    expect(window.location.hash).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refreshes an existing session once for reads and preserves the opaque cursor", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(401, { error: "session_required" }))
      .mockResolvedValueOnce(response(200, { csrf: "new-csrf", expiresAt: observedAt }))
      .mockResolvedValueOnce(response(200, { source: "orca", runs: [], nextCursor: "opaque/+==", evidence: { source: "orca_cli", observedAt, verification: "observed" } }));
    const api = createOperationsApi(fetcher, store("old-csrf"));
    await expect(api.runs("opaque/+==")).resolves.toMatchObject({ nextCursor: "opaque/+==" });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/operations/orca/runs?cursor=opaque%2F%2B%3D%3D", "/auth/local/refresh", "/api/operations/orca/runs?cursor=opaque%2F%2B%3D%3D"]);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("x-csrf-token")).toBe("old-csrf");
  });

  it("coalesces concurrent read recovery into one CSRF refresh", async () => {
    let refreshCalls = 0, statusCalls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (path === "/auth/local/refresh") { refreshCalls++; await Promise.resolve(); return response(200, { csrf: "new-csrf", expiresAt: observedAt }); }
      statusCalls++; return statusCalls <= 2 ? response(401, { error: "session_required" }) : response(200, status());
    });
    const api = createOperationsApi(fetcher, store("old-csrf"));
    await expect(Promise.all([api.status(), api.status()])).resolves.toHaveLength(2);
    expect(refreshCalls).toBe(1);
  });

  it("does not invent an unauthenticated bootstrap when CSRF is absent", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(401, { error: "session_required" }));
    await expect(createOperationsApi(fetcher, store()).status()).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects malformed payloads instead of returning unchecked values", async () => {
    const api = createOperationsApi(vi.fn<typeof fetch>().mockResolvedValue(response(200, { ...status(), hq: { state: "running", capacity: { active: "one" } } })), store());
    await expect(api.status()).rejects.toEqual(expect.objectContaining<Partial<OperationsApiError>>({ status: 502, code: "malformed_response" }));
  });

  it.each([
    {
      name: "an over-bound opaque cursor",
      body: { source: "orca", runs: [], nextCursor: "c".repeat(2049), evidence: { source: "orca_cli", observedAt, verification: "observed" } },
      read: (api: ReturnType<typeof createOperationsApi>) => api.runs(),
    },
    {
      name: "an over-bound native ID",
      body: { source: "orca", runs: [{ id: "r".repeat(513), objective: "real run" }], evidence: { source: "orca_cli", observedAt, verification: "observed" } },
      read: (api: ReturnType<typeof createOperationsApi>) => api.runs(),
    },
    {
      name: "over-bound display text",
      body: { contexts: [{ contextId: "context-1", title: "t".repeat(257), state: "ready", summary: "summary", projectIds: [], jobIds: [], createdAt: observedAt, updatedAt: observedAt, lastSeq: 1 }] },
      read: (api: ReturnType<typeof createOperationsApi>) => api.contexts(),
    },
    {
      name: "a non-contract date",
      body: { contexts: [{ contextId: "context-1", title: "title", state: "ready", summary: "summary", projectIds: [], jobIds: [], createdAt: "September 15, 2026", updatedAt: observedAt, lastSeq: 1 }] },
      read: (api: ReturnType<typeof createOperationsApi>) => api.contexts(),
    },
    {
      name: "an unknown HQ event discriminant",
      body: { events: [{ source: "hq", eventSource: "hq", seq: 1, eventKey: "event-1", requestId: "request-1", contextId: null, kind: "invented.kind", occurredAt: observedAt, payload: {} }], snapshots: [], cursor: "1", compacted: false, oldestSeq: 1, latestSeq: 1 },
      read: (api: ReturnType<typeof createOperationsApi>) => api.events("context-1"),
    },
  ])("rejects $name at the response boundary", async ({ body, read }) => {
    const api = createOperationsApi(vi.fn<typeof fetch>().mockResolvedValue(response(200, body)), store());
    await expect(read(api)).rejects.toMatchObject({ status: 502, code: "malformed_response" });
  });

  it("preserves the final native Task fields from the Task 2 route", async () => {
    const body = { source: "orca", tasks: [{ id: "task-1", status: "open", run_id: "run-1", created_by_terminal_handle: "term-1", created_by_process_incarnation: "inc-1", created_by_run_generation: 2 }], evidence: { source: "orca_cli", observedAt, verification: "observed" } };
    const api = createOperationsApi(vi.fn<typeof fetch>().mockResolvedValue(response(200, body)), store());
    await expect(api.tasks("run-1")).resolves.toMatchObject(body);
  });

  it("accepts worker-list projections that omit releaseState from a released resource", async () => {
    const body = {
      source: "orca",
      workers: [{
        dispatchId: "dispatch-1",
        projection: {
          dispatchId: "dispatch-1",
          taskId: "task-1",
          runId: "run-1",
          liveness: { verdict: "exited" },
          resource: { state: "released" },
        },
      }],
      page: { hasMore: false, nextCursor: null },
      scope: { source: "bound" },
      evidence: { source: "orca_cli", observedAt, verification: "observed" },
    };
    const api = createOperationsApi(vi.fn<typeof fetch>().mockResolvedValue(response(200, body)), store());
    await expect(api.workers()).resolves.toMatchObject(body);
  });

  it("passes read abort signals through to fetch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_path, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const controller = new AbortController();
    const pending = createOperationsApi(fetcher, store()).status(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("parses non-empty terminal lines and warnings without treating array indexes as text limits", async () => {
    // Break caught: Array.map can pass its index into a parser's optional max-length parameter and reject every non-empty first row.
    const body = { source: "terminal", cursor: "next", archived: false, warnings: ["truncated"], lines: ["first output"] };
    const api = createOperationsApi(vi.fn<typeof fetch>().mockResolvedValue(response(200, body)), store());
    await expect(api.output("dispatch-1", "terminal")).resolves.toEqual(body);
  });

  it("does not retry mutations and preserves accepted as queued evidence", async () => {
    const receipt = { requestId: "request-1", action: "dispatch", targetId: "task-1", state: "accepted", observedAt };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(202, receipt));
    await expect(createOperationsApi(fetcher, store("csrf")).mutate("/api/operations/orca/dispatches", { taskId: "task-1" }, "request-1")).resolves.toEqual(receipt);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toBe("request-1");
  });

  it("never replays an unknown mutation response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(502, { error: "mutation_unknown" }));
    await expect(createOperationsApi(fetcher, store("csrf")).mutate("/api/operations/orca/dispatches", {}, "request-2")).rejects.toMatchObject({ status: 502, code: "mutation_unknown" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([[409, "rejected"], [502, "unknown"]] as const)("preserves a %i mutation receipt as %s instead of discarding its journal evidence", async (statusCode, state) => {
    // Break caught: non-2xx journal receipts can be mistaken for generic transport errors and lose their stable request identity.
    const receipt = { requestId: "request-3", action: "stop", targetId: "dispatch-1", state, observedAt, detail: "fresh_gate" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(statusCode, receipt));
    await expect(createOperationsApi(fetcher, store("csrf")).mutate("/api/operations/orca/workers/dispatch-1/stop", { runId: "run-1", expectedIncarnation: "inc-1" }, "request-3")).resolves.toEqual(receipt);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
