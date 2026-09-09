import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { openProgressStore } from "../src/progress-store.js";
import { createExecutionReservations } from "../src/execution-reservations.js";
import { createExecutionCompatibility } from "../src/execution-compatibility.js";
import type { CommandJob } from "../src/managed-commands.js";
it("blocks conflicting progress work for live or uncertain legacy jobs and blocks legacy launch for progress reservations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progress-compat-"));
  const store = openProgressStore({
    databasePath: join(directory, "progress.sqlite"),
    ownerKey: "local",
  });
  const reservations = createExecutionReservations(store);
  let jobs: CommandJob[] = [
    {
      id: "legacy",
      projectId: "p",
      projectName: "P",
      project: { absolutePath: directory },
      prompt: "work",
      state: "recovery_required",
      createdAt: "now",
      updatedAt: "now",
    },
  ];
  const compatibility = createExecutionCompatibility({
    store,
    legacyJobs: () => jobs,
    pollMs: 5,
  });
  try {
    expect(
      compatibility.hasLegacyConflict([
        { resourceKey: join(directory, "nested"), mode: "read" },
      ]),
    ).toBe(true);
    expect(
      compatibility.hasLegacyConflict([
        { resourceKey: directory + "-other", mode: "write" },
      ]),
    ).toBe(false);
    jobs = [{ ...jobs[0]!, state: "succeeded" }];
    expect(
      compatibility.hasLegacyConflict([
        { resourceKey: directory, mode: "write" },
      ]),
    ).toBe(false);
    store.acceptRequest({ requestId: "r", sessionId: "s", text: "work" });
    store.createContext({
      contextId: "c",
      originSessionId: "s",
      title: "Work",
      objective: "Work",
    });
    store.assignRequestContext({
      requestId: "r",
      contextId: "c",
      partId: "0",
      relation: "new",
      instruction: "work",
    });
    store.setContextAgent({
      contextId: "c",
      agentId: "a",
      generation: 1,
      state: "executing",
      currentRequestId: "r",
    });
    const identity = {
      reservationId: "res",
      contextId: "c",
      requestId: "r",
      generation: 1,
    };
    expect(
      reservations.claim({
        ...identity,
        agentId: "a",
        resources: [{ resourceKey: directory, mode: "write" }],
      }).acquired,
    ).toBe(true);
    let authorized = false;
    const waiting = compatibility
      .authorizeLegacy({
        id: "p",
        name: "P",
        absolutePath: directory,
        sensitivePaths: [],
        setupPolicy: "inherit",
      })
      .then(() => (authorized = true));
    await new Promise((r) => setTimeout(r, 15));
    expect(authorized).toBe(false);
    reservations.release(identity);
    await waiting;
    expect(authorized).toBe(true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("holds legacy launch behind uncertain native secondary resources until proven retained idle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-compat-"));
  const store = openProgressStore({ databasePath: join(directory, "progress.sqlite"), ownerKey: "local" });
  try {
    store.acceptRequest({ requestId: "r", sessionId: "s", text: "Work" });
    store.createContext({ contextId: "c", originSessionId: "s", title: "Work", objective: "Work" });
    store.assignRequestContext({ requestId: "r", contextId: "c", partId: "0", relation: "new", instruction: "Work" });
    store.setContextAgent({ contextId: "c", agentId: "a", generation: 1, state: "executing", currentRequestId: "r" });
    const profile = { agent: "codex" as const, model: "gpt-5.6-sol", reason: "test" };
    const admission = store.createWorkerAdmission({});
    admission.enqueue({ attemptId: "attempt", requestId: "r", contextId: "c", generation: 1, projectId: "p", worktreeId: "p::/tmp/other", objective: "Work", access: "write", resources: [{ resourceKey: "external:db", mode: "write" }], dependsOn: [], profile });
    admission.claimNext(); admission.markUnknown("attempt");
    const compatibility = createExecutionCompatibility({ store, legacyJobs: () => [], pollMs: 2 });
    let authorized = false;
    const waiting = compatibility.authorizeLegacy({ id: "p", name: "P", absolutePath: directory, sensitivePaths: [], setupPolicy: "inherit" }).then(() => { authorized = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(authorized).toBe(false);
    admission.bindReceipt({ attemptId: "attempt", runId: "run", taskId: "task", dispatchId: "dispatch", terminalHandle: "term", worktreeId: "p::/tmp/other", requested: profile, effective: { agent: "codex" } });
    admission.settle("attempt", "dispatch", "succeeded", "retained_idle");
    await waiting;
    expect(authorized).toBe(true);
  } finally {
    store.close(); await rm(directory, { recursive: true, force: true });
  }
});
