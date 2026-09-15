import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "@orca-hq/persistence";
import type { NativeWorkItem, NativeWorkerReceipt } from "@orca-hq/core";
import { afterEach, expect, it, vi } from "vitest";

import { createContextRouter } from "../../apps/gateway/src/context-router.js";
import { startManagedControl } from "../../apps/gateway/src/managed-control.js";
import { createManagedNativeRuntime } from "../../apps/gateway/src/managed-runtime.js";
import type {
  NativeCoordinatorRelay,
  NativeDelivery,
} from "../../apps/gateway/src/native-coordinator.js";
import type {
  NativeLaunchJournalEntry,
  NativeLaunchResult,
  NativeRetentionPolicy,
} from "../../apps/gateway/src/native-launch.js";
import { createProgressControl } from "../../apps/gateway/src/progress-control.js";
import { openProgressStore } from "../../apps/gateway/src/progress-store.js";
import { createWorkerAdmission } from "../../apps/gateway/src/worker-admission.js";
import { createProgressClient } from "../../packages/installer/src/progress-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const profile = {
  agent: "codex" as const,
  model: "gpt-5.6-sol",
  effort: "high",
  reason: "isolated native integration fixture",
};

class FixtureNativeRelay implements NativeCoordinatorRelay {
  readonly launches: NativeWorkItem[] = [];
  readonly receipts = new Map<string, NativeWorkerReceipt>();
  readonly deliveries: NativeDelivery[] = [];
  readonly acknowledgements: string[] = [];
  readonly stopped: string[] = [];
  readonly live = new Set<string>();
  unknownLaunch = (_item: NativeWorkItem) => false;
  cleanupVerdict: "released" | "retained_idle" = "retained_idle";
  #terminal = 0;
  #delivery = 0;

  async startNativeWork(item: NativeWorkItem): Promise<NativeLaunchResult> {
    this.launches.push(item);
    if (this.unknownLaunch(item)) {
      return {
        state: "recovery_required",
        attemptId: item.attemptId,
        runId: `run_${item.attemptId}`,
        reason: "fixture launch observation unavailable",
        residualResources: [],
      };
    }
    const receipt: NativeWorkerReceipt = {
      attemptId: item.attemptId,
      runId: `run_${item.attemptId}`,
      taskId: `task_${item.attemptId}`,
      dispatchId: `dispatch_${item.attemptId}`,
      terminalHandle: item.resumeTerminalHandle ?? `term_fixture_${++this.#terminal}`,
      worktreeId: item.worktreeId,
      requested: item.profile,
      effective: {
        agent: item.profile.agent,
        model: item.profile.model,
        effort: item.profile.effort,
      },
    };
    this.receipts.set(item.attemptId, receipt);
    this.live.add(receipt.dispatchId);
    return { state: "ready", receipt };
  }

  getNativeLaunch(attemptId: string): NativeLaunchJournalEntry {
    const receipt = this.receipts.get(attemptId);
    if (!receipt) throw new Error("native_launch_not_found");
    return {
      attemptId,
      runId: receipt.runId,
      taskId: receipt.taskId,
      dispatchId: receipt.dispatchId,
      receipt,
    } as NativeLaunchJournalEntry;
  }

  async observeNativeWorker(receipt: NativeWorkerReceipt) {
    return { live: this.live.has(receipt.dispatchId) };
  }

  async checkDelivery(): Promise<NativeDelivery | undefined> {
    return this.deliveries.shift();
  }

  async acknowledgeDelivery(delivery: NativeDelivery): Promise<void> {
    this.acknowledgements.push(delivery.deliveryId);
  }

  async cleanupNative(
    receipt: NativeWorkerReceipt,
    policy: NativeRetentionPolicy,
  ) {
    this.live.delete(receipt.dispatchId);
    return {
      verdict: policy === "release" ? ("released" as const) : this.cleanupVerdict,
    };
  }

  async stopNative(receipt: NativeWorkerReceipt): Promise<boolean> {
    this.stopped.push(receipt.taskId);
    return true;
  }

  async sendNativeGuidance() {
    return { messageId: "fixture-guidance" };
  }

  async replyNativeQuestion() {
    return { messageId: "fixture-answer" };
  }

  complete(
    item: NativeWorkItem,
    outcome: "succeeded" | "failed" = "succeeded",
    body = `${item.objective} finished`,
  ): void {
    const receipt = this.receipts.get(item.attemptId);
    if (!receipt) throw new Error("fixture_receipt_missing");
    const id = ++this.#delivery;
    this.deliveries.push({
      runId: receipt.runId,
      deliveryId: `delivery_${id}`,
      messages: [
        {
          id: `message_${id}`,
          type: "worker_done",
          body,
          taskId: receipt.taskId,
          dispatchId: receipt.dispatchId,
          outcome,
        },
      ],
    });
  }
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "hq-native-e2e-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function startFixture(options: {
  directory: string;
  relay: FixtureNativeRelay;
  maxActiveWorkers?: number;
  beforeNativeStart?: (databasePath: string) => void;
}) {
  const databasePath = join(options.directory, "progress.sqlite");
  const store = openProgressStore({ databasePath, ownerKey: "local" });
  const admission = createWorkerAdmission({
    store,
    maxActiveWorkers: options.maxActiveWorkers ?? 10,
  });
  const projects = Array.from({ length: 12 }, (_, index) => ({
    id: `p${index}`,
    name: `Project ${index}`,
    absolutePath: join(options.directory, `project-${index}`),
    aliases: [] as readonly string[],
    enabled: true,
    sensitivePaths: [] as readonly string[],
    setupPolicy: "skip" as const,
  }));
  const catalog = {
    async list() {
      return projects;
    },
    async resolve(selector: string) {
      const project = projects.find(
        (candidate) => candidate.id === selector || candidate.name === selector,
      );
      if (!project) throw new Error("project_not_found");
      return project;
    },
  };
  const router = createContextRouter({
    async propose({ request }) {
      const selected = request.text.match(/\bp(\d+)\b/u)?.[0] ?? "p0";
      return {
        parts: [
          {
            action: "new",
            title: request.text,
            objective: request.text,
            projectIds: [selected],
            text: request.text,
          },
        ],
      };
    },
  });
  const runtime = createManagedNativeRuntime({
    store,
    admission,
    relay: options.relay,
    catalog,
    router,
    retentionPolicy: "retain",
    profiles: { primary: profile },
    pollMs: 5,
  });
  options.beforeNativeStart?.(databasePath);
  await runtime.native.start();
  await runtime.progress.start();
  const socketPath = join(options.directory, "c.sock");
  const control = await startManagedControl({
    socketPath,
    execute: runtime.execute,
    progress: createProgressControl(runtime.progress, {
      pollMs: 5,
      heartbeatMs: 20,
    }),
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await control.stop();
    await runtime.native.close();
    await runtime.progress.close();
    store.close();
  };
  cleanup.push(close);
  return {
    admission,
    close,
    databasePath,
    runtime,
    store,
    client: createProgressClient({ socketPath, idleTimeoutMs: 1000 }),
  };
}

function seedAssignment(
  store: ReturnType<typeof openProgressStore>,
  requestId: string,
  state: "completed" | "executing" | "queued",
) {
  const contextId = `ctx_${requestId}`;
  store.acceptRequest({ requestId, sessionId: "migration", text: requestId });
  store.createContext({
    contextId,
    originSessionId: "migration",
    title: requestId,
    objective: requestId,
    projectIds: ["p0"],
  });
  store.updateContext({ contextId, threadId: "legacy-provider-thread" });
  store.assignRequestContext({
    requestId,
    contextId,
    partId: "0",
    relation: "new",
    instruction: requestId,
  });
  store.setContextAgent({
    contextId,
    agentId: "seed",
    generation: 1,
    currentRequestId: requestId,
    state,
  });
  store.updateRequest({ requestId, state });
  return contextId;
}

it("migrates old assignments and recovers occupied native attempts before admitting new work without replay", async () => {
  // Break caught: a pre-discriminator assignment can be replayed through the native coordinator,
  // replacing an active/uncertain worker and treating its legacy thread as a native session.
  const path = await directory();
  const databasePath = join(path, "progress.sqlite");
  const seeded = openProgressStore({ databasePath, ownerKey: "local" });
  const completedContext = seedAssignment(seeded, "completed_old", "completed");
  seeded.completeAssignment({
    requestId: "completed_old",
    partId: "0",
    eventKey: "completed-old",
    outcome: { state: "completed", text: "already done" },
  });
  seeded.completeRequest({
    requestId: "completed_old",
    eventKey: "completed-old-request",
    state: "completed",
    text: "already done",
  });
  const activeContext = seedAssignment(seeded, "active_old", "executing");
  const unknownContext = seedAssignment(seeded, "unknown_old", "executing");
  seedAssignment(seeded, "assigned_legacy_queued", "queued");
  seeded.acceptRequest({
    requestId: "queued_new",
    sessionId: "migration",
    text: "p2 queued work",
  });

  const seededAdmission = createWorkerAdmission({ store: seeded });
  const item = (attemptId: string, requestId: string, contextId: string): NativeWorkItem => ({
    attemptId,
    requestId,
    contextId,
    generation: 1,
    projectId: requestId === "active_old" ? "p0" : "p1",
    worktreeId: `${requestId}::${join(path, requestId)}`,
    objective: requestId,
    access: "write",
    resources: [
      { resourceKey: `checkout:${join(path, requestId)}`, mode: "write" },
    ],
    dependsOn: [],
    profile,
  });
  const completedItem = item("attempt_completed", "completed_old", completedContext);
  seededAdmission.enqueue(completedItem);
  seededAdmission.claimNext();
  seededAdmission.bindReceipt({
    attemptId: completedItem.attemptId,
    runId: "run_completed",
    taskId: "task_completed",
    dispatchId: "dispatch_completed",
    terminalHandle: "term_completed",
    worktreeId: completedItem.worktreeId,
    requested: profile,
    effective: { agent: "codex", model: profile.model, effort: profile.effort },
  });
  seededAdmission.settle(
    completedItem.attemptId,
    "dispatch_completed",
    "succeeded",
    "retained_idle",
  );
  const activeItem = item("attempt_active", "active_old", activeContext);
  seededAdmission.enqueue(activeItem);
  seededAdmission.claimNext();
  const activeReceipt: NativeWorkerReceipt = {
    attemptId: activeItem.attemptId,
    runId: "run_active",
    taskId: "task_active",
    dispatchId: "dispatch_active",
    terminalHandle: "term_active",
    worktreeId: activeItem.worktreeId,
    requested: profile,
    effective: { agent: "codex", model: profile.model, effort: profile.effort },
  };
  seededAdmission.bindReceipt(activeReceipt);
  const unknownItem = item("attempt_unknown", "unknown_old", unknownContext);
  seededAdmission.enqueue(unknownItem);
  seededAdmission.claimNext();
  seededAdmission.markUnknown(unknownItem.attemptId);
  seededAdmission.close();
  seeded.close();

  const old = openDatabase(databasePath);
  old.exec("ALTER TABLE request_contexts DROP COLUMN execution_backend");
  old.close();

  const relay = new FixtureNativeRelay();
  relay.receipts.set(activeItem.attemptId, activeReceipt);
  relay.live.add(activeReceipt.dispatchId);
  let readyBeforeRecovery = -1;
  const fixture = await startFixture({
    directory: path,
    relay,
    beforeNativeStart(pathname) {
      const database = openDatabase(pathname);
      readyBeforeRecovery = (
        database.prepare("SELECT ready FROM hq_worker_coordinator WHERE singleton=1").get() as {
          ready: number;
        }
      ).ready;
      database.close();
    },
  });

  expect(fixture.store.listRequestAssignments("completed_old")[0]).toMatchObject({
    contextId: completedContext,
    executionBackend: "legacy_conversation",
    outcome: { state: "completed" },
  });
  expect(fixture.store.listRequestAssignments("active_old")[0]?.executionBackend).toBe(
    "legacy_conversation",
  );
  expect(fixture.store.listRequestAssignments("unknown_old")[0]?.executionBackend).toBe(
    "legacy_conversation",
  );
  expect(
    fixture.store.listRequestAssignments("assigned_legacy_queued")[0]
      ?.executionBackend,
  ).toBe("legacy_conversation");
  await vi.waitFor(() => {
    expect(fixture.store.getRequest("active_old")?.state).toBe("recovery_required");
    expect(fixture.store.getRequest("unknown_old")?.state).toBe("recovery_required");
    expect(fixture.store.getRequest("assigned_legacy_queued")?.state).toBe(
      "recovery_required",
    );
  });
  await vi.waitFor(() =>
    expect(relay.launches.map((launch) => launch.requestId)).toEqual(["queued_new"]),
  );
  expect(fixture.admission.listAttempts()).toMatchObject([
    { item: { attemptId: "attempt_completed" }, state: "settled" },
    { item: { attemptId: "attempt_active" }, state: "active" },
    { item: { attemptId: "attempt_unknown" }, state: "unknown" },
    { item: { requestId: "queued_new" }, state: "active" },
  ]);
  expect(fixture.admission.listAttempts()).toHaveLength(4);
  expect(
    fixture.admission
      .listAttempts()
      .some((attempt) => attempt.item.requestId === "assigned_legacy_queued"),
  ).toBe(false);
  expect(fixture.admission.snapshot()).toEqual({ active: 3, queued: 0 });
  expect(readyBeforeRecovery).toBe(0);
  const recoveredDatabase = openDatabase(databasePath);
  expect(
    (
      recoveredDatabase.prepare("SELECT ready FROM hq_worker_coordinator WHERE singleton=1").get() as {
        ready: number;
      }
    ).ready,
  ).toBe(1);
  expect(
    (
      recoveredDatabase.prepare("PRAGMA table_info(request_contexts)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  ).toContain("execution_backend");
  recoveredDatabase.close();

  await fixture.client.submitRequest({
    requestId: "queued_new",
    sessionId: "migration",
    text: "p2 queued work",
  });
  expect(relay.launches).toHaveLength(1);
  const launched = relay.launches[0]!;
  expect(launched.requestId).toBe("queued_new");
  expect(launched.resumeTerminalHandle).toBeUndefined();
  expect(fixture.store.listRequestAssignments("queued_new")).toMatchObject([
    { executionBackend: "native_orca" },
  ]);
  relay.complete(launched);
  await vi.waitFor(async () =>
    expect((await fixture.client.getRequest("queued_new")).state).toBe("completed"),
  );
  expect(relay.launches).toHaveLength(1);
});

it("routes two independent socket contexts through native workers and preserves their separate results", async () => {
  // Break caught: native composition can collapse distinct contexts or complete one request with
  // another worker's result.
  const relay = new FixtureNativeRelay();
  const fixture = await startFixture({ directory: await directory(), relay });
  await fixture.client.submitRequest({ requestId: "two_a", sessionId: "s", text: "p0 alpha" });
  await fixture.client.submitRequest({ requestId: "two_b", sessionId: "s", text: "p1 beta" });
  await vi.waitFor(() => expect(relay.launches).toHaveLength(2));
  expect(new Set(relay.launches.map((item) => item.contextId)).size).toBe(2);
  expect(fixture.store.listRequestAssignments("two_a")[0]?.executionBackend).toBe(
    "native_orca",
  );
  expect(fixture.store.listRequestAssignments("two_b")[0]?.executionBackend).toBe(
    "native_orca",
  );
  relay.complete(relay.launches[0]!, "succeeded", "alpha result");
  relay.complete(relay.launches[1]!, "succeeded", "beta result");
  await vi.waitFor(async () => {
    expect((await fixture.client.getRequest("two_a")).result?.text).toBe("alpha result");
    expect((await fixture.client.getRequest("two_b")).result?.text).toBe("beta result");
  });
});

it("serializes a same-context socket followup and reacquires its retained native terminal", async () => {
  // Break caught: a followup can fork a new context, overlap its predecessor, or ignore a retained
  // terminal that is proven idle and owned by the same context/project/profile.
  const relay = new FixtureNativeRelay();
  const fixture = await startFixture({ directory: await directory(), relay });
  await fixture.client.submitRequest({ requestId: "first", sessionId: "s", text: "p0 first" });
  await vi.waitFor(() => expect(relay.launches).toHaveLength(1));
  const first = relay.launches[0]!;
  const terminal = relay.receipts.get(first.attemptId)!.terminalHandle;
  relay.complete(first, "succeeded", "first result");
  await vi.waitFor(async () =>
    expect((await fixture.client.getRequest("first")).state).toBe("completed"),
  );

  await fixture.client.submitRequest({
    requestId: "followup",
    sessionId: "s",
    text: "continue the same work",
    contextHint: { mode: "continue", contextId: first.contextId },
  });
  await vi.waitFor(() => expect(relay.launches).toHaveLength(2));
  const followup = relay.launches[1]!;
  expect(followup.contextId).toBe(first.contextId);
  expect(followup.resumeTerminalHandle).toBe(terminal);
  expect(relay.receipts.get(followup.attemptId)?.terminalHandle).toBe(terminal);
  expect(fixture.store.listContexts("s")).toHaveLength(1);
  relay.complete(followup, "succeeded", "followup result");
  await vi.waitFor(async () =>
    expect((await fixture.client.getRequest("followup")).result?.text).toBe(
      "followup result",
    ),
  );
});

it("shares the durable ten-worker admission limit across socket and channel requests", async () => {
  // Break caught: channel composition can bypass the native admission journal or launch the
  // eleventh worker before one of ten occupied attempts settles.
  const relay = new FixtureNativeRelay();
  const fixture = await startFixture({ directory: await directory(), relay });
  const socketIds = Array.from({ length: 5 }, (_, index) => `socket_${index}`);
  for (const [index, requestId] of socketIds.entries()) {
    await fixture.client.submitRequest({
      requestId,
      sessionId: "terminal-session",
      text: `p${index} socket work`,
    });
  }
  const channelResults = Array.from({ length: 6 }, (_, offset) => {
    const index = offset + 5;
    return fixture.runtime.execute({
      id: `channel_${index}`,
      text: `p${index} channel work`,
      source: index % 2 ? "slack" : "telegram",
      userId: index % 2 ? "U_OWNER" : "42",
      conversationId: `conversation_${index}`,
    });
  });

  await vi.waitFor(() => expect(relay.launches).toHaveLength(10));
  await vi.waitFor(() => expect(fixture.admission.snapshot()).toEqual({ active: 10, queued: 1 }));
  expect(new Set(relay.launches.map((item) => item.requestId)).size).toBe(10);

  const first = relay.launches[0]!;
  relay.complete(first);
  await vi.waitFor(() => expect(relay.launches).toHaveLength(11));
  expect(fixture.admission.snapshot().active).toBe(10);
  for (const item of relay.launches.slice(1)) relay.complete(item);
  await expect(Promise.all(channelResults)).resolves.toHaveLength(6);
  await vi.waitFor(async () => {
    for (const requestId of socketIds) {
      expect((await fixture.client.getRequest(requestId)).state).toBe("completed");
    }
  });
  expect(fixture.admission.snapshot()).toEqual({ active: 0, queued: 0 });
});

it("returns a failed native result through the socket without disturbing another context", async () => {
  // Break caught: a failed worker can be reported as completed or poison an independent context.
  const relay = new FixtureNativeRelay();
  const fixture = await startFixture({ directory: await directory(), relay });
  await fixture.client.submitRequest({ requestId: "good", sessionId: "s", text: "p0 good" });
  await fixture.client.submitRequest({ requestId: "bad", sessionId: "s", text: "p1 bad" });
  await vi.waitFor(() => expect(relay.launches).toHaveLength(2));
  const good = relay.launches.find((item) => item.requestId === "good")!;
  const bad = relay.launches.find((item) => item.requestId === "bad")!;
  relay.complete(bad, "failed", "native failure");
  await vi.waitFor(async () =>
    expect((await fixture.client.getRequest("bad")).state).toBe("failed"),
  );
  expect((await fixture.client.getRequest("good")).state).toBe("executing");
  relay.complete(good, "succeeded", "independent success");
  await vi.waitFor(async () =>
    expect((await fixture.client.getRequest("good")).result?.text).toBe(
      "independent success",
    ),
  );
});

it("stops an active native worker through the socket and returns its occupied capacity", async () => {
  // Break caught: stop can release admission before exact worker stop/cleanup proof or leave the
  // occupied slot stranded after both proofs succeed.
  const relay = new FixtureNativeRelay();
  const fixture = await startFixture({ directory: await directory(), relay });
  await fixture.client.submitRequest({ requestId: "running", sessionId: "s", text: "p0 run" });
  await vi.waitFor(() => expect(relay.launches).toHaveLength(1));
  const launched = relay.launches[0]!;
  await fixture.client.submitRequest({
    requestId: "stop",
    sessionId: "s",
    text: "stop",
    contextHint: { mode: "continue", contextId: launched.contextId },
  });
  await vi.waitFor(async () =>
    expect((await fixture.client.getRequest("stop")).state).toBe("completed"),
  );
  expect(relay.stopped).toEqual([relay.receipts.get(launched.attemptId)!.taskId]);
  expect(fixture.admission.listAttempts()[0]).toMatchObject({
    state: "settled",
    outcome: "stopped",
    resourceVerdict: "released",
  });
  expect(fixture.admission.snapshot()).toEqual({ active: 0, queued: 0 });
});

it("keeps an unknown launch occupied and launches no queued replacement", async () => {
  // Break caught: losing the worker-start observation can incorrectly free capacity and dispatch a
  // replacement while the first worker may still exist.
  const relay = new FixtureNativeRelay();
  relay.unknownLaunch = (item) => item.requestId === "unknown";
  const fixture = await startFixture({
    directory: await directory(),
    relay,
    maxActiveWorkers: 1,
  });
  await fixture.client.submitRequest({ requestId: "unknown", sessionId: "s", text: "p0 unknown" });
  await fixture.client.submitRequest({ requestId: "next", sessionId: "s", text: "p1 next" });
  await vi.waitFor(async () =>
    expect((await fixture.client.getRequest("unknown")).state).toBe(
      "recovery_required",
    ),
  );
  await vi.waitFor(() => expect(fixture.admission.snapshot()).toEqual({ active: 1, queued: 1 }));
  expect(relay.launches.map((item) => item.requestId)).toEqual(["unknown"]);
  expect(fixture.admission.listAttempts()).toMatchObject([
    { item: { requestId: "unknown" }, state: "unknown" },
    { item: { requestId: "next" }, state: "queued" },
  ]);
});

it("reconciles an active native worker across gateway restart without replacement", async () => {
  // Break caught: restart can treat a persisted receipt as permission to relaunch instead of
  // observing its exact Dispatch and consuming its eventual result.
  const path = await directory();
  const relay = new FixtureNativeRelay();
  const first = await startFixture({ directory: path, relay });
  await first.client.submitRequest({ requestId: "restart", sessionId: "s", text: "p0 restart" });
  await vi.waitFor(() => expect(relay.launches).toHaveLength(1));
  const launched = relay.launches[0]!;
  await first.close();

  let readyBeforeRecovery = -1;
  const restarted = await startFixture({
    directory: path,
    relay,
    beforeNativeStart(databasePath) {
      const database = openDatabase(databasePath);
      readyBeforeRecovery = (
        database.prepare("SELECT ready FROM hq_worker_coordinator WHERE singleton=1").get() as {
          ready: number;
        }
      ).ready;
      database.close();
    },
  });
  expect(readyBeforeRecovery).toBe(0);
  expect(restarted.admission.listAttempts()[0]).toMatchObject({ state: "active" });
  expect(relay.launches).toHaveLength(1);
  relay.complete(launched, "succeeded", "survived restart");
  await vi.waitFor(async () =>
    expect((await restarted.client.getRequest("restart")).result?.text).toBe(
      "survived restart",
    ),
  );
  expect(relay.launches).toHaveLength(1);
});
