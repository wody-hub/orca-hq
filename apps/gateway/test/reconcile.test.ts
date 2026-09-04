import { describe, expect, it, vi } from "vitest";

import {
  createStartupReconciler,
  reconcileStartup,
  type ReconcileDispatch,
  type ReconcilePorts
} from "../src/reconcile.js";

const dispatches: readonly ReconcileDispatch[] = [
  { dispatchId: "dispatch-running", receipt: { id: "receipt-running" } },
  { dispatchId: "dispatch-complete", receipt: { id: "receipt-complete" } },
  { dispatchId: "dispatch-uncertain", receipt: { id: "receipt-uncertain" } }
];

type InspectMany = NonNullable<ReconcilePorts["orca"]["inspectMany"]>;
type FakePorts = Omit<ReconcilePorts, "orca"> & {
  orca: {
    inspectMany: InspectMany;
    releaseWorker: ReturnType<typeof vi.fn<(dispatchId: string) => Promise<void>>>;
  };
};

function ports(events: string[], inspectMany?: InspectMany): FakePorts {
  return {
    store: {
      async recoverOutboxClaims() { events.push("claims.recovered"); },
      async listNonterminalDispatches() { events.push("dispatches.listed"); return dispatches; }
    },
    channels: { async resumeCursors() { events.push("cursors.resumed"); } },
    orca: {
      inspectMany: inspectMany ?? (async (receipts) => {
        events.push(`orca.inspected:${receipts.length}`);
        return [
          { kind: "running" as const },
          { kind: "completed" as const, receipt: { id: "exact-completion" } },
          { kind: "unknown" as const }
        ];
      }),
      releaseWorker: vi.fn<(dispatchId: string) => Promise<void>>()
    },
    locks: { async reviewExpired(report) { events.push(`locks.reviewed:${report.length}`); } },
    outbox: { async drain() { events.push("outbox.drained"); } }
  };
}

describe("gateway startup reconciliation", () => {
  it("recovers claims, resumes cursors, inspects Orca, reviews locks, and drains Outbox in order", async () => {
    // Break caught: a new command ingress can race stale claims, cursors, locks, or completion delivery after restart.
    const events: string[] = [];

    const report = await reconcileStartup(ports(events));

    expect(events).toEqual([
      "claims.recovered",
      "cursors.resumed",
      "dispatches.listed",
      "orca.inspected:3",
      "locks.reviewed:3",
      "outbox.drained"
    ]);
    expect(report.map(({ state }) => state)).toEqual(["resumable", "completed", "review_required"]);
  });

  it("marks uncertain worker state for review without cleanup", async () => {
    // Break caught: an ambiguous Orca observation must not trigger broad release, terminal close, or artifact deletion.
    const events: string[] = [];
    const fake = ports(events, async () => dispatches.map(() => ({ kind: "unknown" as const })));
    const reconciler = createStartupReconciler(fake);

    expect(await reconciler.run()).toContainEqual(expect.objectContaining({
      dispatchId: "dispatch-uncertain",
      state: "review_required"
    }));
    expect(fake.orca.releaseWorker).not.toHaveBeenCalled();
  });

  it("keeps an exact completion receipt and does not duplicate worker work", async () => {
    // Break caught: restart recovery can relaunch completed work or discard the receipt needed for exact recovery.
    const events: string[] = [];
    const report = await createStartupReconciler(ports(events)).run();

    expect(report).toContainEqual({
      dispatchId: "dispatch-complete",
      state: "completed",
      receipt: { id: "exact-completion" }
    });
  });
});
