import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import type { NativeWorkItem, NativeWorkerReceipt } from "@orca-hq/core";
import { openDatabase } from "@orca-hq/persistence";
import { createOrcaRelay } from "../src/orca-relay.js";
import type { NativeLaunchJournalEntry } from "../src/native-launch.js";
import type {
  AuthoritativeNoLaunchProof,
  WorkerAttempt
} from "../src/worker-admission.js";
const project = {
  id: "repo-p",
  name: "P",
  absolutePath: "/safe/P",
  sensitivePaths: [],
  setupPolicy: "inherit",
};
function native() {
  const calls: string[][] = [];
  let task: any;
  let dispatch: any;
  let workerState = "ready";
  const run = async (a: readonly string[]) => {
    calls.push([...a]);
    const flag = (f: string) => a[a.indexOf(f) + 1];
    const result: any =
      a[1] === "run-create"
        ? { run: { id: "run-1" } }
        : a[1] === "task-create"
          ? ((task = {
              id: "task-1",
              run_id: "run-1",
              status: "pending",
              spec: flag("--spec"),
              created_at: "2026-09-07",
            }),
            { task })
          : a[1] === "worker-start"
            ? ((dispatch = {
                id: "dispatch-1",
                task_id: "task-1",
                status: "active",
              }),
              (task.status = "dispatched"),
              {
                dispatchId: "dispatch-1",
                taskId: "task-1",
                runId: "run-1",
                state: "ready",
              })
            : a[1] === "run-list"
              ? { runs: [{ id: "run-1" }] }
              : a[1] === "task-list"
                ? { tasks: task ? [task] : [] }
                : a[1] === "dispatch-show"
                  ? { dispatch }
                  : a[1] === "worker-show"
                    ? {
                        dispatch,
                        worker: {
                          state: workerState,
                          worktree_id: "repo-p::/safe/work",
                        },
                        terminalResource: { releaseState: "unreleased" },
                      }
                    : a[1] === "worker-stop"
                      ? ((workerState = "stopped"), { state: "stopped" })
                      : a[1] === "worker-read"
                        ? { terminal: { lines: ["native output"] } }
                        : {};
    return { id: "native-request", ok: true, result };
  };
  return {
    run,
    calls,
    setStatus: (state: string) => {
      task.status = state;
      workerState = state === "completed" ? "succeeded" : state;
      task.result = JSON.stringify({
        body: "native complete",
        filesModified: ["file.ts"],
      });
    },
  };
}
describe("native Orca relay", () => {
  it("resolves a replacement coordinator before reusing a persisted Run and before each routed call", async () => {
    const n = native();
    const path = join(mkdtempSync(join(tmpdir(), "relay-rebind-")), "db");
    const first = createOrcaRelay({
      databasePath: path,
      coordinatorHandle: "term_old",
      run: n.run,
    });
    await first.start();
    await first.close();
    let live = "term_restored";
    const second = createOrcaRelay({
      databasePath: path,
      coordinatorHandle: "term_old",
      run: n.run,
      resolveCoordinator: async (runId?: string) => {
        expect(runId).toBe("run-1");
        return live;
      },
    });
    try {
      await second.start();
      live = "term_after_another_restart";
      await second.submit({
        requestId: "recovered",
        project,
        prompt: "review",
      });
      const args = n.calls.find((a) => a[1] === "task-create")!;
      expect(args[args.indexOf("--from") + 1]).toBe(
        "term_after_another_restart",
      );
      expect(n.calls.filter((a) => a[1] === "run-create")).toHaveLength(1);
    } finally {
      await second.close();
    }
  });
  it("creates native identities once and returns without awaiting worker readiness", async () => {
    const n = native();
    const e = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: n.run,
    });
    await e.start();
    const j = await e.submit({ requestId: "r", project, prompt: "edit" });
    expect(j.id).toBe("task-1");
    expect(
      (await e.submit({ requestId: "r", project, prompt: "edit" })).id,
    ).toBe(j.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(n.calls.filter((a) => a[1] === "worker-start")).toHaveLength(1);
    const args = n.calls.find((a) => a[1] === "worker-start")!;
    expect(args).toContain("new-top-level");
    expect(args).toContain("id:repo-p");
    expect(args).toContain("run");
    expect(args).toContain("coordinator");
    await e.close();
    expect(n.calls.some((a) => a[1] === "worker-stop")).toBe(false);
  });
  it("keeps get observation-only and releases legacy completion through the explicit policy adapter", async () => {
    const n = native();
    const e = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: n.run,
    });
    await e.start();
    const j = await e.submit({ requestId: "r", project, prompt: "edit" });
    await new Promise((r) => setTimeout(r, 10));
    n.setStatus("completed");
    const observed = await e.get(j.id);
    expect(observed.state).toBe("succeeded");
    expect(observed.result?.summary).toBe("native complete");
    expect(n.calls.some((a) => a[1] === "worker-release")).toBe(false);
    await e.applyLegacyCompletionPolicy(j.id);
    expect(
      n.calls.some(
        (a) => a[1] === "worker-release" && a.includes("dispatch-1"),
      ),
    ).toBe(true);
    await e.close();
  });
  it("sends running followup through stable dispatch messaging and stops exact dispatch", async () => {
    const n = native();
    const e = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: n.run,
    });
    await e.start();
    const j = await e.submit({ requestId: "r", project, prompt: "edit" });
    await new Promise((r) => setTimeout(r, 10));
    await e.followup(j.id, "also test", "follow");
    await e.followup(j.id, "also test", "follow");
    expect(n.calls.filter((a) => a[1] === "send")).toHaveLength(1);
    expect(n.calls.find((a) => a[1] === "send")).toContain(
      "dispatch:dispatch-1",
    );
    expect((await e.stop(j.id)).state).toBe("stopped");
    await e.close();
  });
  it("does not restart an unknown worker effect after reload", async () => {
    const n = native();
    let starts = 0;
    const run = async (a: readonly string[]) => {
      if (a[1] === "worker-start") {
        starts++;
        throw Error("lost response");
      }
      return n.run(a);
    };
    const path = join(mkdtempSync(join(tmpdir(), "relay-")), "db");
    const e = createOrcaRelay({
      databasePath: path,
      coordinatorHandle: "coordinator",
      run,
    });
    await e.start();
    await e.submit({ requestId: "r", project, prompt: "edit" });
    await new Promise((r) => setTimeout(r, 10));
    await e.close();
    const second = createOrcaRelay({
      databasePath: path,
      coordinatorHandle: "coordinator",
      run,
    });
    await second.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(starts).toBe(1);
    await second.close();
  });
  it("marks a persisted worker-sent crash window unknown when reconciliation is unavailable", async () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "relay-worker-sent-")),
      "relay.sqlite",
    );
    const db = openDatabase(databasePath);
    db.exec(
      "CREATE TABLE orca_relay_requests(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE orca_relay_snapshots(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE orca_relay_meta(id TEXT PRIMARY KEY,body TEXT NOT NULL)",
    );
    const execution = { contextId: "ctx", requestId: "request", generation: 7 };
    db.prepare("INSERT INTO orca_relay_meta VALUES('coordinator',?)").run(
      JSON.stringify({ coordinatorHandle: "coordinator", runId: "run-1" }),
    );
    db.prepare("INSERT INTO orca_relay_requests VALUES(?,?)").run(
      "request",
      JSON.stringify({
        id: "request",
        kind: "submit",
        project,
        prompt: "work",
        phase: "worker_sent",
        taskId: "task-1",
        worktreeId: "repo-p::/safe/work",
        execution,
      }),
    );
    db.prepare("INSERT INTO orca_relay_snapshots VALUES(?,?)").run(
      "task-1",
      JSON.stringify({
        id: "task-1",
        runId: "run-1",
        projectId: project.id,
        project,
        projectName: project.name,
        prompt: "work",
        state: "queued",
        nativeStatus: "pending",
        createdAt: "2026-09-08",
        updatedAt: "2026-09-08",
        worktreeId: "repo-p::/safe/work",
        worktreePath: "/safe/work",
        execution,
      }),
    );
    db.close();
    const calls: string[][] = [];
    const relay = createOrcaRelay({
      databasePath,
      coordinatorHandle: "coordinator",
      run: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === "task-list")
          throw new Error("native reconciliation unavailable");
        const result =
          argv[1] === "dispatch-show"
              ? {}
              : argv[1] === "run-list"
                ? { runs: [{ id: "run-1" }] }
                : {};
        return { ok: true, result };
      },
      pollIntervalMs: 100000,
    });
    try {
      await relay.start();
      expect(relay.getCached("task-1")).toMatchObject({
        state: "recovery_required",
        nativeStatus: "worker_start_outcome_unknown",
        execution,
      });
      expect(calls.some((call) => call[1] === "worker-start")).toBe(false);
    } finally {
      await relay.close();
    }
  });
  it("does not adopt a task-level dispatch after losing the worker-start response", async () => {
    const n = native();
    let starts = 0;
    const relay = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: async (argv) => {
        if (argv[1] === "worker-start") {
          starts++;
          await n.run(argv);
          throw new Error("worker-start response lost");
        }
        return n.run(argv);
      },
      pollIntervalMs: 100000,
    });
    try {
      await relay.start();
      const job = await relay.submit({
        requestId: "lost-receipt",
        project,
        prompt: "work",
      });
      await vi.waitFor(() => expect(starts).toBe(1));
      await vi.waitFor(async () =>
        expect(await relay.get(job.id)).toMatchObject({
          state: "recovery_required",
          nativeStatus: "worker_start_outcome_unknown",
        }),
      );
      expect((await relay.get(job.id)).dispatchId).toBeUndefined();
      expect((await relay.get(job.id)).relayWarning).toContain(
        "worker-start response lost",
      );
      expect(starts).toBe(1);
    } finally {
      await relay.close();
    }
  });
  it("reconciles only an exact dispatch ID already persisted as launch-owned", async () => {
    const n = native();
    let starts = 0;
    let failFirstObservation = true;
    const relay = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: async (argv) => {
        if (argv[1] === "worker-start") starts++;
        if (
          argv[1] === "task-list" &&
          starts === 1 &&
          failFirstObservation
        ) {
          failFirstObservation = false;
          throw new Error("first observation unavailable");
        }
        return n.run(argv);
      },
      pollIntervalMs: 100000,
    });
    try {
      await relay.start();
      const job = await relay.submit({
        requestId: "owned-receipt",
        project,
        prompt: "work",
      });
      await vi.waitFor(() => expect(starts).toBe(1));
      await vi.waitFor(async () =>
        expect(await relay.get(job.id)).toMatchObject({
          state: "running",
          dispatchId: "dispatch-1",
        }),
      );
      expect((await relay.get(job.id)).relayWarning).toBeUndefined();
      expect(starts).toBe(1);
    } finally {
      await relay.close();
    }
  });
  it("discovers native tasks absent from HQ cache without lifecycle mutations", async () => {
    const n = native();
    await n.run(["orchestration", "task-create", "--spec", "external"]);
    await n.run(["orchestration", "worker-start"]);
    n.calls.length = 0;
    const e = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: n.run,
    });
    await e.start();
    expect((await e.list()).map((j) => j.id)).toContain("task-1");
    await e.close();
    expect(
      n.calls.some((a) =>
        ["worker-release", "worker-stop", "worker-start"].includes(a[1]!),
      ),
    ).toBe(false);
  });
  it("blocks protected HQ projects before native mutations", async () => {
    const n = native();
    const e = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "coordinator",
      run: n.run,
    });
    await e.start();
    await expect(
      e.submit({
        requestId: "p",
        project: {
          ...project,
          sensitivePaths: [
            "docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md",
          ],
        },
        prompt: "edit",
      }),
    ).rejects.toThrow("보호");
    expect(
      n.calls.some((a) => ["task-create", "worker-start"].includes(a[1]!)),
    ).toBe(false);
    await e.close();
  });
});

it("rejects a requested worktree belonging to another project", async () => {
  const n = native();
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run: n.run,
  });
  await e.start();
  await expect(
    e.submit({
      requestId: "wt",
      project,
      prompt: "review",
      worktree: "other::/safe/work",
    }),
  ).rejects.toThrow();
  expect(n.calls.some((a) => a[1] === "worker-start")).toBe(false);
  await e.close();
});
it("does not acquire cleanup ownership by sending guidance to an external task", async () => {
  const n = native();
  await n.run(["orchestration", "task-create", "--spec", "external"]);
  await n.run(["orchestration", "worker-start"]);
  n.calls.length = 0;
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run: n.run,
  });
  await e.start();
  await e.followup("task-1", "test also", "follow-external");
  n.setStatus("completed");
  await e.get("task-1");
  expect(n.calls.some((a) => a[1] === "worker-release")).toBe(false);
  await e.close();
});
it("keeps native completion visible if cleanup is unavailable", async () => {
  const n = native();
  const run = async (a: readonly string[]) => {
    if (a[1] === "worker-release") throw Error("offline");
    return n.run(a);
  };
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run,
  });
  await e.start();
  const j = await e.submit({ requestId: "cleanup", project, prompt: "edit" });
  await new Promise((r) => setTimeout(r, 10));
  n.setStatus("completed");
  await e.get(j.id);
  const observed = await e.applyLegacyCompletionPolicy(j.id);
  expect(observed.state).toBe("succeeded");
  expect(observed.relayWarning).toContain("정리");
  await e.close();
});
it("preserves automatic legacy cleanup for execution-tagged progress requests", async () => {
  const n = native();
  const relay = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    authorizeExecution: async () => {},
    run: async (args) => {
      const response = await n.run(args);
      if (args[1] === "worker-start") n.setStatus("completed");
      return response;
    }
  });
  try {
    await relay.start();
    await relay.submit({
      requestId: "legacy-progress",
      project,
      prompt: "work",
      execution: { contextId: "context", requestId: "request", generation: 1 }
    });
    await vi.waitFor(() => expect(
      n.calls.some(args => args[1] === "worker-release" && args.includes("dispatch-1"))
    ).toBe(true));
  } finally {
    await relay.close();
  }
});

const nativeItem: NativeWorkItem = {
  attemptId: "attempt-native",
  requestId: "request-native",
  contextId: "context-native",
  generation: 2,
  projectId: "repo-p",
  worktreeId: "repo-p::/safe/work",
  objective: "Implement the native task",
  access: "write",
  resources: [{ resourceKey: "checkout:/safe/work", mode: "write" }],
  dependsOn: [],
  profile: {
    agent: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    reason: "Implementation profile"
  }
};

function nativeAdmission(
  work: NativeWorkItem = nativeItem,
  state: WorkerAttempt["state"] = "launching",
  prior: WorkerAttempt[] = []
) {
  const attempts: WorkerAttempt[] = [{
    sequence: prior.length + 1,
    item: work,
    state,
    receipt: null,
    outcome: null,
    resourceVerdict: null,
    claimEpoch: 1,
    reconciledEpoch: 1,
    noLaunchProof: null
  }, ...prior];
  const receipts: NativeWorkerReceipt[] = [];
  const proofs: AuthoritativeNoLaunchProof[] = [];
  let unknown = 0;
  let fenced = false;
  return {
    port: {
      listAttempts: () => structuredClone(attempts),
      assertLaunchAuthorized: (attemptId: string) => {
        if (fenced) throw new Error("coordinator_fenced");
        const attempt = attempts.find(candidate => candidate.item.attemptId === attemptId);
        if (!attempt || !["launching", "unknown"].includes(attempt.state)) {
          throw new Error("native_attempt_not_admitted");
        }
        return structuredClone(attempt.item);
      },
      bindReceipt: (receipt: NativeWorkerReceipt) => { receipts.push(receipt); },
      markUnknown: () => { unknown++; },
      recoverProvenNoLaunch: (proof: AuthoritativeNoLaunchProof) => {
        proofs.push(proof);
        return true;
      }
    },
    receipts,
    proofs,
    unknown: () => unknown,
    fence: () => { fenced = true; }
  };
}

function nativeLaunchTransport() {
  const calls: string[][] = [];
  let taskCreate: (args: readonly string[]) => unknown = () => ({
    task: { id: "task-native", run_id: "run-native", status: "pending", created_at: "2026-09-08" }
  });
  let workerStart: (args: readonly string[]) => unknown = () => ({
    dispatchId: "dispatch-native",
    taskId: "task-native",
    runId: "run-native",
    state: "ready"
  });
  let shownState = "ready";
  let shownTerminalHandle = "term-native";
  let requestState = "absent";
  let worktreePath = "/safe/work";
  let priorSessionId = "session-retained";
  let terminalIdle = true;
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "terminal" && args[1] === "wait") {
      return terminalIdle
        ? { id: `cli-${calls.length}`, ok: true, result: { state: "idle" } }
        : { id: `cli-${calls.length}`, ok: false, error: { message: "terminal_busy" } };
    }
    const command = args[1];
    const result = command === "run-create"
      ? { run: { id: "run-native" } }
      : command === "worktree"
        ? {}
        : command === "task-create"
          ? await taskCreate(args)
          : command === "worker-start"
            ? await workerStart(args)
            : command === "worker-show"
              ? args.includes("dispatch-prior")
                ? {
                    dispatch: { id: "dispatch-prior", task_id: "task-prior", run_id: "run-native" },
                    worker: { state: "succeeded" },
                    terminal: {
                      handle: "term-retained",
                      incarnationId: priorSessionId,
                      worktreeId: nativeItem.worktreeId,
                      connected: true,
                      writable: true,
                      agentIdentity: "codex"
                    },
                    observation: { status: "live", exactWorker: true },
                    terminalResource: {
                      ownershipState: "owned",
                      releaseState: "retained",
                      terminalHandle: "term-retained",
                      ownerDispatchId: "dispatch-prior"
                    }
                  }
                : {
                  dispatch: { id: "dispatch-native", task_id: "task-native", run_id: "run-native" },
                  worker: {
                    state: shownState,
                    stage: shownState === "ready" ? "input_accepted" : "starting",
                    worktree_id: nativeItem.worktreeId,
                    agent_terminal_handle: shownTerminalHandle,
                    startOptions: {
                      terminal: shownTerminalHandle === "term-native" ? null : shownTerminalHandle,
                      resolvedWorktreeId: nativeItem.worktreeId,
                      launch: shownTerminalHandle === "term-native"
                        ? {
                            requested: { agent: "codex", model: "gpt-5.6-sol", effort: "high" },
                            effective: { agent: "codex", model: "gpt-5.6-sol", effort: "high" }
                          }
                        : null
                    }
                  },
                  terminal: {
                    handle: shownTerminalHandle,
                    incarnationId: "session-native",
                    worktreeId: nativeItem.worktreeId,
                    connected: true,
                    writable: true,
                    agentIdentity: "codex"
                  },
                  observation: { status: "live", exactWorker: true },
                  terminalResource: {
                    ownershipState: "owned",
                    releaseState: "not_requested",
                    terminalHandle: shownTerminalHandle,
                    ownerDispatchId: "dispatch-native"
                  }
                }
              : command === "request-show"
                ? { state: requestState }
                : command === "repo"
                  ? { repo: { path: "/safe/P", displayName: "P" } }
                  : command === "task-list"
                    ? { tasks: [] }
                    : command === "run-list"
                      ? { runs: [{ id: "run-native" }] }
                      : args[0] === "worktree" && args[1] === "show"
                        ? { worktree: { id: nativeItem.worktreeId, repoId: "repo-p", path: worktreePath } }
                        : {};
    const retryIndex = args.indexOf("--retry-request");
    const mutationRequestId = retryIndex >= 0
      ? String(args[retryIndex + 1])
      : `mutation-${String(command)}-${calls.length}`;
    const mutationResult = ["run-create", "task-create", "worker-start"].includes(String(command))
      ? { ...result as Record<string, unknown>, mutation: { requestId: mutationRequestId, replayed: retryIndex >= 0 } }
      : result;
    return {
      id: `cli-${calls.length}`,
      ok: true,
      result: mutationResult
    };
  };
  return {
    calls,
    run,
    setTaskCreate: (next: typeof taskCreate) => { taskCreate = next; },
    setWorkerStart: (next: typeof workerStart) => { workerStart = next; },
    setShownState: (state: string) => { shownState = state; },
    setShownTerminalHandle: (handle: string) => { shownTerminalHandle = handle; },
    setRequestState: (state: string) => { requestState = state; },
    setWorktreePath: (path: string) => { worktreePath = path; },
    setPriorSessionId: (id: string) => { priorSessionId = id; },
    setTerminalIdle: (idle: boolean) => { terminalIdle = idle; }
  };
}

describe("admitted native launch relay", () => {
  it("journals identities and mutations before effects, then returns only an observed truthful receipt", async () => {
    const transport = nativeLaunchTransport();
    const admission = nativeAdmission();
    const relay = createOrcaRelay({
      databasePath: ":memory:",
      coordinatorHandle: "term-coordinator",
      run: transport.run,
      nativeAdmission: admission.port,
      resolveNativeProject: async () => project,
      nativeRetentionPolicy: "retain"
    });
    try {
      await relay.start();
      const result = await relay.startNativeWork(nativeItem);
      expect(result).toMatchObject({ state: "ready", receipt: {
        attemptId: nativeItem.attemptId,
        runId: "run-native",
        taskId: "task-native",
        dispatchId: "dispatch-native",
        terminalHandle: "term-native",
        worktreeId: nativeItem.worktreeId,
        requested: nativeItem.profile,
        effective: { agent: "codex", model: "gpt-5.6-sol", effort: "high" }
      } });
      expect(admission.receipts).toHaveLength(1);
      const journal = relay.getNativeLaunch(nativeItem.attemptId);
      expect(journal).toMatchObject({
        attemptId: nativeItem.attemptId,
        runId: "run-native",
        taskId: "task-native",
        dispatchId: "dispatch-native",
        terminalHandle: "term-native",
        worktreeId: nativeItem.worktreeId,
        requested: nativeItem.profile,
        retentionPolicy: "retain",
        phase: "ready"
      });
      expect(journal.mutationRequestIds.task).toMatch(/^mutation-task-create-/);
      expect(journal.mutationRequestIds.worker).toMatch(/^mutation-worker-start-/);
      const taskCall = transport.calls.find(call => call[1] === "task-create")!;
      const workerCall = transport.calls.find(call => call[1] === "worker-start")!;
      expect(taskCall).not.toContain("--retry-request");
      expect(workerCall).toEqual(expect.arrayContaining([
        "--worktree", `id:${nativeItem.worktreeId}`,
        "--agent", "codex", "--model", "gpt-5.6-sol", "--effort", "high"
      ]));
      expect(workerCall).not.toContain("--retry-request");
      expect(transport.calls.some(call => call[1] === "worker-release")).toBe(false);
    } finally {
      await relay.close();
    }
  });

  it("rejects a non-admitted item before any task or worker mutation", async () => {
    const transport = nativeLaunchTransport();
    const admission = nativeAdmission(nativeItem, "queued");
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "release"
    });
    try {
      await relay.start();
      await expect(relay.startNativeWork(nativeItem)).rejects.toThrow("native_attempt_not_admitted");
      expect(transport.calls.some(call => ["task-create", "worker-start"].includes(call[1]!))).toBe(false);
    } finally { await relay.close(); }
  });

  it("rechecks the admission epoch after placement reads and before task mutation", async () => {
    const transport = nativeLaunchTransport();
    const admission = nativeAdmission();
    admission.fence();
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "release"
    });
    try {
      await relay.start();
      await expect(relay.startNativeWork(nativeItem)).rejects.toThrow("coordinator_fenced");
      expect(transport.calls.some(call => call[0] === "worktree" && call[1] === "show")).toBe(true);
      expect(transport.calls.some(call => ["task-create", "worker-start"].includes(call[1]!))).toBe(false);
    } finally { await relay.close(); }
  });

  it("rechecks the admission fence after asynchronous coordinator resolution before worker mutation", async () => {
    const transport = nativeLaunchTransport();
    const admission = nativeAdmission();
    let coordinatorCalls = 0;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      resolveCoordinator: async () => {
        coordinatorCalls++;
        if (coordinatorCalls === 4) {
          entered();
          await gate;
        }
        return "term_coordinator";
      },
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "release"
    });
    try {
      await relay.start();
      const starting = relay.startNativeWork(nativeItem);
      await waiting;
      admission.fence();
      release();
      await expect(starting).rejects.toThrow("coordinator_fenced");
      expect(transport.calls.some(call => call[1] === "worker-start")).toBe(false);
    } finally {
      release();
      await relay.close();
    }
  });

  it("rejects an observed worktree path that is not the admitted primary checkout claim", async () => {
    const transport = nativeLaunchTransport();
    transport.setWorktreePath("/safe/other");
    const admission = nativeAdmission();
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "release"
    });
    try {
      await relay.start();
      await expect(relay.startNativeWork(nativeItem)).rejects.toThrow("native_primary_checkout_mismatch");
      expect(transport.calls.some(call => ["task-create", "worker-start"].includes(call[1]!))).toBe(false);
    } finally { await relay.close(); }
  });

  it("persists task and worker mutation intent before waiting for worker-start", async () => {
    const transport = nativeLaunchTransport();
    let finish!: (value: unknown) => void;
    transport.setWorkerStart(() => new Promise(resolve => { finish = resolve; }));
    const admission = nativeAdmission();
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "retain"
    });
    try {
      await relay.start();
      const starting = relay.startNativeWork(nativeItem);
      await vi.waitFor(() => expect(transport.calls.some(call => call[1] === "worker-start")).toBe(true));
      expect(relay.getNativeLaunch(nativeItem.attemptId)).toMatchObject({
        phase: "worker_sent",
        runId: "run-native",
        taskId: "task-native",
        dispatchId: null,
        terminalHandle: null,
        mutationIntentIds: {
          task: expect.stringMatching(/^intent_/),
          worker: expect.stringMatching(/^intent_/)
        },
        mutationRequestIds: {
          task: expect.stringMatching(/^mutation-task-create-/),
          worker: null
        }
      });
      finish({ dispatchId: "dispatch-native", taskId: "task-native", runId: "run-native", state: "ready" });
      await expect(starting).resolves.toMatchObject({ state: "ready" });
    } finally { await relay.close(); }
  });

  it("drains an admitted in-flight worker mutation before closing its durable journal", async () => {
    const transport = nativeLaunchTransport();
    let finish!: (value: unknown) => void;
    transport.setWorkerStart(() => new Promise(resolve => { finish = resolve; }));
    const admission = nativeAdmission();
    const databasePath = join(mkdtempSync(join(tmpdir(), "relay-native-close-worker-")), "relay.sqlite");
    const relay = createOrcaRelay({
      databasePath, coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "retain"
    });
    await relay.start();
    const starting = relay.startNativeWork(nativeItem);
    await vi.waitFor(() => expect(transport.calls.some(call => call[1] === "worker-start")).toBe(true));
    const closing = relay.close();
    finish({ dispatchId: "dispatch-native", taskId: "task-native", runId: "run-native", state: "ready" });
    await expect(starting).resolves.toMatchObject({ state: "ready" });
    await expect(closing).resolves.toBeUndefined();
    const db = openDatabase(databasePath);
    const stored = db.prepare("SELECT body FROM orca_native_launches WHERE attempt_id=?")
      .get(nativeItem.attemptId) as { body: string };
    expect(JSON.parse(stored.body)).toMatchObject({
      phase: "ready",
      taskId: "task-native",
      dispatchId: "dispatch-native",
      terminalHandle: "term-native",
      receipt: {
        attemptId: nativeItem.attemptId,
        dispatchId: "dispatch-native",
        terminalHandle: "term-native"
      }
    });
    db.close();
  });

  it("persists an accepted task but does not start its worker after relay close begins", async () => {
    const transport = nativeLaunchTransport();
    let finish!: (value: unknown) => void;
    transport.setTaskCreate(() => new Promise(resolve => { finish = resolve; }));
    const admission = nativeAdmission();
    const databasePath = join(mkdtempSync(join(tmpdir(), "relay-native-close-task-")), "relay.sqlite");
    const relay = createOrcaRelay({
      databasePath, coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "retain"
    });
    await relay.start();
    const starting = relay.startNativeWork(nativeItem);
    await vi.waitFor(() => expect(transport.calls.some(call => call[1] === "task-create")).toBe(true));
    const closing = relay.close();
    finish({ task: { id: "task-native", run_id: "run-native", status: "pending" } });
    await expect(starting).resolves.toMatchObject({
      state: "recovery_required",
      taskId: "task-native"
    });
    await expect(closing).resolves.toBeUndefined();
    expect(transport.calls.some(call => call[1] === "worker-start")).toBe(false);
    const db = openDatabase(databasePath);
    const stored = db.prepare("SELECT body FROM orca_native_launches WHERE attempt_id=?")
      .get(nativeItem.attemptId) as { body: string };
    expect(JSON.parse(stored.body)).toMatchObject({
      phase: "recovery_required",
      taskId: "task-native",
      dispatchId: null,
      terminalHandle: null
    });
    db.close();
  });

  it("reuses an exact retained same-context terminal without launch-profile flags", async () => {
    const reused = { ...nativeItem, resumeTerminalHandle: "term-retained" };
    const priorReceipt: NativeWorkerReceipt = {
      attemptId: "attempt-prior",
      runId: "run-native",
      taskId: "task-prior",
      dispatchId: "dispatch-prior",
      terminalHandle: "term-retained",
      worktreeId: nativeItem.worktreeId,
      requested: nativeItem.profile,
      effective: { agent: "codex", model: "gpt-5.6-sol", effort: "high" }
    };
    const prior: WorkerAttempt = {
      sequence: 1,
      item: { ...nativeItem, attemptId: "attempt-prior" },
      state: "settled",
      receipt: priorReceipt,
      outcome: "succeeded",
      resourceVerdict: "retained_idle",
      claimEpoch: 1,
      reconciledEpoch: 1,
      noLaunchProof: null
    };
    const transport = nativeLaunchTransport();
    transport.setShownTerminalHandle("term-retained");
    const admission = nativeAdmission(reused, "launching", [prior]);
    const databasePath = join(mkdtempSync(join(tmpdir(), "relay-native-reuse-")), "relay.sqlite");
    const relay = createOrcaRelay({
      databasePath, coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "retain"
    });
    try {
      const db = openDatabase(databasePath);
      const priorJournal: NativeLaunchJournalEntry = {
        attemptId: prior.item.attemptId,
        item: prior.item,
        phase: "ready",
        mutationIntentIds: { task: "intent-task-prior", worker: "intent-worker-prior" },
        mutationRequestIds: { task: "mutation-task-prior", worker: "mutation-worker-prior" },
        runId: priorReceipt.runId,
        taskId: priorReceipt.taskId,
        dispatchId: priorReceipt.dispatchId,
        terminalHandle: priorReceipt.terminalHandle,
        terminalSessionId: "session-retained",
        worktreeId: priorReceipt.worktreeId,
        requested: priorReceipt.requested,
        effective: priorReceipt.effective,
        retentionPolicy: "retain",
        receipt: priorReceipt,
        noLaunchProof: null,
        warning: null,
        residualResources: []
      };
      db.prepare("INSERT INTO orca_native_launches(attempt_id,body) VALUES(?,?)")
        .run(prior.item.attemptId, JSON.stringify(priorJournal));
      db.close();
      await relay.start();
      await expect(relay.startNativeWork(reused)).resolves.toMatchObject({
        state: "ready",
        receipt: { terminalHandle: "term-retained" }
      });
      const args = transport.calls.find(call => call[1] === "worker-start")!;
      expect(args).toEqual(expect.arrayContaining([
        "--worktree", `id:${nativeItem.worktreeId}`,
        "--terminal", "term-retained"
      ]));
      expect(args).not.toContain("--agent");
      expect(args).not.toContain("--model");
      expect(args).not.toContain("--effort");
    } finally { await relay.close(); }
  });

  it.each([
    ["replacement session", { session: "session-replaced", idle: true }],
    ["busy terminal", { session: "session-retained", idle: false }]
  ] as const)("rejects retained-terminal reuse after %s observation", async (_case, observation) => {
    const reused = { ...nativeItem, resumeTerminalHandle: "term-retained" };
    const priorReceipt: NativeWorkerReceipt = {
      attemptId: "attempt-prior", runId: "run-native", taskId: "task-prior",
      dispatchId: "dispatch-prior", terminalHandle: "term-retained",
      worktreeId: nativeItem.worktreeId, requested: nativeItem.profile,
      effective: { agent: "codex", model: "gpt-5.6-sol", effort: "high" }
    };
    const prior: WorkerAttempt = {
      sequence: 1, item: { ...nativeItem, attemptId: "attempt-prior" }, state: "settled",
      receipt: priorReceipt, outcome: "succeeded", resourceVerdict: "retained_idle",
      claimEpoch: 1, reconciledEpoch: 1, noLaunchProof: null
    };
    const transport = nativeLaunchTransport();
    transport.setShownTerminalHandle("term-retained");
    transport.setPriorSessionId(observation.session);
    transport.setTerminalIdle(observation.idle);
    const admission = nativeAdmission(reused, "launching", [prior]);
    const databasePath = join(mkdtempSync(join(tmpdir(), "relay-native-reuse-reject-")), "relay.sqlite");
    const relay = createOrcaRelay({
      databasePath, coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "retain"
    });
    try {
      const db = openDatabase(databasePath);
      db.prepare("INSERT INTO orca_native_launches(attempt_id,body) VALUES(?,?)").run(
        prior.item.attemptId,
        JSON.stringify({
          attemptId: prior.item.attemptId, item: prior.item, phase: "ready",
          mutationIntentIds: { task: "intent-task", worker: "intent-worker" },
          mutationRequestIds: { task: "task-request", worker: "worker-request" },
          runId: "run-native", taskId: "task-prior", dispatchId: "dispatch-prior",
          terminalHandle: "term-retained", terminalSessionId: "session-retained",
          worktreeId: nativeItem.worktreeId, requested: nativeItem.profile,
          effective: priorReceipt.effective, retentionPolicy: "retain", receipt: priorReceipt,
          noLaunchProof: null, warning: null, residualResources: []
        } satisfies NativeLaunchJournalEntry)
      );
      db.close();
      await relay.start();
      await expect(relay.startNativeWork(reused)).rejects.toThrow("terminal_reuse_not_authorized");
      expect(transport.calls.some(call => call[1] === "task-create")).toBe(false);
    } finally { await relay.close(); }
  });

  it("never retries an absent lost-reply mutation or falls back to another model", async () => {
    const transport = nativeLaunchTransport();
    transport.setWorkerStart(() => { throw new Error("worker-start transport lost"); });
    const admission = nativeAdmission();
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "release"
    });
    try {
      await relay.start();
      await expect(relay.startNativeWork(nativeItem)).resolves.toMatchObject({ state: "recovery_required" });
      await expect(relay.startNativeWork(nativeItem)).resolves.toMatchObject({ state: "recovery_required" });
      expect(transport.calls.filter(call => call[1] === "worker-start")).toHaveLength(1);
      expect(transport.calls.filter(call => call[1] === "request-show")).toHaveLength(0);
      expect(transport.calls.some(call => call.includes("gpt-6-astra"))).toBe(false);
      expect(admission.unknown()).toBeGreaterThan(0);
    } finally { await relay.close(); }
  });

  it("replays a completed lost reply only with the original mutation identity", async () => {
    const transport = nativeLaunchTransport();
    let attempts = 0;
    transport.setWorkerStart(() => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("worker-start response lost"), {
        receipt: {
          id: "mutation-worker-actual",
          ok: false,
          error: {
            message: "response lost",
            data: {
              disposition: "outcome_unknown",
              orchestrationRequestId: "mutation-worker-actual"
            }
          }
        }
      });
      return { dispatchId: "dispatch-native", taskId: "task-native", runId: "run-native", state: "ready" };
    });
    transport.setRequestState("completed");
    const admission = nativeAdmission();
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "release"
    });
    try {
      await relay.start();
      await expect(relay.startNativeWork(nativeItem)).resolves.toMatchObject({ state: "recovery_required" });
      await expect(relay.startNativeWork(nativeItem)).resolves.toMatchObject({ state: "ready" });
      const starts = transport.calls.filter(call => call[1] === "worker-start");
      expect(starts).toHaveLength(2);
      expect(starts[0]).not.toContain("--retry-request");
      expect(starts[1]).toEqual(expect.arrayContaining(["--retry-request", "mutation-worker-actual"]));
      expect(starts.every(call => call.includes("gpt-5.6-sol"))).toBe(true);
    } finally { await relay.close(); }
  });

  it("adopts a late ready observation for the exact dispatch without a second launch mutation", async () => {
    const transport = nativeLaunchTransport();
    let first = true;
    transport.setWorkerStart(() => {
      if (first) {
        first = false;
        return { dispatchId: "dispatch-native", taskId: "task-native", runId: "run-native", state: "outcome_unknown" };
      }
      throw new Error("must not launch twice");
    });
    transport.setShownState("starting");
    const admission = nativeAdmission();
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "retain"
    });
    try {
      await relay.start();
      await expect(relay.startNativeWork(nativeItem)).resolves.toMatchObject({ state: "recovery_required" });
      transport.setShownState("ready");
      await expect(relay.startNativeWork(nativeItem)).resolves.toMatchObject({ state: "ready" });
      expect(transport.calls.filter(call => call[1] === "worker-start")).toHaveLength(1);
    } finally { await relay.close(); }
  });

  it("turns only a failed start with no terminal effects or residuals into authoritative no-launch recovery", async () => {
    const transport = nativeLaunchTransport();
    transport.setWorkerStart(() => ({
      state: "failed",
      failedStage: "terminal_create",
      taskId: "task-native",
      runId: "run-native",
      worktreeId: nativeItem.worktreeId,
      effects: [
        { kind: "worktree", action: "reused", id: nativeItem.worktreeId },
        { kind: "setup", action: "not_applicable", state: "not_applicable" }
      ],
      residualResources: []
    }));
    const admission = nativeAdmission();
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "release"
    });
    try {
      await relay.start();
      await expect(relay.startNativeWork(nativeItem)).resolves.toMatchObject({ state: "proven_no_launch" });
      expect(admission.proofs).toHaveLength(1);
      expect(admission.receipts).toHaveLength(0);
      expect(transport.calls.filter(call => call[1] === "worker-start")).toHaveLength(1);
    } finally { await relay.close(); }
  });

  it.each([
    ["foreign task", { taskId: "task-foreign" }],
    ["missing identities", { taskId: undefined, runId: undefined, worktreeId: undefined }],
    ["unknown effect", { effects: [{ kind: "process", action: "created", id: "pid-1" }] }],
    ["unknown stage", { failedStage: "mystery_stage" }]
  ] as const)("keeps %s no-launch claims occupied as recovery-required", async (_case, patch) => {
    const transport = nativeLaunchTransport();
    transport.setShownState("failed");
    transport.setWorkerStart(() => ({
      state: "failed",
      failedStage: "terminal_create",
      taskId: "task-native",
      runId: "run-native",
      worktreeId: nativeItem.worktreeId,
      effects: [
        { kind: "worktree", action: "reused", id: nativeItem.worktreeId },
        { kind: "setup", action: "not_applicable", state: "not_applicable" }
      ],
      residualResources: [],
      ...patch
    }));
    const admission = nativeAdmission();
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "release"
    });
    try {
      await relay.start();
      await expect(relay.startNativeWork(nativeItem)).resolves.toMatchObject({ state: "recovery_required" });
      expect(admission.proofs).toHaveLength(0);
      expect(admission.unknown()).toBeGreaterThan(0);
    } finally { await relay.close(); }
  });

  it("rejects a concurrent changed item instead of joining the admitted attempt launch", async () => {
    const transport = nativeLaunchTransport();
    let finish!: (value: unknown) => void;
    transport.setWorkerStart(() => new Promise(resolve => { finish = resolve; }));
    const admission = nativeAdmission();
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "retain"
    });
    try {
      await relay.start();
      const starting = relay.startNativeWork(nativeItem);
      await vi.waitFor(() => expect(transport.calls.some(call => call[1] === "worker-start")).toBe(true));
      await expect(relay.startNativeWork({ ...nativeItem, objective: "Changed objective" }))
        .rejects.toThrow("native_launch_collision");
      finish({ dispatchId: "dispatch-native", taskId: "task-native", runId: "run-native", state: "ready" });
      await starting;
    } finally { await relay.close(); }
  });

  it("keeps failed startup with residual terminal resources occupied for recovery", async () => {
    const transport = nativeLaunchTransport();
    transport.setShownState("failed");
    transport.setWorkerStart(() => ({
      dispatchId: "dispatch-native",
      taskId: "task-native",
      runId: "run-native",
      state: "failed",
      failedStage: "input_delivery",
      effects: [{ kind: "terminal", action: "created", id: "term-native" }],
      residualResources: [{ kind: "terminal", action: "created", id: "term-native" }],
      cleanup: { state: "release_unknown" }
    }));
    const admission = nativeAdmission();
    const relay = createOrcaRelay({
      databasePath: ":memory:", coordinatorHandle: "term-coordinator", run: transport.run,
      nativeAdmission: admission.port, resolveNativeProject: async () => project,
      nativeRetentionPolicy: "release"
    });
    try {
      await relay.start();
      await expect(relay.startNativeWork(nativeItem)).resolves.toMatchObject({
        state: "recovery_required",
        dispatchId: "dispatch-native",
        residualResources: [{ kind: "terminal", id: "term-native" }]
      });
      expect(relay.getNativeLaunch(nativeItem.attemptId)).toMatchObject({
        dispatchId: "dispatch-native",
        terminalHandle: "term-native",
        retentionPolicy: "release"
      });
      expect(admission.proofs).toHaveLength(0);
      expect(admission.unknown()).toBeGreaterThan(0);
    } finally { await relay.close(); }
  });
});
it("drains an accepted native task-create on relay close without launching a worker", async () => {
  const n = native();
  let release!: () => void;
  const run = async (a: readonly string[]) => {
    if (a[1] === "task-create") await new Promise<void>((r) => (release = r));
    return n.run(a);
  };
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run,
  });
  await e.start();
  const submitted = e.submit({ requestId: "drain", project, prompt: "edit" });
  await new Promise((r) => setTimeout(r, 10));
  const closing = e.close();
  release();
  expect((await submitted).id).toBe("task-1");
  await closing;
  expect(n.calls.some((a) => a[1] === "worker-start")).toBe(false);
});
it("rejects a direct protected-file prompt even in a safe project", async () => {
  const n = native();
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run: n.run,
  });
  await e.start();
  await expect(
    e.submit({
      requestId: "protected-prompt",
      project,
      prompt:
        "Read docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md",
    }),
  ).rejects.toThrow("보호");
  expect(n.calls.some((a) => a[1] === "task-create")).toBe(false);
  await e.close();
});
it("propagates protection and sensitive path rules to native task and followup messages", async () => {
  const n = native();
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run: n.run,
  });
  await e.start();
  const j = await e.submit({
    requestId: "rules",
    project: { ...project, sensitivePaths: [".env"] },
    prompt: "edit",
  });
  await new Promise((r) => setTimeout(r, 10));
  await e.followup(j.id, "also test", "rules-follow");
  expect(n.calls.find((a) => a[1] === "task-create")!.join(" ")).toContain(
    "읽기·hash·diff·stage·restore",
  );
  expect(n.calls.find((a) => a[1] === "send")!.join(" ")).toContain(".env");
  await e.close();
});
import { redactRelayText } from "../src/orca-relay.js";
it("redacts authentication URLs while preserving ordinary PR links", () => {
  const text = redactRelayText(
    "https://auth.openai.com/authorize?code=private https://login.tailscale.com/a/secret https://github.com/a/b/pull/1",
  );
  expect(text).not.toContain("auth.openai.com");
  expect(text).not.toContain("tailscale.com");
  expect(text).toContain("https://github.com/a/b/pull/1");
});
it("shows the most recent retry delivery warning alongside unchanged native state", async () => {
  const n = native();
  let launches = 0;
  const run = async (a: readonly string[]) => {
    if (a[1] === "worker-start" && ++launches === 2)
      throw Error("retry transport unavailable");
    return n.run(a);
  };
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run,
  });
  await e.start();
  const j = await e.submit({ requestId: "initial", project, prompt: "edit" });
  await new Promise((r) => setTimeout(r, 10));
  n.setStatus("failed");
  await e.retry(j.id, "retry-lost");
  await new Promise((r) => setTimeout(r, 10));
  const observed = await e.get(j.id);
  expect(observed.state).toBe("failed");
  expect(observed.relayWarning).toContain("retry transport unavailable");
  await e.close();
});

it("checks durable execution ownership immediately before launching a native worker", async () => {
  const n = native();
  let checks = 0;
  const relay = createOrcaRelay({
    databasePath: join(
      mkdtempSync(join(tmpdir(), "relay-fence-")),
      "relay.sqlite",
    ),
    coordinatorHandle: "term-owner",
    run: n.run,
    pollIntervalMs: 100000,
    authorizeExecution: async () => {
      checks++;
      throw new Error("stale_generation");
    },
  });
  try {
    await relay.start();
    await relay.submit({
      requestId: "fenced",
      project,
      prompt: "work",
      execution: { contextId: "c", requestId: "r", generation: 1 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(checks).toBe(1);
    expect(n.calls.some((a) => a[1] === "worker-start")).toBe(false);
  } finally {
    await relay.close();
  }
});
it("keeps a scoped retry pending instead of treating the previous dispatch failure as new completion", async () => {
  const n = native();
  let launches = 0;
  const e = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    authorizeExecution: async () => {},
    run: async (argv) => {
      if (argv[1] === "worker-start" && ++launches === 2)
        throw new Error("retry response lost");
      return n.run(argv);
    },
  });
  try {
    await e.start();
    const job = await e.submit({
      requestId: "initial",
      project,
      prompt: "work",
    });
    await new Promise((r) => setTimeout(r, 10));
    n.setStatus("failed");
    const execution = { contextId: "c", requestId: "retry", generation: 2 };
    expect(await e.retry(job.id, "retry", execution)).toMatchObject({
      state: "queued",
      execution,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(await e.get(job.id)).toMatchObject({
      state: "recovery_required",
      nativeStatus: "retry_outcome_unknown",
      execution,
    });
    expect((await e.get(job.id)).dispatchId).toBeUndefined();
  } finally {
    await e.close();
  }
});
it("clears progress ownership when a legacy retry becomes the current native attempt", async () => {
  const n = native();
  const relay = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    authorizeExecution: async () => {},
    run: n.run,
  });
  try {
    await relay.start();
    const job = await relay.submit({
      requestId: "progress-attempt",
      project,
      prompt: "work",
      execution: { contextId: "c", requestId: "r", generation: 1 },
    });
    await vi.waitFor(() =>
      expect(n.calls.filter((call) => call[1] === "worker-start")).toHaveLength(
        1,
      ),
    );
    n.setStatus("failed");
    expect(await relay.get(job.id)).toMatchObject({
      state: "failed",
      execution: { contextId: "c", requestId: "r", generation: 1 },
    });

    const retry = await relay.retry(job.id, "legacy-retry");
    expect(retry).toMatchObject({ state: "queued", nativeStatus: "retry_pending" });
    expect(retry.execution).toBeUndefined();
    await vi.waitFor(() =>
      expect(n.calls.filter((call) => call[1] === "worker-start")).toHaveLength(
        2,
      ),
    );
    expect((await relay.get(job.id)).execution).toBeUndefined();
  } finally {
    await relay.close();
  }
});
it("waits for the legacy/progress ownership bridge at the actual worker-start boundary", async () => {
  const n = native();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  const relay = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run: n.run,
    authorizeLegacyExecution: async () => wait,
  });
  try {
    await relay.start();
    await relay.submit({
      requestId: "legacy-guarded",
      project,
      prompt: "work",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(n.calls.some((a) => a[1] === "worker-start")).toBe(false);
    expect(relay.listActiveCached()).toHaveLength(1);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(n.calls.filter((a) => a[1] === "worker-start")).toHaveLength(1);
  } finally {
    release();
    await relay.close();
  }
});
it("delivers known-worker guidance while unrelated native creation is stalled", async () => {
  const n = native();
  let creationCount = 0;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const relay = createOrcaRelay({
    databasePath: ":memory:",
    coordinatorHandle: "coordinator",
    run: async (argv) => {
      if (argv[1] === "task-create" && ++creationCount === 2) {
        enter();
        await gate;
      }
      return n.run(argv);
    },
    pollIntervalMs: 100000,
  });
  let blocked: Promise<unknown> | undefined;
  try {
    await relay.start();
    const running = await relay.submit({
      requestId: "running",
      project,
      prompt: "work",
    });
    await vi.waitFor(() =>
      expect(n.calls.filter((call) => call[1] === "worker-start")).toHaveLength(
        1,
      ),
    );
    blocked = relay.submit({
      requestId: "blocked-create",
      project,
      prompt: "other work",
    });
    await entered;

    const guidance = relay.followup(
      running.id,
      "also test",
      "independent-guidance",
    );
    await vi.waitFor(
      () => expect(n.calls.some((call) => call[1] === "send")).toBe(true),
      { timeout: 100 },
    );
    await guidance;
  } finally {
    release();
    await Promise.allSettled(blocked ? [blocked] : []);
    await relay.close();
  }
});
