import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExecutionGenerationConflictError,
  ExecutionOwnershipConflictError,
  ExecutionReservationReleasedError,
  NativeReservationEvidenceError,
  openProgressStore,
  type SqliteProgressStore
} from "../src/progress-store.js";
import {
  createExecutionReservations,
  normalizeResourceAccesses
} from "../src/execution-reservations.js";

const stores: SqliteProgressStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "hq-reservations-"));
  directories.push(directory);
  const databasePath = join(directory, "progress.sqlite");
  const store = openProgressStore({
    databasePath,
    ownerKey: "owner",
    now: () => new Date("2026-09-08T00:00:00.000Z")
  });
  stores.push(store);
  return { store, reservations: createExecutionReservations(store), databasePath };
}

function seedExecution(store: SqliteProgressStore, suffix: string, generation = 1) {
  const requestId = `req_${suffix}`;
  const contextId = `ctx_${suffix}`;
  store.acceptRequest({ requestId, sessionId: "session_1", text: `Work ${suffix}` });
  store.createContext({ contextId, originSessionId: "session_1", title: suffix, objective: suffix });
  store.assignRequestContext({ requestId, partId: "part", contextId, relation: "new", instruction: suffix });
  store.setContextAgent({ contextId, agentId: `agent_${suffix}`, state: "executing", generation, currentRequestId: requestId });
  return { requestId, contextId, agentId: `agent_${suffix}`, generation };
}

describe("execution reservations", () => {
  it("normalizes checkout paths, collapses duplicates, and promotes write access", () => {
    expect(normalizeResourceAccesses([
      { resourceKey: "checkout:/tmp/project/../project", mode: "read" },
      { resourceKey: "/tmp/project", mode: "write" },
      { resourceKey: "external:shared-db", mode: "read" }
    ])).toEqual([
      { resourceKey: `checkout:${join(realpathSync.native("/tmp"), "project")}`, mode: "write" },
      { resourceKey: "external:shared-db", mode: "read" }
    ]);
  });

  it("canonicalizes a symlinked existing ancestor even when the leaf does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hq-reservation-realpath-"));
    directories.push(directory);
    const real = join(directory, "real");
    const alias = join(directory, "alias");
    await mkdir(real);
    await symlink(real, alias);
    expect(normalizeResourceAccesses([
      { resourceKey: join(alias, "future", "checkout"), mode: "write" }
    ])).toEqual([
      { resourceKey: `checkout:${join(realpathSync.native(real), "future", "checkout")}`, mode: "write" }
    ]);
  });

  it("allows read/read but blocks nested checkout writes until every holder releases", async () => {
    const { store, reservations } = await setup();
    const a = seedExecution(store, "a");
    const b = seedExecution(store, "b");
    const c = seedExecution(store, "c");
    expect(reservations.claim({ reservationId: "res_a", ...a, resources: [{ resourceKey: "/tmp/project", mode: "read" }] }).acquired).toBe(true);
    expect(reservations.claim({ reservationId: "res_b", ...b, resources: [{ resourceKey: "/tmp/project/pkg", mode: "read" }] }).acquired).toBe(true);

    const blocked = reservations.claim({
      reservationId: "res_c",
      ...c,
      resources: [{ resourceKey: "checkout:/tmp/project/pkg/src", mode: "write" }]
    });
    expect(blocked.acquired).toBe(false);
    if (blocked.acquired) throw new Error("expected conflict");
    expect(blocked.conflicts.map(({ heldBy }) => heldBy.reservationId).sort()).toEqual(["res_a", "res_b"]);

    reservations.release({ reservationId: "res_a", ...a });
    reservations.release({ reservationId: "res_b", ...b });
    expect(reservations.claim({
      reservationId: "res_c",
      ...c,
      resources: [{ resourceKey: "/tmp/project/pkg/src", mode: "write" }]
    }).acquired).toBe(true);
  });

  it("acquires multiple resources all-or-none and makes a claim idempotent", async () => {
    const { store, reservations, databasePath } = await setup();
    const holder = seedExecution(store, "holder");
    const blocked = seedExecution(store, "blocked");
    const probe = seedExecution(store, "probe");
    reservations.claim({ reservationId: "res_holder", ...holder, resources: [{ resourceKey: "external:prod-db", mode: "write" }] });
    const secondStore = openProgressStore({ databasePath, ownerKey: "owner" });
    stores.push(secondStore);
    const secondReservations = createExecutionReservations(secondStore);

    const result = secondReservations.claim({
      reservationId: "res_blocked",
      ...blocked,
      resources: [
        { resourceKey: "/tmp/free-checkout", mode: "write" },
        { resourceKey: "external:prod-db", mode: "read" }
      ]
    });
    expect(result.acquired).toBe(false);
    const probeResult = secondReservations.claim({
      reservationId: "res_probe",
      ...probe,
      resources: [{ resourceKey: "/tmp/free-checkout/child", mode: "write" }]
    });
    expect(probeResult.acquired).toBe(true);
    expect(secondReservations.claim({
      reservationId: "res_probe",
      ...probe,
      resources: [{ resourceKey: "checkout:/tmp/free-checkout/child", mode: "write" }]
    })).toEqual(probeResult);
  });

  it("fences stale generations and retains uncertain native ownership", async () => {
    const { store, reservations } = await setup();
    const execution = seedExecution(store, "recovery", 3);
    store.acceptRequest({ requestId: "req_rogue", sessionId: "session_1", text: "Rogue" });
    expect(() => reservations.claim({
      reservationId: "res_rogue",
      ...execution,
      requestId: "req_rogue",
      resources: [{ resourceKey: "external:rogue", mode: "write" }]
    })).toThrow(ExecutionOwnershipConflictError);
    expect(() => reservations.claim({
      reservationId: "res_stale",
      ...execution,
      generation: 2,
      resources: [{ resourceKey: "external:deploy", mode: "write" }]
    })).toThrow(ExecutionGenerationConflictError);
    reservations.claim({
      reservationId: "res_recovery",
      ...execution,
      resources: [{ resourceKey: "external:deploy", mode: "write" }]
    });
    expect(reservations.linkNativeDispatch({
      reservationId: "res_recovery",
      ...execution,
      nativeDispatchId: "dispatch_1"
    }).nativeDispatchId).toBe("dispatch_1");
    expect(reservations.retainForRecovery({ reservationId: "res_recovery", ...execution }))
      .toEqual([expect.objectContaining({ state: "recovery_required" })]);
    expect(reservations.claim({
      reservationId: "res_recovery",
      ...execution,
      resources: [{ resourceKey: "external:deploy", mode: "write" }]
    }).acquired).toBe(false);

    const retry = seedExecution(store, "retry");
    const blocked = reservations.claim({
      reservationId: "res_retry",
      ...retry,
      resources: [{ resourceKey: "external:deploy", mode: "write" }]
    });
    expect(blocked.acquired).toBe(false);
    expect(() => reservations.release({ reservationId: "res_recovery", ...execution }))
      .toThrow(NativeReservationEvidenceError);
    expect(() => reservations.release({
      reservationId: "res_recovery",
      ...execution,
      nativeCompletion: { dispatchId: "dispatch_other", state: "succeeded" }
    })).toThrow(NativeReservationEvidenceError);
    reservations.release({
      reservationId: "res_recovery",
      ...execution,
      nativeCompletion: { dispatchId: "dispatch_1", state: "succeeded" }
    });
    expect(() => reservations.claim({
      reservationId: "res_recovery",
      ...execution,
      resources: [{ resourceKey: "external:deploy", mode: "write" }]
    })).toThrow(ExecutionReservationReleasedError);
    expect(reservations.claim({
      reservationId: "res_retry",
      ...retry,
      resources: [{ resourceKey: "external:deploy", mode: "write" }]
    }).acquired).toBe(true);
  });
});

it("shares legacy/native resource exclusion in both directions and legacy release cannot free native claims", async () => {
  const { store, reservations } = await setup();
  const native = seedExecution(store, "native");
  const legacy = seedExecution(store, "legacy");
  const admission = store.createWorkerAdmission({});
  admission.enqueue({
    attemptId: "native_attempt", ...{ requestId: native.requestId, contextId: native.contextId, generation: 1 },
    projectId: "p", worktreeId: "p::/tmp/shared", objective: "Inspect", access: "write",
    resources: [{ resourceKey: "/tmp/shared", mode: "write" }], dependsOn: [],
    profile: { agent: "codex", model: "gpt-5.6-sol", reason: "test" }
  });
  reservations.claim({ ...legacy, reservationId: "legacy_res", resources: [{ resourceKey: "/tmp/shared/child", mode: "read" }] });
  expect(admission.claimNext()).toBeUndefined();
  reservations.release({ ...legacy, reservationId: "legacy_res" });
  expect(admission.claimNext()?.attemptId).toBe("native_attempt");
  const blocked = reservations.claim({ ...legacy, reservationId: "legacy_next", resources: [{ resourceKey: "/tmp/shared", mode: "read" }] });
  expect(blocked.acquired).toBe(false);
  if (!blocked.acquired) expect(blocked.conflicts[0]?.heldBy.reservationId).toBe("native_attempt");
  expect(() => reservations.release({ ...native, reservationId: "native_attempt" })).toThrow();
  expect(admission.snapshot().active).toBe(1);
});
