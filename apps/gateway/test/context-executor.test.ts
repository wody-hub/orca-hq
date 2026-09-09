import { it, expect, vi } from "vitest";
import { createContextExecutor } from "../src/context-executor.js";
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
it("executes FIVE independent contexts, queues sixth FIFO, and serializes same context", async () => {
  const executor = createContextExecutor();
  const gates = Array.from({ length: 7 }, gate);
  const started: string[] = [];
  const add = (contextId: string, index: number) =>
    executor.enqueue({
      contextId,
      requestId: String(index),
      run: async () => {
        started.push(String(index));
        await gates[index]!.promise;
      },
    });
  const pending = Array.from({ length: 6 }, (_, i) => add("ctx" + i, i));
  const same = add("ctx0", 6);
  await tick();
  expect(started).toEqual(["0", "1", "2", "3", "4"]);
  gates[1]!.resolve();
  await tick();
  expect(started).toEqual(["0", "1", "2", "3", "4", "5"]);
  expect(started).not.toContain("6");
  gates[0]!.resolve();
  await tick();
  expect(started).toContain("6");
  for (const g of gates) g.resolve();
  await Promise.all([...pending, same]);
  await executor.close();
});
it("retains slots for native workers and does not reclaim unknown workers", async () => {
  const executor = createContextExecutor({ maxContexts: 1 });
  const run = vi.fn(async () => {});
  await executor.enqueue({
    contextId: "a",
    requestId: "a",
    run: async (control) => {
      control.retainNative("job");
    },
  });
  const next = executor.enqueue({ contextId: "b", requestId: "b", run });
  executor.observeNative("a", "job", "recovery_required");
  await tick();
  expect(run).not.toHaveBeenCalled();
  executor.observeNative("a", "job", "succeeded");
  await next;
  expect(run).toHaveBeenCalledOnce();
  await executor.close();
});
it("isolates failures and deduplicates execution identity", async () => {
  const executor = createContextExecutor();
  const run = vi.fn(async () => {
    throw new Error("failed");
  });
  const a = executor.enqueue({ contextId: "a", requestId: "a", run });
  const replay = executor.enqueue({ contextId: "a", requestId: "a", run });
  expect(a).toBe(replay);
  await expect(a).rejects.toThrow("failed");
  await expect(
    executor.enqueue({ contextId: "b", requestId: "b", run: async () => {} }),
  ).resolves.toBeUndefined();
  expect(run).toHaveBeenCalledOnce();
  await executor.close();
});

it("native mode sequences planning turns without imposing context capacity or a one-worker-per-context limit", async () => {
  const executor = createContextExecutor({ mode: "native" });
  const hold = gate();
  const started: string[] = [];
  const pending = Array.from({ length: 12 }, (_, i) => executor.enqueue({
    contextId: `c${i}`, requestId: `r${i}`,
    run: async control => { started.push(`r${i}`); control.retainNative(`worker_${i}`); control.retainNative(`sibling_${i}`); await hold.promise; }
  }));
  const followup = executor.enqueue({ contextId: "c0", requestId: "followup", run: async () => { started.push("followup"); } });
  await tick();
  expect(started).toHaveLength(12);
  expect(started).not.toContain("followup");
  hold.resolve(); await Promise.all([...pending, followup]);
  expect(started.at(-1)).toBe("followup");
  await executor.close();
});
