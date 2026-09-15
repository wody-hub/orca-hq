import { it, expect } from "vitest";
import { OperationsOrca } from "../src/operations-orca.js";
it("bounds simultaneous reads to four and uses typed inbox, timeout and output budgets", async () => {
  let active = 0,
    max = 0;
  const calls: Array<{
    argv: readonly string[];
    timeoutMs: number;
    maxOutputBytes?: number;
  }> = [];
  const client = new OperationsOrca({
    executablePath: "/fake/orca",
    signal: new AbortController().signal,
    run: async (argv, options) => {
      active++;
      max = Math.max(max, active);
      calls.push({ argv, ...options });
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return {
        id: "r",
        ok: true,
        result: { messages: [], count: 0 },
        _meta: { runtimeId: "runtime" },
      };
    },
  });
  await Promise.all(
    Array.from({ length: 9 }, () =>
      client.execute({ kind: "operations_inbox", limit: 100 }),
    ),
  );
  expect(max).toBe(4);
  expect(
    calls.every(
      (c) =>
        c.timeoutMs === 10000 &&
        c.maxOutputBytes === 2097152 &&
        c.argv.join(" ") === "orchestration inbox --limit 100",
    ),
  ).toBe(true);
});
it("rejects source and mutation identities that disagree with the requested operation", async () => {
  const client = new OperationsOrca({
    executablePath: "/fake",
    signal: new AbortController().signal,
    run: async () => ({
      id: "r",
      ok: true,
      result: {
        dispatchId: "different",
        state: "stopped",
        verdict: "stopped",
        mutation: { requestId: "req", replayed: false },
      },
    }),
  });
  await expect(
    client.execute({
      kind: "operations_stop",
      dispatchId: "d",
      retryRequestId: "req",
    }),
  ).rejects.toThrow("receipt_identity_mismatch");
});
