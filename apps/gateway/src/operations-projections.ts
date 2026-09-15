import { z } from "zod";
import { redactRelayText } from "./orca-relay.js";
import { redactPublicText } from "@orca-hq/core";
export const Cursor = z.string().min(1).max(2048);
export const Id = z.string().min(1).max(512);
export const State = z.string().trim().min(1).max(512);
export const Terminal = z
  .object({
    handle: Id,
    ptyId: Id.optional(),
    incarnationId: Id,
    connected: z.boolean(),
    writable: z.boolean(),
    executionHostId: Id,
    worktreeId: Id,
    orphaned: z.boolean().optional(),
  })
  .passthrough();
export const Run = z
  .object({
    id: Id,
    objective: z.string(),
    coordinator_handle: Id.optional(),
    consumer_generation: z.number().int().positive().optional(),
  })
  .passthrough();
export const Task = z
  .object({
    id: Id,
    status: State,
    run_id: Id.optional(),
    created_by_terminal_handle: Id.optional(),
    created_by_process_incarnation: Id.optional(),
    created_by_run_generation: z.number().int().optional(),
  })
  .passthrough();
export const Worker = z
  .object({
    dispatch: z
      .object({
        id: Id,
        runId: Id,
        taskId: Id,
        status: State,
        processIncarnation: Id.nullable().optional(),
      })
      .passthrough(),
    worker: z
      .object({
        dispatchId: Id,
        state: State,
        stage: State,
        agentTerminalHandle: Id.nullable(),
      })
      .passthrough(),
    projection: z
      .object({
        dispatchId: Id,
        taskId: Id,
        runId: Id,
        liveness: z.object({ verdict: State }).passthrough(),
        outcome: State.optional(),
        resource: z
          .object({
            state: State,
            ownerDispatchId: Id.nullable().optional(),
            releaseState: State,
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    observation: z
      .object({ status: State, exactWorker: z.boolean() })
      .passthrough(),
    terminal: Terminal.nullable(),
    terminalResource: z
      .object({
        id: Id,
        ownershipState: State,
        releaseState: State,
        ownerDispatchId: Id.nullable().optional(),
        terminalHandle: Id.optional(),
        endpointIncarnation: Id.optional(),
      })
      .passthrough(),
  })
  .passthrough();
export const Message = z
  .object({
    id: Id,
    type: State,
    subject: z.string(),
    body: z.string(),
    run_id: Id.nullable().optional(),
    from_handle: Id.optional(),
    to_handle: Id.optional(),
    created_at: z.string().optional(),
    question: z.object({ status: State }).passthrough().optional(),
  })
  .passthrough();
/** Sanitize all nested public strings and strip credential/command-bearing fields before serialization. */
export function publicValue(value: unknown, depth = 0): unknown {
  if (depth > 24) return "[depth_limit]";
  if (typeof value === "string")
    return redactPublicText(redactRelayText(value));
  if (Array.isArray(value)) return value.map((v) => publicValue(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !/(?:^|_)(?:token|secret|password|cookie|csrf|authorization|argv|environment|capability)(?:$|_)/i.test(
              k,
            ) &&
            ![
              "dispatchCapability",
              "dispatchCapabilityToken",
              "startOptions",
            ].includes(k),
        )
        .map(([k, v]) => [k, publicValue(v, depth + 1)]),
    );
  return value;
}
export function evidence(source: "hq_store" | "orca_cli", command?: string) {
  return {
    source,
    observedAt: new Date().toISOString(),
    verification: "observed" as const,
    ...(command ? { command } : {}),
  };
}
export const Receipt = z.object({
  id: Id,
  ok: z.literal(true),
  result: z.unknown(),
  _meta: z
    .object({ runtimeId: Id.nullable().optional() })
    .passthrough()
    .optional(),
});
