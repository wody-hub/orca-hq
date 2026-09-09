export interface ExecutionControl {
  retainNative(jobId: string): void;
  assertActive(): void;
}
export interface ContextWork {
  contextId: string;
  requestId: string;
  run(control: ExecutionControl): Promise<void>;
  onWaiting?(reason: "context" | "capacity" | "native"): void;
}
export function createContextExecutor(options: { maxContexts?: number; mode?: "legacy" | "native" } = {}) {
  // Native worker capacity belongs exclusively to durable admission. Legacy callers keep their policy.
  const nativeMode = options.mode === "native";
  const max = options.maxContexts ?? 5;
  if (!Number.isInteger(max) || max < 1)
    throw new Error("invalid_context_limit");
  const queue: Array<{
    work: ContextWork;
    resolve(): void;
    reject(error: unknown): void;
  }> = [];
  const turns = new Set<string>();
  const native = new Map<string, Set<string>>();
  const operations = new Map<string, Promise<void>>();
  const running = new Set<Promise<void>>();
  let closed = false;
  const occupied = () => new Set([...turns, ...native.keys()]);
  function pump() {
    if (closed) return;
    for (let i = 0; i < queue.length;) {
      const entry = queue[i]!;
      const { work } = entry;
      if (turns.has(work.contextId) || (!nativeMode && native.has(work.contextId))) {
        work.onWaiting?.(native.has(work.contextId) ? "native" : "context");
        i++;
        continue;
      }
      if (!nativeMode && occupied().size >= max) {
        work.onWaiting?.("capacity");
        break;
      }
      queue.splice(i, 1);
      turns.add(work.contextId);
      const control: ExecutionControl = {
        retainNative(jobId) {
          const jobs = native.get(work.contextId) ?? new Set<string>();
          if (!nativeMode && jobs.size && !jobs.has(jobId))
            throw new Error("context_native_worker_limit");
          jobs.add(jobId);
          native.set(work.contextId, jobs);
        },
        assertActive() {
          if (closed || !turns.has(work.contextId))
            throw new Error("stale_context_execution");
        },
      };
      const operation = Promise.resolve()
        .then(() => work.run(control))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          turns.delete(work.contextId);
          running.delete(operation);
          pump();
        });
      running.add(operation);
    }
  }
  return {
    enqueue(work: ContextWork): Promise<void> {
      if (closed) return Promise.reject(new Error("context_executor_closed"));
      const key = JSON.stringify([work.contextId, work.requestId]);
      const existing = operations.get(key);
      if (existing) return existing;
      const promise = new Promise<void>((resolve, reject) => {
        queue.push({ work, resolve, reject });
      });
      operations.set(key, promise);
      pump();
      return promise;
    },
    restoreNative(contextId: string, jobId: string) {
      const jobs = native.get(contextId) ?? new Set<string>();
      jobs.add(jobId);
      native.set(contextId, jobs);
    },
    observeNative(contextId: string, jobId: string, state: string) {
      if (!["succeeded", "failed", "stopped"].includes(state)) return;
      const jobs = native.get(contextId);
      jobs?.delete(jobId);
      if (!jobs?.size) native.delete(contextId);
      pump();
    },
    get activeContexts() {
      return occupied().size;
    },
    get queued() {
      return queue.length;
    },
    async close() {
      closed = true;
      for (const entry of queue.splice(0))
        entry.reject(new Error("context_executor_closed"));
      await Promise.allSettled([...running]);
    },
  };
}
