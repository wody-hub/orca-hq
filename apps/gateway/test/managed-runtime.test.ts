import { describe, expect, it } from "vitest";
import { createObservedJobListReader } from "../src/managed-runtime.js";
import type { CommandJob } from "../src/managed-commands.js";

const job = (
  input: Partial<CommandJob> & Pick<CommandJob, "id" | "state">,
): CommandJob => ({
  projectId: "gh",
  projectName: "GH",
  prompt: "work",
  createdAt: "2026-09-08T03:00:00.000Z",
  updatedAt: "2026-09-08T04:00:00.000Z",
  ...input,
});

describe("managed runtime global job observation", () => {
  it("lists every cached active job separately from recent terminal jobs and labels snapshot freshness", async () => {
    const readJobs = createObservedJobListReader({
      listActiveCached: () => [
        job({ id: "task_old_active", state: "running", prompt: "older" }),
        job({ id: "task_recovery", state: "recovery_required" }),
      ],
      listCached: () => [
        job({ id: "task_recent_done", state: "succeeded" }),
        job({ id: "task_old_active", state: "running", prompt: "duplicate" }),
      ],
    });

    const result = await readJobs("request-global-list");

    expect(result.text).toContain("현재 활성 작업 2개");
    expect(result.text).toContain("작업 task_old_active · GH · 실행 중");
    expect(result.text).toContain("작업 task_recovery · GH · 복구 확인 필요");
    expect(result.text.match(/작업 task_old_active/g)).toHaveLength(1);
    expect(result.text).toContain("최근 종료 작업 1개");
    expect(result.text).toContain("작업 task_recent_done · GH · 완료");
    expect(result.text).toContain(
      "최근 기록된 작업 업데이트: 2026-09-08T04:00:00.000Z",
    );
    expect(result.text).toContain("그 이후 상태가 변경되었을 수 있습니다");
    expect(result.text.indexOf("그 이후 상태가 변경되었을 수 있습니다")).toBeLessThan(
      result.text.indexOf("작업 task_old_active"),
    );
  });

  it("does not claim a live empty result when no cached jobs have been observed", async () => {
    const readJobs = createObservedJobListReader({
      listActiveCached: () => [],
      listCached: () => [],
    });

    const result = await readJobs("request-global-empty");

    expect(result.text).toContain("현재 활성 작업 0개 (마지막 관찰 스냅샷 기준)");
    expect(result.text).toContain("저장된 관찰 기록이 없습니다");
    expect(result.text).not.toContain("현재 실행 중인 작업이 없습니다");
  });
});

it("routes every composed channel execute path through native admission with no conversational fallback", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { vi } = await import("vitest");
  const { openProgressStore } = await import("../src/progress-store.js");
  const { createWorkerAdmission } = await import("../src/worker-admission.js");
  const { createContextRouter } = await import("../src/context-router.js");
  const { createManagedNativeRuntime } = await import("../src/managed-runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "managed-native-"));
  const store = openProgressStore({ databasePath: join(dir, "db"), ownerKey: "local" });
  const admission = createWorkerAdmission({ store });
  // The real composition's only non-native surface. Ordinary channel text must never reach it, and
  // there is no third option to reach at all — a conversational fallback would have to be added here.
  const commands = { execute: vi.fn(async () => ({ text: "command surface" })) };
  const project = { id: "p", name: "Project", absolutePath: "/tmp/project", aliases: [], enabled: true, sensitivePaths: [], setupPolicy: "inherit" as const };
  let launchNumber = 0;
  const relay = {
    startNativeWork: vi.fn(async (item: import("@orca-hq/core").NativeWorkItem) => ({ state: "ready" as const, receipt: { attemptId: item.attemptId, runId: "run", taskId: ++launchNumber === 1 ? "task" : `task${launchNumber}`, dispatchId: launchNumber === 1 ? "dispatch" : `dispatch${launchNumber}`, terminalHandle: "term_worker", worktreeId: item.worktreeId, requested: item.profile, effective: { agent: "codex", model: item.profile.model } } })),
    getNativeLaunch() { throw Error("missing"); }, async checkDelivery() { return undefined; }, async acknowledgeDelivery() {},
    async cleanupNative() { return { verdict: "retained_idle" as const }; },
    async sendNativeGuidance() { return { messageId: "m" }; }, async replyNativeQuestion() { return { messageId: "m" }; }
  };
  const runtime = createManagedNativeRuntime({ store, admission, relay, catalog: { list: async () => [project], resolve: async () => project },
    router: createContextRouter({ propose: async () => ({ parts: [{ action: "new", title: "Analysis", objective: "Analyze code", text: "Analyze code", projectIds: ["p"] }] }) }),
    commands, retentionPolicy: "retain", pollMs: 10 });
  try {
    await runtime.native.start(); await runtime.progress.start();
    const result = runtime.execute({ id: "message", text: "Analyze project code", source: "telegram", userId: "123" });
    await vi.waitFor(() => expect(relay.startNativeWork).toHaveBeenCalledOnce());
    expect(commands.execute).not.toHaveBeenCalled();
    expect(Object.keys(runtime).sort()).toEqual(["execute", "native", "progress"]);
    const attempt = admission.listAttempts()[0]!;
    expect(store.getRequest(attempt.item.requestId)?.state).toBe("executing");
    expect(store.nativeJournal().list("plan")).toMatchObject([{ source: "telegram", userId: "123" }]);
    const contextId = attempt.item.contextId;
    const followup = runtime.progress.executeLegacy({ id: "followup", text: `/context ${contextId} Review the next module`, source: "telegram", userId: "123" });
    await vi.waitFor(() => expect(runtime.progress.executor.queued).toBe(1));
    expect(relay.startNativeWork).toHaveBeenCalledOnce();
    await runtime.native.processDelivery({ runId: "run", deliveryId: "delivery", messages: [{ id: "done", type: "worker_done", body: "Analysis result", taskId: "task", dispatchId: "dispatch", outcome: "succeeded" }] });
    expect((await result).text).toContain("Analysis result");
    expect(store.getRequest(attempt.item.requestId)?.state).toBe("completed");
    await vi.waitFor(() => expect(relay.startNativeWork).toHaveBeenCalledTimes(2));
    expect(relay.startNativeWork.mock.calls[1]?.[0]).toMatchObject({ contextId, resumeTerminalHandle: "term_worker" });
    expect(relay.startNativeWork.mock.calls[1]?.[0].attemptId).not.toBe(attempt.item.attemptId);
    await runtime.native.processDelivery({ runId: "run", deliveryId: "delivery2", messages: [{ id: "done2", type: "worker_done", body: "Followup result", taskId: "task2", dispatchId: "dispatch2", outcome: "succeeded" }] });
    expect((await followup).text).toContain("Followup result");
    expect(await runtime.execute({ id: "hq", text: '/hq {"action":"jobs.list"}', source: "telegram", userId: "123" })).toMatchObject({ text: "command surface" });
    expect(commands.execute).toHaveBeenCalledOnce();
  } finally { await runtime.native.close(); await runtime.progress.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("names HQ_MAX_ACTIVE_WORKERS and its accepted values when the env var is unusable", async () => {
  const { parseMaxActiveWorkers } = await import("../src/managed-runtime.js");
  expect(parseMaxActiveWorkers(undefined)).toBe(10);
  expect(parseMaxActiveWorkers("")).toBe(10);
  expect(parseMaxActiveWorkers("unlimited")).toBe("unlimited");
  expect(parseMaxActiveWorkers(" 12 ")).toBe(12);
  for (const bad of ["ten", "0", "-1", "2.5", "1e3", "NaN"])
    expect(() => parseMaxActiveWorkers(bad)).toThrow(/HQ_MAX_ACTIVE_WORKERS=".*" is not usable: set a positive whole number \(for example 10\) or "unlimited"\./);
});

it("resolves a declared scope through project aliases and fails closed instead of widening it to write", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { vi } = await import("vitest");
  const { openProgressStore } = await import("../src/progress-store.js");
  const { createWorkerAdmission } = await import("../src/worker-admission.js");
  const { createContextRouter } = await import("../src/context-router.js");
  const { createManagedNativeRuntime } = await import("../src/managed-runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "managed-scope-"));
  const store = openProgressStore({ databasePath: join(dir, "db"), ownerKey: "local" });
  const admission = createWorkerAdmission({ store });
  const project = { id: "p", name: "Project", absolutePath: "/tmp/project", aliases: ["alias"], enabled: true, sensitivePaths: [], setupPolicy: "inherit" as const };
  const relay = {
    startNativeWork: vi.fn(async (item: import("@orca-hq/core").NativeWorkItem) => ({ state: "ready" as const, receipt: { attemptId: item.attemptId, runId: "run", taskId: "task", dispatchId: "dispatch", terminalHandle: "term_worker", worktreeId: item.worktreeId, requested: item.profile, effective: { agent: "codex", model: item.profile.model } } })),
    getNativeLaunch() { throw Error("missing"); }, async checkDelivery() { return undefined; }, async acknowledgeDelivery() {},
    async cleanupNative() { return { verdict: "retained_idle" as const }; },
    async sendNativeGuidance() { return { messageId: "m" }; }, async replyNativeQuestion() { return { messageId: "m" }; }
  };
  const runtime = createManagedNativeRuntime({ store, admission, relay,
    catalog: { list: async () => [project], resolve: async (id: string) => { if (id === "p" || project.aliases.includes(id)) return project; throw Error("unknown_project"); } },
    router: createContextRouter({ propose: async () => ({ parts: [{ action: "new", title: "Review", objective: "Review code", text: "Review code", projectIds: ["p"] }] }) }),
    retentionPolicy: "retain", pollMs: 10 });
  const scope = { worktreeId: "p::/tmp/project", access: "read" as const, resources: [{ resourceKey: "checkout:/tmp/project", mode: "read" as const }] };
  try {
    await runtime.native.start(); await runtime.progress.start();
    void runtime.execute({ id: "aliased", text: "Review this", source: "telegram", userId: "1", nativeScope: { projectId: "alias", ...scope } });
    // An alias selector resolves to the catalog id, so the declared read-only claim survives intact.
    await vi.waitFor(() => expect(relay.startNativeWork).toHaveBeenCalledOnce());
    expect(relay.startNativeWork.mock.calls[0]?.[0]).toMatchObject({ projectId: "p", access: "read", resources: [{ resourceKey: expect.stringMatching(/^checkout:.*\/tmp\/project$/), mode: "read" }] });
    // An unmatched scope is rejected rather than defaulting to a write claim on the whole checkout.
    expect(await runtime.execute({ id: "foreign", text: "Review that", source: "telegram", userId: "1", nativeScope: { projectId: "elsewhere", ...scope } })).toMatchObject({ state: "failed" });
    expect(relay.startNativeWork).toHaveBeenCalledOnce();
    expect(admission.listAttempts().every(a => a.item.access === "read")).toBe(true);
  } finally { await runtime.native.close(); await runtime.progress.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
