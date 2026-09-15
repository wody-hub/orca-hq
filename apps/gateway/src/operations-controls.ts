import { z } from "zod";
import type { SubmitProgressRequest } from "@orca-hq/core";
import type { ProgressStore } from "./progress-store.js";
import type { OperationsJournal } from "./operations-journal.js";
import type { OperationsOrcaPort } from "./operations-orca.js";
import { OperationsError } from "./operations-http.js";
import {
  Id,
  State,
  Terminal,
  Run,
  Task,
  Worker,
  Message,
  Receipt,
} from "./operations-projections.js";
import type { QuestionRecord } from "./native-coordinator.js";
const Body = z
  .string()
  .min(1)
  .max(8000)
  .refine((value) => value.trim().length > 0);
const uncertain = new Set([
  "unknown",
  "unverifiable",
  "release_pending",
  "release_unknown",
  "transferred",
]);
const runtimeSchema = z.object({
  runtime: z
    .object({
      state: State,
      reachable: z.boolean(),
      appVersion: State,
      capabilities: z.array(State),
      connectionState: State.optional(),
    })
    .passthrough(),
});
export function controlSupport(
  runtime: z.infer<typeof runtimeSchema>["runtime"],
) {
  const patch = /^1\.4\.(\d+)$/.exec(runtime.appVersion);
  return (
    runtime.state === "ready" &&
    runtime.reachable &&
    !!patch &&
    Number(patch[1]) >= 203 &&
    ["orchestration.contract.v1", "orchestration.worker-stop-verdict.v1"].every(
      (c) => runtime.capabilities.includes(c),
    )
  );
}
const scope = { runId: Id };
const workerInput = z.object({ ...scope, expectedIncarnation: Id }).strict();
const followupInput = workerInput.extend({ body: Body }).strict();
const replyInput = z.object({ ...scope, body: Body }).strict();
const dispatchInput = workerInput.extend({ terminalHandle: Id, inject: z.boolean() }).strict();
type Action = "dispatch" | "followup" | "reply" | "stop" | "retain" | "release";
export interface OperationsServiceOptions {
  store: ProgressStore;
  journal: OperationsJournal;
  orca: OperationsOrcaPort;
  submit(input: SubmitProgressRequest): Promise<unknown> | unknown;
  capacity: {
    limit: number | "unlimited";
    source: "config" | "environment" | "default";
    snapshot(): { active: number; queued: number };
    attempts(): ReadonlyArray<{
      state: string;
      item?: { attemptId: string; requestId: string; contextId: string };
    }>;
  };
}
export class OperationsControls {
  constructor(protected readonly options: OperationsServiceOptions) {}
  protected async read<T extends z.ZodTypeAny>(
    op: Parameters<OperationsOrcaPort["execute"]>[0],
    schema: T,
    runtimeId?: string,
  ): Promise<z.infer<T>> {
    const receipt = Receipt.parse(await this.options.orca.execute(op));
    if (runtimeId && receipt._meta?.runtimeId !== runtimeId)
      throw new OperationsError(409, "runtime_changed");
    return schema.parse(receipt.result);
  }
  protected inbox(runtimeId?: string) {
    return this.read(
      { kind: "operations_inbox", limit: 100 },
      z
        .object({ messages: z.array(Message).max(100), count: z.number() })
        .passthrough(),
      runtimeId,
    );
  }
  private async owner(runId: string, runtimeId: string) {
    const { run } = await this.read(
      { kind: "show_run", runId },
      z.object({ run: Run }),
      runtimeId,
    );
    if (run.id !== runId || !run.coordinator_handle || !run.consumer_generation)
      throw new OperationsError(409, "run_owner_unverifiable");
    const { terminal } = await this.read(
      { kind: "show_terminal", terminalHandle: run.coordinator_handle },
      z.object({ terminal: Terminal }),
      runtimeId,
    );
    if (
      terminal.handle !== run.coordinator_handle ||
      !terminal.connected ||
      !terminal.writable ||
      terminal.orphaned ||
      terminal.executionHostId !== "local" ||
      !terminal.ptyId
    )
      throw new OperationsError(409, "sender_unverifiable");
    const { tasks } = await this.read(
      { kind: "list_tasks", runId },
      z.object({ tasks: z.array(Task).max(100) }),
      runtimeId,
    );
    if (
      !tasks.some(
        (task) =>
          task.run_id === runId &&
          task.created_by_terminal_handle === terminal.handle &&
          task.created_by_process_incarnation ===
            `${terminal.ptyId}:${terminal.incarnationId}` &&
          task.created_by_run_generation === run.consumer_generation,
      )
    )
      throw new OperationsError(409, "sender_incarnation_unverifiable");
    return { run, terminal };
  }
  async mutate(action: Action, targetId: string, raw: unknown, key: string) {
    Id.parse(targetId);
    const input = (
      action === "dispatch"
        ? dispatchInput
        : action === "reply"
          ? replyInput
          : action === "followup"
            ? followupInput
            : workerInput
    ).parse(raw);
    return this.options.journal.execute(
      { requestId: key, action, targetId, input },
      async () => {
        let effectStarted = false;
        try {
          const status = Receipt.parse(
            await this.options.orca.execute({ kind: "operations_status" }),
          );
          const runtimeId = status._meta?.runtimeId;
          if (
            !runtimeId ||
            !controlSupport(runtimeSchema.parse(status.result).runtime)
          )
            throw new OperationsError(409, "control_capability_unavailable");
          const owner = await this.owner(input.runId, runtimeId);
          let managedAnswer: SubmitProgressRequest | undefined;
          const validateTarget = async () => {
            if (action === "reply") {
              const q = (await this.inbox(runtimeId)).messages.find(
                (m) =>
                  m.id === targetId &&
                  m.type === "question" &&
                  m.run_id === input.runId &&
                  (!m.question || m.question.status === "pending"),
              );
              if (!q) throw new OperationsError(409, "question_not_current");
              const native = this.options.store
                .nativeJournal()
                .get<QuestionRecord>("question", targetId);
              if (native) {
                if (native.answered)
                  throw new OperationsError(409, "question_already_answered");
                const attempt = this.options.capacity
                  .attempts()
                  .find((a) => a.item?.attemptId === native.attemptId);
                const event = attempt
                  ? undefined
                  : this.options.store
                      .readEvents({ after: 0, limit: 500 })
                      .events.find((e) => e.payload.messageId === targetId);
                const requestId = attempt?.item?.requestId ?? event?.requestId;
                const request =
                  requestId && this.options.store.getRequest(requestId);
                if (!request)
                  throw new OperationsError(
                    409,
                    "hq_question_context_unavailable",
                  );
                managedAnswer = {
                  requestId: key,
                  sessionId: request.sessionId,
                  text: `/answer ${targetId} ${(input as z.infer<typeof replyInput>).body}`,
                };
              }
            } else if (action === "dispatch") {
              const { tasks } = await this.read(
                { kind: "list_tasks", runId: input.runId },
                z.object({ tasks: z.array(Task).max(100) }),
                runtimeId,
              );
              const task = tasks.find((t) => t.id === targetId);
              if (
                !task ||
                task.run_id !== input.runId ||
                task.status !== "pending" ||
                task.created_by_terminal_handle !== owner.terminal.handle ||
                task.created_by_process_incarnation !==
                  `${owner.terminal.ptyId}:${owner.terminal.incarnationId}` ||
                task.created_by_run_generation !== owner.run.consumer_generation
              )
                throw new OperationsError(409, "task_not_dispatchable");
              const d = input as z.infer<typeof dispatchInput>;
              const { terminal } = await this.read(
                { kind: "show_terminal", terminalHandle: d.terminalHandle },
                z.object({ terminal: Terminal }),
                runtimeId,
              );
              if (
                terminal.handle !== d.terminalHandle ||
                terminal.incarnationId !== d.expectedIncarnation ||
                !terminal.connected ||
                !terminal.writable ||
                terminal.orphaned ||
                terminal.executionHostId !== "local"
              )
                throw new OperationsError(409, "terminal_changed");
            } else {
              const w = await this.read(
                  { kind: "operations_show_worker", dispatchId: targetId },
                  Worker,
                  runtimeId,
                ),
                t = w.terminal,
                r = w.terminalResource;
              if (
                w.dispatch.id !== targetId ||
                w.worker.dispatchId !== targetId ||
                w.projection.dispatchId !== targetId ||
                w.dispatch.runId !== input.runId ||
                w.projection.runId !== input.runId ||
                w.projection.taskId !== w.dispatch.taskId ||
                !w.observation.exactWorker ||
                !t ||
                t.executionHostId !== "local" ||
                t.handle !== w.worker.agentTerminalHandle ||
                t.incarnationId !==
                  (input as z.infer<typeof workerInput>).expectedIncarnation ||
                !t.ptyId ||
                w.dispatch.processIncarnation !==
                  `${t.ptyId}:${t.incarnationId}` ||
                r.endpointIncarnation !== w.dispatch.processIncarnation ||
                r.ownerDispatchId !== targetId ||
                r.terminalHandle !== t.handle ||
                !["owned", "retained"].includes(r.ownershipState) ||
                !["not_requested", "retained"].includes(r.releaseState) ||
                !w.projection.resource ||
                w.projection.resource.ownerDispatchId !== targetId ||
                !["owned", "retained"].includes(w.projection.resource.state) ||
                !["not_requested", "retained"].includes(
                  w.projection.resource.releaseState,
                ) ||
                uncertain.has(w.worker.state) ||
                uncertain.has(w.dispatch.status) ||
                uncertain.has(w.projection.liveness.verdict) ||
                uncertain.has(w.observation.status)
              )
                throw new OperationsError(409, "worker_unverifiable");
              const settled =
                ["succeeded", "failed", "stopped"].includes(
                  w.projection.outcome ?? "",
                ) &&
                [
                  "worker_done",
                  "completed",
                  "succeeded",
                  "failed",
                  "stopped",
                ].includes(w.dispatch.status) &&
                ["live", "exited"].includes(w.projection.liveness.verdict) &&
                ["live", "exited"].includes(w.observation.status);
              if (action === "release") {
                if (!settled)
                  throw new OperationsError(409, "worker_not_settled");
              } else if (
                !(action === "retain" && settled) &&
                (w.projection.liveness.verdict !== "live" ||
                  w.observation.status !== "live" ||
                  !t.connected ||
                  !t.writable ||
                  t.orphaned)
              )
                throw new OperationsError(409, "worker_not_live");
            }
          };
          await validateTarget();
          const fresh = await this.owner(input.runId, runtimeId);
          if (
            owner.terminal.handle !== fresh.terminal.handle ||
            owner.terminal.incarnationId !== fresh.terminal.incarnationId ||
            owner.terminal.ptyId !== fresh.terminal.ptyId ||
            owner.run.consumer_generation !== fresh.run.consumer_generation
          )
            throw new OperationsError(409, "sender_changed");
          await validateTarget();
          if (managedAnswer) {
            effectStarted = true;
            await this.options.submit(managedAnswer);
            return { state: "accepted" };
          }
          const common = {
            senderHandle: fresh.terminal.handle,
            runId: input.runId,
            retryRequestId: key,
          };
          const op =
            action === "reply"
              ? {
                  kind: "operations_reply" as const,
                  messageId: targetId,
                  body: (input as z.infer<typeof replyInput>).body,
                  ...common,
                }
              : action === "followup"
                ? {
                    kind: "operations_send" as const,
                    dispatchId: targetId,
                    body: (input as z.infer<typeof followupInput>).body,
                    ...common,
                  }
                : action === "dispatch"
                  ? {
                      kind: "operations_dispatch" as const,
                      taskId: targetId,
                      terminalHandle: (input as z.infer<typeof dispatchInput>)
                        .terminalHandle,
                      inject: (input as z.infer<typeof dispatchInput>).inject,
                      ...common,
                    }
                  : {
                      kind:
                        action === "stop"
                          ? ("operations_stop" as const)
                          : action === "retain"
                            ? ("operations_retain" as const)
                            : ("operations_release" as const),
                      dispatchId: targetId,
                      retryRequestId: key,
                    };
          effectStarted = true;
          const receipt = Receipt.parse(await this.options.orca.execute(op));
          const result = z.record(z.unknown()).parse(receipt.result);
          if (receipt._meta?.runtimeId !== runtimeId)
            return { state: "unknown", detail: "runtime_changed" };
          if (
            uncertain.has(String(result.state)) ||
            uncertain.has(String(result.verdict)) ||
            (["stop", "retain", "release"].includes(action) &&
              (![
                "accepted",
                "stopped",
                "retained",
                "released",
                "already_released",
              ].includes(String(result.state)) ||
                ![
                  "accepted",
                  "stopped",
                  "retained",
                  "released",
                  "already_released",
                ].includes(String(result.verdict))))
          )
            return { state: "unknown", detail: "effect_unverifiable" };
          return { state: "accepted" };
        } catch (e) {
          const err = e as { code?: string; orcaCode?: string };
          if (
            err.code === "orca_stale_handle" ||
            (err.code === "orca_command_failed" &&
              [
                "no_active_sender_terminal",
                "invalid_argument",
                "terminal_handle_stale",
              ].includes(err.orcaCode ?? ""))
          )
            return { state: "rejected", detail: "orca_rejected_before_effect" };
          if (e instanceof OperationsError)
            return { state: "rejected", detail: e.code };
          if (!effectStarted)
            return { state: "rejected", detail: "gate_evidence_unverifiable" };
          throw e;
        }
      },
    );
  }
}
