import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { NativeWorkPlanSchema, type NativeWorkItem, type NativeWorkerReceipt } from "@orca-hq/core";
import type { ManagedCommandInput, ManagedCommandResult, CommandJob } from "./managed-commands.js";
import type { NativeLaunchResult, NativeLaunchJournalEntry, NativeRetentionPolicy } from "./native-launch.js";
import type { WorkerAdmission, WorkerOutcome, WorkerResourceVerdict } from "./worker-admission.js";
import type { ProgressStore } from "./progress-store.js";
import { publicProgressText } from "./progress-events.js";

const MessageSchema = z.object({
  id: z.string().min(1), type: z.string().min(1), body: z.string().default(""),
  taskId: z.string().optional(), dispatchId: z.string().optional(),
  outcome: z.enum(["succeeded", "failed", "stopped"]).optional(),
  fanout: z.array(z.object({ id: z.string().min(1), objective: z.string().min(1).max(8000), dependsOn: z.array(z.string()), access: z.enum(["read", "write"]) }).strict()).max(128).optional()
}).strict();
export type NativeMessage = z.infer<typeof MessageSchema>;
export interface NativeDelivery { runId: string; deliveryId: string; messages: NativeMessage[] }
export interface NativeCoordinatorRelay {
  startNativeWork(item: NativeWorkItem): Promise<NativeLaunchResult>;
  getNativeLaunch(attemptId: string): NativeLaunchJournalEntry;
  checkDelivery(): Promise<NativeDelivery | undefined>;
  stopNative?(receipt: NativeWorkerReceipt): Promise<boolean>;
  /** Exact liveness proof for one owned Dispatch; a bound receipt alone only proves the launch happened. */
  observeNativeWorker?(receipt: NativeWorkerReceipt): Promise<{ live: boolean; recovery?: unknown }>;
  acknowledgeDelivery(delivery: NativeDelivery): Promise<void>;
  cleanupNative(receipt: NativeWorkerReceipt, policy: NativeRetentionPolicy): Promise<{ verdict: WorkerResourceVerdict; recovery?: unknown }>;
  sendNativeGuidance(receipt: NativeWorkerReceipt, text: string, id: string): Promise<{ messageId: string }>;
  replyNativeQuestion(receipt: NativeWorkerReceipt, messageId: string, text: string, id: string): Promise<{ messageId: string }>;
}
type Phase = "received" | "applied" | "cleanup_pending" | "acknowledged";
interface MessageRecord { message: NativeMessage; runId: string; phase: Phase; attemptId?: string; ignored?: boolean; recovery?: unknown; children?: NativeWorkItem[]; quarantine?: string }
export interface NativeQuarantineRecord { id: string; reason: string; detail: unknown; at: string }
interface PlanRecord { id: string; inputKey: string; items: NativeWorkItem[]; source: ManagedCommandInput["source"]; userId: string }
export interface QuestionRecord extends NativeMessage { attemptId: string; answered?: boolean; answer?: string }
const key = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export function createNativeCoordinator(options: {
  planner: { plan(input: ManagedCommandInput): Promise<NativeWorkItem[]> | NativeWorkItem[] };
  admission: WorkerAdmission; relay: NativeCoordinatorRelay; store: ProgressStore;
  hasLegacyConflict?: (resources: NativeWorkItem["resources"]) => boolean;
  retentionPolicy: NativeRetentionPolicy; childRetentionPolicy?: NativeRetentionPolicy; pollMs?: number;
}) {
  const { admission, relay, store } = options;
  const journal = store.nativeJournal();
  const launching = new Map<string, Promise<void>>();
  const executions = new Map<string, Promise<ManagedCommandResult>>();
  const executionKeys = new Map<string, string>();
  const inputKey = (input: ManagedCommandInput) => key(input.id, input.text, input.source, input.userId, JSON.stringify(input.nativeScope ?? null), input.execution?.contextId ?? "", input.execution?.requestId ?? "", String(input.execution?.generation));
  let closed = false, started = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickWork: Promise<void> | undefined;
  let deliveries = Promise.resolve();
  // Lease renewal must not wait behind slow CLI calls or startup observations.
  const leaseTimer = setInterval(() => { if (!closed) { try { admission.heartbeat(); } catch { /* Every mutation still fences itself. */ } } }, 1000);
  leaseTimer.unref();
  function fence() { if (closed) throw Error("native_coordinator_closed"); admission.heartbeat(); }
  const attempts = () => admission.listAttempts();
  /** Durable rejection record: a malformed message is quarantined with its reason, never re-thrown forever. */
  function quarantine(id: string, reason: string, detail: unknown) {
    journal.put("quarantine", id, { id, reason, detail: JSON.parse(JSON.stringify(detail ?? null)), at: new Date().toISOString() } satisfies NativeQuarantineRecord);
  }
  function emit(item: NativeWorkItem, kind: "worker.launching" | "worker.ready" | "worker.retained" | "worker.recovery_required", receipt?: NativeWorkerReceipt) {
    store.appendEvent({ requestId: item.requestId, contextId: item.contextId, generation: item.generation,
      eventKey: key(kind, item.attemptId, receipt?.dispatchId ?? "launch"), source: "orca", kind,
      payload: JSON.parse(JSON.stringify({ attemptId: item.attemptId, worktreeId: item.worktreeId, requested: item.profile,
        ...(receipt ?? {}), text: kind === "worker.ready" ? "Orca 작업자 준비 완료" : kind === "worker.launching" ? "Orca 작업자 시작 중" : kind === "worker.retained" ? "Orca 작업자 터미널 보관" : "Orca 작업자 복구 확인 필요" })) });
  }
  function current(item: NativeWorkItem) { return store.getContextAgent(item.contextId)?.generation === item.generation; }
  function projectJob(item: NativeWorkItem): CommandJob {
    const attempt = attempts().find(a => a.item.attemptId === item.attemptId)!;
    const result = journal.list<MessageRecord>("message").find(m => m.attemptId === item.attemptId && m.message.type === "worker_done" && !m.ignored);
    return { id: attempt.receipt?.taskId ?? item.attemptId, projectId: item.projectId, projectName: item.projectId,
      prompt: item.objective, state: attempt.state === "settled" ? attempt.outcome! : ["unknown", "release_unknown"].includes(attempt.state) ? "recovery_required" : attempt.state === "queued" ? "queued" : "running",
      ...(attempt.receipt ? { dispatchId: attempt.receipt.dispatchId } : {}),
      execution: { requestId: item.requestId, contextId: item.contextId, generation: item.generation },
      worktreePath: item.worktreeId.slice(item.worktreeId.indexOf("::") + 2),
      createdAt: "", updatedAt: "", ...(result ? { result: { summary: result.message.body, modifiedFiles: [], validation: [] } } : {}) };
  }
  function bind(item: NativeWorkItem, receipt: NativeWorkerReceipt) {
    admission.bindReceipt(receipt);
    store.linkContextJob({ contextId: item.contextId, requestId: item.requestId, jobId: receipt.taskId, dispatchId: receipt.dispatchId });
    emit(item, "worker.ready", receipt);
  }
  async function launch(item: NativeWorkItem) {
    emit(item, "worker.launching");
    try {
      const result = await relay.startNativeWork(item);
      fence();
      if (result.state === "ready") bind(item, result.receipt);
      else if (result.state === "proven_no_launch") admission.recoverProvenNoLaunch(result.proof);
      else { admission.markUnknown(item.attemptId); emit(item, "worker.recovery_required"); }
    } catch {
      if (!closed) { admission.markUnknown(item.attemptId); emit(item, "worker.recovery_required"); }
    }
  }
  function reconcileResults() {
    const all = attempts();
    for (const a of all) {
      if (!current(a.item) || a.state !== "settled") continue;
      const related = all.filter(other => other.item.requestId === a.item.requestId && other.item.contextId === a.item.contextId);
      if (!related.every(other => other.state === "settled")) continue;
      store.reconcileNativeAssignment({ requestId: a.item.requestId, contextId: a.item.contextId, generation: a.item.generation,
        outcome: { state: related.every(other => other.outcome === "succeeded") ? "completed" : "failed", text: related.map(other => projectJob(other.item).result?.summary ?? other.outcome!).join("\n") } });
    }
  }
  function pump() {
    fence();
    let item: NativeWorkItem | undefined;
    while ((item = admission.claimNext(candidate => !options.hasLegacyConflict?.(candidate.resources)))) {
      const work = item;
      const pending = launch(work).finally(() => launching.delete(work.attemptId));
      launching.set(work.attemptId, pending);
      void pending.catch(() => {});
    }
  }
  function children(parent: NativeWorkItem, proposals: NonNullable<NativeMessage["fanout"]>): NativeWorkItem[] {
    const ids = new Map(proposals.map(p => [p.id, `fan_${key(parent.attemptId, p.id)}`]));
    if (ids.size !== proposals.length) throw Error("duplicate_fanout_id");
    const plan = proposals.map(p => {
      if (p.access === "write" && parent.access !== "write") throw Error("fanout_scope_escalation");
      return { ...parent, attemptId: ids.get(p.id)!, objective: p.objective,
        access: p.access, resources: parent.resources.map(r => ({ ...r, mode: p.access === "read" ? "read" as const : r.mode })),
        dependsOn: p.dependsOn.map(id => { const mapped = ids.get(id); if (!mapped) throw Error("unknown_fanout_dependency"); return mapped; }),
        resumeTerminalHandle: undefined };
    });
    return NativeWorkPlanSchema.parse(plan);
  }
  async function apply(delivery: NativeDelivery) {
    fence();
    const previous = journal.get<{ delivery: NativeDelivery; phase: Phase }>("delivery", delivery.deliveryId);
    if (previous?.phase === "acknowledged") return;
    if (previous && !isDeepStrictEqual(previous.delivery, delivery)) {
      // A contradicting redelivery is an integrity fault, but wedging every other worker is worse.
      // The rejected batch is durable before the ack, so nothing needing recovery is lost.
      quarantine(delivery.deliveryId, "native_delivery_collision", { received: delivery, accepted: previous.delivery });
      await relay.acknowledgeDelivery(previous.delivery);
      fence();
      journal.put("delivery", delivery.deliveryId, { delivery: previous.delivery, phase: "acknowledged" });
      return;
    }
    journal.put("delivery", delivery.deliveryId, { delivery, phase: "received" });
    // Persist the entire batch before applying any message or making a cleanup call.
    const accepted: string[] = [];
    // Best-effort attribution for a rejected message: the envelope may still name its owner even when
    // the payload is unusable. Surfacing recovery never releases the slot, and never settles anything.
    const flagRejected = (raw: unknown) => {
      const envelope = (raw ?? {}) as { taskId?: unknown; dispatchId?: unknown };
      const owner = attempts().find(a => a.receipt?.runId === delivery.runId && a.receipt.taskId === envelope.taskId && a.receipt.dispatchId === envelope.dispatchId);
      if (owner?.receipt && owner.state !== "settled" && current(owner.item)) emit(owner.item, "worker.recovery_required", owner.receipt);
    };
    for (const [index, raw] of delivery.messages.entries()) {
      let message: NativeMessage;
      // An unparseable message identifies no attempt, so its worker keeps its slot until recovery.
      try { message = MessageSchema.parse(raw); }
      catch (error) { quarantine(`${delivery.deliveryId}:${index}`, "native_message_invalid", { raw, error: String(error) }); flagRejected(raw); continue; }
      const existing = journal.get<MessageRecord>("message", message.id);
      if (existing && (existing.runId !== delivery.runId || !isDeepStrictEqual(existing.message, message))) {
        quarantine(`${delivery.deliveryId}:${message.id}`, "native_message_collision", { received: message, accepted: existing.message });
        flagRejected(message);
        continue;
      }
      if (!existing) journal.put("message", message.id, { message, runId: delivery.runId, phase: "received" });
      accepted.push(message.id);
    }
    let pending = false;
    for (const messageId of accepted) {
      fence();
      const record = journal.get<MessageRecord>("message", messageId)!;
      const message = record.message;
      if (record.phase === "acknowledged") continue;
      const attempt = attempts().find(a => a.receipt?.runId === delivery.runId && a.receipt.taskId === message.taskId && a.receipt.dispatchId === message.dispatchId);
      if (!attempt) {
        // Completion may arrive before the launch observation. Preserve such owned mail for recovery.
        const unbound = attempts().some(a => {
          if (a.receipt || a.state === "queued" || a.state === "settled") return false;
          try { const launch = relay.getNativeLaunch(a.item.attemptId); return launch.runId === delivery.runId && launch.taskId === message.taskId && (!launch.dispatchId || launch.dispatchId === message.dispatchId); }
          catch { return false; }
        });
        if (unbound) { pending = true; continue; }
      }
      if (!attempt || !current(attempt.item)) {
        journal.put("message", message.id, { ...record, ignored: true, phase: "applied" }); continue;
      }
      const { item, receipt } = attempt;
      record.attemptId = item.attemptId;
      if (message.type === "question") {
        if (!journal.get("question", message.id)) {
          journal.put("question", message.id, { ...message, attemptId: item.attemptId });
          store.appendEvent({ requestId: item.requestId, contextId: item.contextId, generation: item.generation, eventKey: key("question", message.id), kind: "clarification.required", source: "orca", payload: { text: publicProgressText(`${message.body}\n답변: /answer ${message.id} <답변>`), messageId: message.id, dispatchId: receipt!.dispatchId } });
        }
        record.phase = "applied";
      } else if (message.type === "worker_done" && message.outcome) {
        // A second message for an already-settled attempt cannot overwrite the accepted result.
        const accepted = journal.list<MessageRecord>("message").find(m => m.attemptId === item.attemptId && m.message.id !== message.id && m.message.type === "worker_done" && !m.ignored);
        if (accepted) { record.ignored = true; record.phase = "applied"; journal.put("message", message.id, record); continue; }
        if (record.phase === "received") {
          // An invalid fanout proposal must not reject the accepted result or strand the worker's slot.
          if (message.fanout?.length) {
            try { record.children = children(item, message.fanout); }
            catch (error) {
              record.quarantine = String(error);
              quarantine(`${delivery.deliveryId}:${message.id}:fanout`, "native_fanout_invalid", { attemptId: item.attemptId, fanout: message.fanout, error: String(error) });
              emit(item, "worker.recovery_required", receipt!);
            }
          }
          record.phase = "applied";
          journal.put("message", message.id, record); // result first; a crash here must replay cleanup
        }
        record.phase = "cleanup_pending";
        journal.put("message", message.id, record);
        admission.beginRelease(item.attemptId, receipt!.dispatchId);
        let cleanup: Awaited<ReturnType<NativeCoordinatorRelay["cleanupNative"]>>;
        if (attempt.state === "settled" && (attempt.resourceVerdict === "released" || attempt.resourceVerdict === "retained_idle")) cleanup = { verdict: attempt.resourceVerdict };
        else {
          try { cleanup = await relay.cleanupNative(receipt!, item.attemptId.startsWith("fan_") ? options.childRetentionPolicy ?? "release" : options.retentionPolicy); }
          catch { cleanup = { verdict: "unknown" }; }
        }
        fence();
        record.recovery = cleanup.recovery;
        if (!admission.settle(item.attemptId, receipt!.dispatchId, message.outcome, cleanup.verdict)) throw Error("native_settlement_fenced");
        if (cleanup.verdict !== "released" && cleanup.verdict !== "retained_idle") {
          pending = true; emit(item, "worker.recovery_required", receipt!);
        } else {
          if (cleanup.verdict === "retained_idle") emit(item, "worker.retained", receipt!);
          // Planner releases its slot before children acquire theirs; no wait-for-child deadlock.
          if (message.outcome === "succeeded") for (const child of record.children ?? []) admission.enqueue(child);
          record.phase = "applied";
        }
      } else record.phase = "applied";
      journal.put("message", message.id, record);
    }
    journal.put("delivery", delivery.deliveryId, { delivery, phase: pending ? "cleanup_pending" : "applied" });
    if (pending) return;
    reconcileResults();
    await relay.acknowledgeDelivery(delivery);
    fence();
    for (const messageId of accepted) journal.put("message", messageId, { ...journal.get<MessageRecord>("message", messageId)!, phase: "acknowledged" });
    journal.put("delivery", delivery.deliveryId, { delivery, phase: "acknowledged" });
    pump();
  }
  function processDelivery(delivery: NativeDelivery): Promise<void> {
    const work = deliveries.then(() => apply(delivery));
    deliveries = work.catch(() => {});
    return work;
  }
  async function tick() {
    if (closed) return;
    fence();
    for (const pending of journal.list<{ delivery: NativeDelivery; phase: Phase }>("delivery")) {
      if (pending.phase !== "acknowledged") await processDelivery(pending.delivery);
    }
    reconcileResults();
    const delivery = await relay.checkDelivery();
    if (delivery) await processDelivery(delivery);
    pump();
  }
  async function execute(input: ManagedCommandInput): Promise<ManagedCommandResult> {
    if (!input.execution) throw Error("native_admission_required");
    fence(); input.execution.assertActive();
    let plan = journal.get<PlanRecord>("plan", input.id);
    if (!plan) {
      const items = NativeWorkPlanSchema.parse(await options.planner.plan(input));
      for (const item of items) if (item.requestId !== input.execution.requestId || item.contextId !== input.execution.contextId || item.generation !== input.execution.generation) throw Error("native_plan_ownership_mismatch");
      plan = { id: input.id, inputKey: inputKey(input), items, source: input.source, userId: input.userId };
      fence(); journal.put("plan", input.id, plan);
    } else if (plan.inputKey !== inputKey(input) || plan.source !== input.source || plan.userId !== input.userId) throw Error("native_plan_origin_mismatch");
    for (const item of plan.items) admission.enqueue(item);
    pump();
    for (;;) {
      const all = attempts().filter(a => a.item.requestId === input.execution!.requestId && a.item.contextId === input.execution!.contextId);
      const unresolved = all.some(a => a.state !== "settled");
      if (!unresolved && all.length) {
        const results = all.map(a => projectJob(a.item));
        return { text: results.map(j => j.result?.summary ?? j.state).join("\n"), state: all.every(a => a.outcome === "succeeded") ? "completed" : "failed", jobIds: all.flatMap(a => a.receipt ? [a.receipt.taskId] : []) };
      }
      if (closed || input.signal?.aborted || all.some(a => ["unknown", "release_unknown", "transferred"].includes(a.state))) return { text: "Orca 작업 상태 확인 필요. 기존 시도를 자동 재실행하지 않습니다.", state: "recovery_required" };
      // Failed dependencies terminate aggregation without claiming or launching their descendants.
      if (all.some(a => a.state === "settled" && a.outcome !== "succeeded") && all.every(a => ["settled", "queued"].includes(a.state))) return { text: "선행 Orca 작업 실패로 후속 작업이 대기합니다.", state: "failed" };
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
  }
  return {
    execute(input: ManagedCommandInput) {
      if (executionKeys.has(input.id) && executionKeys.get(input.id) !== inputKey(input)) return Promise.reject(Error("native_plan_origin_mismatch"));
      executionKeys.set(input.id, inputKey(input));
      const existing = executions.get(input.id); if (existing) return existing;
      const work = execute(input); executions.set(input.id, work); return work;
    },
    processDelivery,
    getJob(id: string): CommandJob | undefined { const a = attempts().find(a => a.receipt?.taskId === id || a.item.attemptId === id); return a ? projectJob(a.item) : undefined; },
    listJobs(): CommandJob[] { return attempts().map(a => projectJob(a.item)); },
    pendingQuestions(): QuestionRecord[] { return journal.list<QuestionRecord>("question").filter(q => !q.answered); },
    quarantined(): NativeQuarantineRecord[] { return journal.list<NativeQuarantineRecord>("quarantine"); },
    async stop(jobId: string): Promise<ManagedCommandResult> {
      fence();
      const a = attempts().find(a => a.receipt?.taskId === jobId);
      if (!a?.receipt || !current(a.item) || !relay.stopNative) throw Error("native_stop_unavailable");
      if (a.state === "settled") return { text: projectJob(a.item).state, jobId };
      journal.put("stop", a.item.attemptId, { phase: "received", receipt: a.receipt });
      if (!await relay.stopNative(a.receipt)) {
        admission.markUnknown(a.item.attemptId);
        return { text: "Orca 중지 결과 확인 필요", state: "recovery_required", jobId };
      }
      fence();
      admission.beginRelease(a.item.attemptId, a.receipt.dispatchId);
      const cleanup = await relay.cleanupNative(a.receipt, "release");
      fence();
      admission.settle(a.item.attemptId, a.receipt.dispatchId, "stopped", cleanup.verdict);
      journal.put("stop", a.item.attemptId, { phase: cleanup.verdict === "released" ? "applied" : "cleanup_pending", receipt: a.receipt, recovery: cleanup.recovery });
      reconcileResults();
      return { text: cleanup.verdict === "released" ? "Orca 작업을 중지했습니다." : "Orca 중지 후 자원 정리 확인 필요", state: cleanup.verdict === "released" ? "completed" : "recovery_required", jobId };
    },
    async guidance(jobId: string, text: string, id: string): Promise<ManagedCommandResult> {
      fence();
      const a = attempts().find(a => a.receipt?.taskId === jobId);
      if (!a?.receipt || a.state !== "active" || !current(a.item)) throw Error("native_guidance_requires_active_worker");
      const previous = journal.get<{ text: string; dispatchId: string; delivered?: boolean }>("guidance", id);
      if (previous && (previous.text !== text || previous.dispatchId !== a.receipt.dispatchId)) throw Error("native_guidance_collision");
      if (!previous?.delivered) {
        journal.put("guidance", id, { text, dispatchId: a.receipt.dispatchId });
        const sent = await relay.sendNativeGuidance(a.receipt, text, id);
        fence(); journal.put("guidance", id, { text, dispatchId: a.receipt.dispatchId, delivered: true, messageId: sent.messageId });
      }
      return { text: "Orca 작업자 받은편지함에 지시를 저장했습니다. 읽음/처리는 아직 확인되지 않았습니다.", jobId };
    },
    async answerQuestion(messageId: string, text: string, id: string) {
      fence();
      const q = journal.get<QuestionRecord>("question", messageId);
      const a = q && attempts().find(a => a.item.attemptId === q.attemptId);
      if (!q || !a?.receipt || !current(a.item)) throw Error("native_question_not_current");
      if (q.answered) { if (q.answer !== text) throw Error("native_answer_collision"); return; }
      if (q.answer !== undefined && q.answer !== text) throw Error("native_answer_collision");
      journal.put("question", messageId, { ...q, answer: text });
      await relay.replyNativeQuestion(a.receipt, messageId, text, key("answer", messageId));
      fence(); journal.put("question", messageId, { ...q, answered: true, answer: text });
    },
    async start() {
      if (started) return; fence();
      for (const a of attempts()) {
        if (["queued", "settled"].includes(a.state)) continue;
        // A journaled claim without effects is still uncertain, never a license to relaunch.
        let receipt: NativeWorkerReceipt | undefined;
        try { const launch = relay.getNativeLaunch(a.item.attemptId); if (launch.receipt) { bind(a.item, launch.receipt); receipt = launch.receipt; } }
        catch { /* Occupancy is retained even if the relay journal is unavailable. */ }
        // A bound receipt only proves the launch happened. Guidance and followups come back only for
        // an exact, live observation of that one owned Dispatch; every weaker case stays `unknown`,
        // which keeps the slot occupied instead of releasing ambiguous capacity.
        let live = false;
        if (receipt && relay.observeNativeWorker) {
          try { live = (await relay.observeNativeWorker(receipt)).live === true; }
          catch { live = false; }
        }
        if (live) admission.reconcile(a.item.attemptId, { state: "active", dispatchId: receipt!.dispatchId });
        else {
          admission.reconcile(a.item.attemptId, { state: "unknown" });
          if (receipt) emit(a.item, "worker.recovery_required", receipt);
        }
      }
      admission.finishReconciliation();
      for (const plan of journal.list<PlanRecord>("plan")) for (const item of plan.items) if (current(item)) admission.enqueue(item);
      started = true;
      timer = setInterval(() => {
        if (tickWork) return;
        tickWork = tick().catch(() => {}).finally(() => { tickWork = undefined; });
      }, options.pollMs ?? 1000); timer.unref();
      pump();
    },
    async close() {
      if (closed) return;
      closed = true; clearInterval(leaseTimer); if (timer) clearInterval(timer);
      await Promise.allSettled([...launching.values(), deliveries, ...(tickWork ? [tickWork] : []), ...executions.values()]);
      admission.close();
    }
  };
}
