import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "@orca-hq/persistence";
import { createFakeOrca, type FakeOrca } from "../../../packages/test-support/src/fake-orca.js";
import { expect, it } from "vitest";

import { orcaResourcesSchema } from "../../web/src/api.js";
import { startManagedService } from "../src/managed-service.js";
import { OperationsOrca } from "../src/operations-orca.js";
import { SqliteProgressStore } from "../src/progress-store.js";

const runtime = {
  id: "receipt",
  ok: true,
  result: {
    runtime: {
      state: "ready",
      reachable: true,
      appVersion: "1.4.203",
      capabilities: [
        "orchestration.contract.v1",
        "orchestration.worker-stop-verdict.v1",
      ],
    },
  },
  _meta: { runtimeId: "runtime" },
};
const ownerRun = {
  id: "receipt",
  ok: true,
  result: {
    run: {
      id: "run",
      objective: "integration",
      coordinator_handle: "owner",
      consumer_generation: 1,
    },
  },
  _meta: { runtimeId: "runtime" },
};
const ownerTerminal = {
  id: "receipt",
  ok: true,
  result: {
    terminal: {
      handle: "owner",
      ptyId: "owner-pty",
      incarnationId: "owner-inc",
      worktreeId: "worktree",
      connected: true,
      writable: true,
      executionHostId: "local",
    },
  },
  _meta: { runtimeId: "runtime" },
};
const targetTerminal = {
  id: "receipt",
  ok: true,
  result: {
    terminal: {
      handle: "target",
      ptyId: "target-pty",
      incarnationId: "target-inc",
      worktreeId: "worktree",
      connected: true,
      writable: true,
      executionHostId: "local",
    },
  },
  _meta: { runtimeId: "runtime" },
};
const taskPage = {
  id: "receipt",
  ok: true,
  result: {
    runId: "run",
    tasks: [{
      id: "task",
      run_id: "run",
      status: "pending",
      created_by_terminal_handle: "owner",
      created_by_process_incarnation: "owner-pty:owner-inc",
      created_by_run_generation: 1,
    }],
  },
  _meta: { runtimeId: "runtime" },
};

async function enqueueDispatchGates(fake: FakeOrca): Promise<void> {
  await fake.enqueueJson(["status", "--json"], runtime);
  for (let pass = 0; pass < 2; pass++) {
    await fake.enqueueJson(["orchestration", "run-show", "--id", "run", "--json"], ownerRun);
    await fake.enqueueJson(["terminal", "show", "--terminal", "owner", "--json"], ownerTerminal);
    await fake.enqueueJson(["orchestration", "task-list", "--run", "run", "--brief", "--json"], taskPage);
    await fake.enqueueJson(["orchestration", "task-list", "--run", "run", "--brief", "--json"], taskPage);
    await fake.enqueueJson(["terminal", "show", "--terminal", "target", "--json"], targetTerminal);
  }
}

async function enqueueRejectedDispatchGates(fake: FakeOrca): Promise<void> {
  await fake.enqueueJson(["status", "--json"], runtime);
  await fake.enqueueJson(["orchestration", "run-show", "--id", "run", "--json"], ownerRun);
  await fake.enqueueJson(["terminal", "show", "--terminal", "owner", "--json"], ownerTerminal);
  await fake.enqueueJson(["orchestration", "task-list", "--run", "run", "--brief", "--json"], taskPage);
  await fake.enqueueJson(["orchestration", "task-list", "--run", "run", "--brief", "--json"], taskPage);
  await fake.enqueueJson(["terminal", "show", "--terminal", "target", "--json"], targetTerminal);
}

function claim(socketPath: string): Promise<{ url: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, path: "/v1/operations/session", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += String(chunk); });
      response.on("end", () => resolve(JSON.parse(text) as { url: string }));
    });
    outgoing.on("error", reject);
    outgoing.end("{}");
  });
}

it("joins owner claim, real HTTP gates, durable journal, browser parsing, and fake Orca argv", async () => {
  // Break caught: unit fakes can hide a cross-layer schema mismatch, missing auth gate, lost inject flag, or repeated unknown effect.
  const directory = await mkdtemp(join(tmpdir(), "hq-operations-integration-"));
  const databasePath = join(directory, "control.sqlite");
  const progressPath = join(directory, "progress.sqlite");
  const assets = join(directory, "web");
  const fake = await createFakeOrca();
  const abort = new AbortController();
  const store = new SqliteProgressStore(openDatabase(progressPath), { databasePath: progressPath, ownerKey: "local" });
  store.createContext({ contextId: "context", originSessionId: "session", objective: "work", title: "work" });
  const lease = store.acquireViewerLease({ contextId: "context", viewerInstanceId: "held-viewer" });
  await mkdir(join(assets, "assets"), { recursive: true });
  await writeFile(join(assets, "index.html"), '<!doctype html><script type="module" src="/assets/index-a1b2c3d4.js"></script>');
  await writeFile(join(assets, "assets/index-a1b2c3d4.js"), "globalThis.__hq=true");
  await fake.enqueueJson(["project", "list", "--json"], { id: "receipt", ok: true, result: { projects: [{ id: "project", displayName: "Project", kind: "repo" }] }, _meta: { runtimeId: "runtime" } });
  await fake.enqueueJson(["project", "setups", "--project", "project", "--json"], { id: "receipt", ok: true, result: { setups: [{ id: "setup", projectId: "project", repoId: "repo", hostId: "local", path: "/workspace" }] }, _meta: { runtimeId: "runtime" } });
  await fake.enqueueJson(["worktree", "list", "--repo", "id:repo", "--limit", "100", "--json"], { id: "receipt", ok: true, result: { worktrees: [{ id: "worktree", repoId: "repo", projectId: "project", hostId: "local", projectHostSetupId: "setup", path: "/workspace" }], hostScope: { hostIds: ["local"], omittedHostIds: [] }, totalCount: 1, truncated: false }, _meta: { runtimeId: "runtime" } });
  await fake.enqueueJson(["terminal", "list", "--worktree", "worktree", "--json"], { id: "receipt", ok: true, result: { terminals: [targetTerminal.result.terminal], hostScope: { hostIds: ["local"], omittedHostIds: [] }, totalCount: 1, truncated: false }, _meta: { runtimeId: "runtime" } });
  await enqueueDispatchGates(fake);
  await fake.enqueueJson(["orchestration", "dispatch", "--task", "task", "--to", "target", "--inject", "--retry-request", "dispatch-request", "--from", "owner", "--run", "run", "--json"], { id: "receipt", ok: true, result: { dispatchId: "dispatch", taskId: "task", runId: "run", mutation: { requestId: "dispatch-request", replayed: false } }, _meta: { runtimeId: "runtime" } });
  await enqueueRejectedDispatchGates(fake);
  await enqueueDispatchGates(fake);
  await fake.enqueue(["orchestration", "dispatch", "--task", "task", "--to", "target", "--inject", "--retry-request", "unknown-request", "--from", "owner", "--run", "run", "--json"], { stderr: "simulated child interruption", exitCode: 75, delayMs: 10 });
  const service = await startManagedService({
    directory,
    databasePath,
    port: 0,
    operationsAssetsRoot: assets,
    owner: { slackUserId: "owner", telegramUserId: "owner" },
    execute: async () => ({ text: "ok" }),
    getJob: () => undefined,
    channelFactory: () => ({ start: async () => {}, stop: async () => {}, send: async () => {}, status: () => ({ slack: true, telegram: true }) }),
    operations: {
      store,
      submit: async () => ({ accepted: true }),
      orca: new OperationsOrca({ executablePath: fake.executablePath, signal: abort.signal }),
      capacity: { limit: 10, source: "default", snapshot: () => ({ active: 0, queued: 0 }), attempts: () => [] },
    },
  });
  try {
    const directoryStat = await lstat(directory);
    const socketPath = join(directory, "control.sock");
    const socketStat = await lstat(socketPath);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(socketStat.isSocket()).toBe(true);
    expect(socketStat.mode & 0o777).toBe(0o600);
    const issued = await claim(socketPath);
    const claimUrl = new URL(issued.url);
    const origin = claimUrl.origin;
    const auth = await fetch(`${origin}/auth/local/claim`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ claim: claimUrl.hash.slice(7) }) });
    expect(auth.status).toBe(200);
    const { csrf } = await auth.json() as { csrf: string };
    const cookie = auth.headers.get("set-cookie")!;
    expect((await fetch(`${origin}/auth/local/claim`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ claim: claimUrl.hash.slice(7) }) })).status).toBe(401);
    const resourcesResponse = await fetch(`${origin}/api/operations/orca/resources`, { headers: { cookie } });
    const resourcesText = await resourcesResponse.text();
    expect(resourcesResponse.status, `${resourcesText} calls=${JSON.stringify(await fake.calls())}`).toBe(200);
    const resources = orcaResourcesSchema.parse(JSON.parse(resourcesText));
    expect(resources.projects[0]?.setups[0]?.worktrees[0]?.terminals[0]?.handle).toBe("target");
    const body = JSON.stringify({ taskId: "task", runId: "run", terminalHandle: "target", expectedIncarnation: "target-inc", inject: true });
    expect((await fetch(`${origin}/api/operations/orca/dispatches`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf, "idempotency-key": "origin-rejected" }, body })).status).toBe(403);
    expect((await fetch(`${origin}/api/operations/orca/dispatches`, { method: "POST", headers: { origin, "content-type": "application/json", cookie, "idempotency-key": "csrf-rejected" }, body })).status).toBe(403);
    const authenticated = (requestId: string, value = body) => ({ method: "POST" as const, headers: { origin, "content-type": "application/json", cookie, "x-csrf-token": csrf, "idempotency-key": requestId }, body: value });
    const accepted = await fetch(`${origin}/api/operations/orca/dispatches`, authenticated("dispatch-request"));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ requestId: "dispatch-request", action: "dispatch", targetId: "task", state: "accepted" });
    expect((await fetch(`${origin}/api/operations/orca/dispatches`, authenticated("dispatch-request"))).status).toBe(202);
    const rejectedBody = JSON.stringify({ taskId: "task", runId: "run", terminalHandle: "target", expectedIncarnation: "wrong-inc", inject: true });
    const rejected = await fetch(`${origin}/api/operations/orca/dispatches`, authenticated("rejected-request", rejectedBody));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ state: "rejected", detail: "terminal_changed" });
    const unknown = await fetch(`${origin}/api/operations/orca/dispatches`, authenticated("unknown-request"));
    expect(unknown.status).toBe(502);
    const unknownReceipt = await unknown.json();
    expect(unknownReceipt).toMatchObject({ requestId: "unknown-request", state: "unknown", detail: "effect_unverifiable" });
    const replay = await fetch(`${origin}/api/operations/orca/dispatches`, authenticated("unknown-request"));
    expect(replay.status).toBe(502);
    expect(await replay.json()).toEqual(unknownReceipt);
    expect(store.heartbeatViewerLease({ contextId: "context", viewerInstanceId: "held-viewer", leaseToken: lease.leaseToken! })).toEqual({ ok: true });
    const calls = await fake.calls();
    expect(calls.filter((argv) => argv.includes("dispatch"))).toEqual([
      ["orchestration", "dispatch", "--task", "task", "--to", "target", "--inject", "--retry-request", "dispatch-request", "--from", "owner", "--run", "run", "--json"],
      ["orchestration", "dispatch", "--task", "task", "--to", "target", "--inject", "--retry-request", "unknown-request", "--from", "owner", "--run", "run", "--json"],
    ]);
  } finally {
    abort.abort();
    await service.stop();
    store.close();
  }
  const reopened = openDatabase(databasePath);
  try {
    expect(reopened.prepare("SELECT request_id,state,detail FROM operations_mutation_receipts ORDER BY request_id").all()).toEqual([
      { request_id: "dispatch-request", state: "accepted", detail: null },
      { request_id: "rejected-request", state: "rejected", detail: "terminal_changed" },
      { request_id: "unknown-request", state: "unknown", detail: "effect_unverifiable" },
    ]);
  } finally {
    reopened.close();
    await fake.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
