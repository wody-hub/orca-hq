import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createContextRouter } from "../../apps/gateway/src/context-router.js";
import { createExecutionReservations } from "../../apps/gateway/src/execution-reservations.js";
import { createProgressRuntime } from "../../apps/gateway/src/progress-runtime.js";
import { openProgressStore } from "../../apps/gateway/src/progress-store.js";

it("reopens a durable queue while retaining interrupted native ownership without replaying its instruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hq-restart-"));
  const databasePath = join(directory, "progress.sqlite");
  let store = openProgressStore({ databasePath, ownerKey: "local" });
  let runtime: ReturnType<typeof createProgressRuntime> | undefined;
  try {
    store.acceptRequest({ requestId: "interrupted", sessionId: "s", text: "must not execute twice" });
    store.claimNextRequest("old-process");
    store.createContext({ contextId: "ctx_native", originSessionId: "s", title: "native work", objective: "continue existing worker" });
    store.assignRequestContext({ requestId: "interrupted", partId: "0", contextId: "ctx_native", relation: "new", instruction: "must not execute twice" });
    store.updateRequest({ requestId: "interrupted", state: "executing" });
    store.setContextAgent({ contextId: "ctx_native", agentId: "old-agent", state: "running", generation: 7, currentRequestId: "interrupted" });
    const reservations = createExecutionReservations(store);
    expect(reservations.claim({ reservationId: "res_native", contextId: "ctx_native", requestId: "interrupted", agentId: "old-agent", generation: 7, resources: [{ resourceKey: directory, mode: "write" }] }).acquired).toBe(true);
    reservations.linkNativeDispatch({ reservationId: "res_native", contextId: "ctx_native", requestId: "interrupted", generation: 7, nativeDispatchId: "dispatch_existing" });
    store.linkContextJob({ contextId: "ctx_native", requestId: "interrupted", jobId: "job_existing", dispatchId: "dispatch_existing" });
    store.acceptRequest({ requestId: "not_started", sessionId: "s", text: "safe queued work" });
    store.close();

    store = openProgressStore({ databasePath, ownerKey: "local" });
    const execute = vi.fn(async () => ({ text: "queued work completed" }));
    runtime = createProgressRuntime({
      store,
      reservations: createExecutionReservations(store),
      router: createContextRouter({ async propose({ request }) {
        return { parts: [{ action: "new", title: "queued", objective: request.text, projectIds: [], text: request.text }] };
      } }),
      execute,
      getJob: () => undefined,
      catalog: { async list() { return []; } },
      pollMs: 10
    });
    await runtime.start();
    await vi.waitFor(() => expect(store.getRequest("not_started")?.state).toBe("completed"));
    expect(execute).toHaveBeenCalledOnce();
    expect(store.getRequest("interrupted")?.state).toBe("recovery_required");
    expect(store.listExecutionReservations("ctx_native")).toEqual(expect.arrayContaining([
      expect.objectContaining({ nativeDispatchId: "dispatch_existing", state: expect.not.stringMatching(/^released$/) })
    ]));
    expect(runtime.executor.activeContexts).toBe(1);
    const countBefore = store.readEvents({ sessionId: "s", after: 0 }).events.length;
    const replay = store.acceptRequest({ requestId: "interrupted", sessionId: "s", text: "must not execute twice" });
    expect(replay.accepted).toBe(false);
    expect(store.readEvents({ sessionId: "s", after: 0 }).events).toHaveLength(countBefore);
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    await runtime?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
