import { describe, expect, it, vi } from "vitest";

import {
  createStartupReconciler,
  reconcileStartup,
  type ReconcileDispatch,
  type ReconcilePorts
} from "../src/reconcile.js";

const dispatches: readonly ReconcileDispatch[] = [
  { dispatchId: "dispatch-running", receiptId: "receipt-running", receipt: { id: "receipt-running" } },
  { dispatchId: "dispatch-complete", receiptId: "receipt-complete", receipt: { id: "receipt-complete" } },
  { dispatchId: "dispatch-uncertain", receiptId: "receipt-uncertain", receipt: { id: "receipt-uncertain" } }
];

type InspectMany = (receipts: readonly unknown[]) => Promise<readonly import("../src/reconcile.js").OrcaDispatchInspection[]>;
type FakePorts = Omit<ReconcilePorts, "orca"> & {
  orca: {
    inspectMany: InspectMany;
  };
  releaseWorker: ReturnType<typeof vi.fn<(dispatchId: string) => Promise<void>>>;
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
      })
    },
    releaseWorker: vi.fn<(dispatchId: string) => Promise<void>>(),
    locks: { async reviewExpired(report) { events.push(`locks.reviewed:${report.length}`); } },
    outbox: { async drain() { events.push("outbox.drained"); } },
    audit: { async record(event) { events.push(`audit.${event.kind}:${event.dispatchId}`); } }
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
      "audit.classified:dispatch-running",
      "audit.classified:dispatch-complete",
      "audit.classified:dispatch-uncertain",
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
    expect(fake.releaseWorker).not.toHaveBeenCalled();
  });

  it("keeps an exact completion receipt and does not duplicate worker work", async () => {
    // Break caught: restart recovery can relaunch completed work or discard the receipt needed for exact recovery.
    const events: string[] = [];
    const report = await createStartupReconciler(ports(events)).run();

    expect(report).toContainEqual({
      dispatchId: "dispatch-complete",
      state: "completed",
      receiptId: "receipt-complete"
    });
  });

  it("records a redacted durable failure for every dispatch when batch inspection rejects", async () => {
    // Break caught: a rejected batch inspection is swallowed, leaving no durable reason for review.
    const events: string[] = [];
    const report = await reconcileStartup(ports(events, async () => {
      throw new Error("provider-token=must-not-escape");
    }));

    expect(report.every(({ state }) => state === "review_required")).toBe(true);
    expect(events.filter((event) => event.startsWith("audit.inspection_failed:"))).toEqual([
      "audit.inspection_failed:dispatch-running",
      "audit.inspection_failed:dispatch-complete",
      "audit.inspection_failed:dispatch-uncertain"
    ]);
    expect(events.join("\n")).not.toContain("provider-token");
  });

  it("records only the rejected dispatch when per-dispatch inspection partially fails", async () => {
    // Break caught: one rejected exact inspection can either fail the whole startup or disappear without an audit.
    const events: string[] = [];
    const fake: ReconcilePorts = {
      ...ports(events),
      orca: {
        async inspectDispatch(receipt) {
          if ((receipt as { id: string }).id === "receipt-complete") throw new Error("secret");
          return { kind: "running" };
        }
      }
    };

    const report = await reconcileStartup(fake);

    expect(report.map(({ state }) => state)).toEqual(["resumable", "review_required", "resumable"]);
    expect(events).toContain("audit.inspection_failed:dispatch-complete");
    expect(events).not.toContain("audit.inspection_failed:dispatch-running");
  });

  it("records missing batch entries instead of silently treating a short result as an Orca observation", async () => {
    // Break caught: a short batch response creates review state without evidence that inspection data was missing.
    const events: string[] = [];
    const report = await reconcileStartup(ports(events, async () => [{ kind: "running" }]));

    expect(report.map(({ state }) => state)).toEqual(["resumable", "review_required", "review_required"]);
    expect(events.filter((event) => event.startsWith("audit.inspection_missing:"))).toEqual([
      "audit.inspection_missing:dispatch-complete",
      "audit.inspection_missing:dispatch-uncertain"
    ]);
  });
});
