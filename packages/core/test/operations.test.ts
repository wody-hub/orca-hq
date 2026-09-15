import { describe, expect, it } from "vitest";

import {
  HqEventPageSchema,
  OrcaOutputPageSchema,
  OperationsStatusSchema,
  SupportSchema
} from "../src/operations.js";

describe("operations contract", () => {
  it("keeps unavailable metrics unavailable and validates capacity provenance", () => {
    // Break caught: a UI could show made-up zero cost or lose the capacity source.
    expect(OperationsStatusSchema.parse({
      collectedAt: "2026-09-15T00:00:00.000Z",
      hq: { state: "ready", capacity: { limit: 10, source: "default", active: 1, queued: 0, byState: {}, updateSupported: false, reason: "restart_safe_mutation_contract_unavailable" } },
      orca: { state: "ready", reachable: true, version: "1.4.203", features: {} },
      metrics: { tokens: { available: false, reason: "not_collected" }, cost: { available: false, reason: "not_collected" } }
    })).toMatchObject({ metrics: { tokens: { available: false }, cost: { available: false } } });
    expect(() => OperationsStatusSchema.parse({
      collectedAt: "2026-09-15T00:00:00.000Z", hq: { state: "ready", capacity: { limit: 0, source: "default", active: 0, queued: 0, byState: {}, updateSupported: false, reason: "x" } }, orca: { state: "ready", reachable: true, version: "1", features: {} }, metrics: { tokens: { available: true }, cost: { available: false, reason: "not_collected" } }
    })).toThrow();
  });

  it("rejects Orca identity fields on HQ events except receipt links", () => {
    // Break caught: merging separate HQ and Orca identities leaks inferred links into the console.
    const base = { source: "hq", eventSource: "hq", seq: 1, eventKey: "event", requestId: "request", contextId: "context", kind: "hq.progress", occurredAt: "2026-09-15T00:00:00.000Z", payload: {} };
    expect(HqEventPageSchema.parse({ events: [base], snapshots: [], cursor: "1", oldestSeq: 1, latestSeq: 1, compacted: false })).toMatchObject({ events: [base] });
    expect(() => HqEventPageSchema.parse({ events: [{ ...base, dispatchId: "dispatch" }], snapshots: [], cursor: "1", oldestSeq: 1, latestSeq: 1, compacted: false })).toThrow();
    expect(() => HqEventPageSchema.parse({ events: [{ ...base, receiptLink: { runId: "run", taskId: "task", dispatchId: "dispatch", terminalHandle: "term" } }], snapshots: [], oldestSeq: 1, latestSeq: 1, cursor: "1", compacted: false })).toThrow();
    for (const kind of ["worker.ready", "worker.retained"]) expect(HqEventPageSchema.parse({
      events: [{ ...base, kind, agentId: "agent", generation: 1, receiptLink: { runId: "run", taskId: "task", dispatchId: "dispatch", terminalHandle: "term" } }],
      snapshots: [], oldestSeq: 1, latestSeq: 1, compacted: false
    })).toMatchObject({ events: [{ agentId: "agent", generation: 1 }], snapshots: [] });
  });

  it("accepts only explicit support variants", () => {
    expect(SupportSchema.parse({ supported: true })).toEqual({ supported: true });
    expect(SupportSchema.parse({ supported: false, reason: "not_available" })).toEqual({ supported: false, reason: "not_available" });
    expect(() => SupportSchema.parse({ supported: false })).toThrow();
  });

  it("requires output content to match its declared source", () => {
    // Break caught: an empty or mixed output page hides source changes from the operator.
    const base = { cursor: "next", archived: false, warnings: [] };
    expect(OrcaOutputPageSchema.parse({ ...base, source: "terminal", lines: ["safe"] })).toBeDefined();
    expect(OrcaOutputPageSchema.parse({ ...base, source: "transcript", messages: [{ id: "m", role: "assistant", text: "safe" }] })).toBeDefined();
    expect(() => OrcaOutputPageSchema.parse({ ...base, source: "terminal" })).toThrow();
    expect(() => OrcaOutputPageSchema.parse({ ...base, source: "terminal", lines: [], messages: [] })).toThrow();
  });
});
