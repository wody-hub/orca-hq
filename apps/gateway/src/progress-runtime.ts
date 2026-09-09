import { createHash, randomUUID } from "node:crypto";
import type {
  SubmitProgressRequest,
  ProgressEventKind,
  ResourceAccess,
} from "@orca-hq/core";
import type {
  ProgressStore,
  AppendProgressEvent,
  AssignRequestContext,
  CompleteProgressRequest,
  AssignmentOutcome,
  RequestContextAssignment,
} from "./progress-store.js";
import type { ExecutionReservations } from "./execution-reservations.js";
import {
  createContextExecutor,
  type ExecutionControl,
} from "./context-executor.js";
import type {
  createContextRouter,
  RoutingRequest,
  RoutingDecision,
} from "./context-router.js";
import type {
  ManagedCommandInput,
  ManagedCommandResult,
  CommandJob,
  CommandProject,
} from "./managed-commands.js";
import {
  nativeContextState,
  nativeProgress,
  publicProgressText,
  toolProgress,
} from "./progress-events.js";
import type {
  ProgressHttpPort,
  ProgressSubmission,
} from "./progress-control.js";

export interface ProgressRuntimeOptions {
  store: ProgressStore;
  reservations: ExecutionReservations;
  router: ReturnType<typeof createContextRouter>;
  execute(input: ManagedCommandInput): Promise<ManagedCommandResult>;
  getJob(id: string): CommandJob | undefined | Promise<CommandJob | undefined>;
  catalog: { list(): Promise<CommandProject[]> };
  controlJob?: (
    action: "status" | "stop" | "guidance",
    jobId: string,
    requestId: string,
    text: string,
  ) => Promise<ManagedCommandResult>;
  readJobs?: (requestId: string) => Promise<ManagedCommandResult>;
  hasLegacyConflict?: (resources: readonly ResourceAccess[]) => boolean;
  maxContexts?: number;
  pollMs?: number;
}
const terminal = (job: CommandJob) =>
  ["succeeded", "failed", "stopped"].includes(job.state);
const stable = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export function createProgressRuntime(options: ProgressRuntimeOptions) {
  const store = options.store;
  const executor = createContextExecutor({
    ...(options.maxContexts === undefined
      ? {}
      : { maxContexts: options.maxContexts }),
  });
  const agentId = "hq-context-agent";
  const claimantId = "router-" + randomUUID();
  const pending = new Set<Promise<unknown>>();
  const jobLinks = new Map<string, { contextId: string; requestId: string }>();
  const turns = new Set<string>();
  const cancellations = new Map<string, AbortController>();
  let stopping = false,
    started = false,
    routing = 0,
    generation = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  function maintainCompletedDetail() {
    if (stopping) return;
    try {
      // One bounded SQLite batch per pass; do not drain a backlog on the execution path.
      store.pruneCompletedEvents(
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      );
    } catch {
      // Storage failures must neither fail an execution nor expose raw storage diagnostics.
      try {
        console.warn(
          "[hq-progress] Completed detail retention failed; maintenance will retry next hour.",
        );
      } catch {
        /* Diagnostic delivery is best effort too. */
      }
    }
  }
  const track = (work: Promise<unknown>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
  };
  function complete(input: CompleteProgressRequest) {
    return store.completeRequest(input);
  }
  function assign(input: AssignRequestContext) {
    store.assignRequestContext(input);
    const context = store.getContext(input.contextId)!;
    append({
      requestId: input.requestId,
      contextId: input.contextId,
      eventKey: stable("assigned", input.requestId, input.partId),
      kind: "context.assigned",
      source: "hq",
      payload: {
        contextId: input.contextId,
        title: context.title,
        relation: input.relation,
        text:
          (input.relation === "new" ? "새 작업: " : "이어서 진행: ") +
          context.title,
      },
    });
  }
  function append(event: AppendProgressEvent) {
    const payload = { ...event.payload };
    if (
      typeof payload.text === "string" &&
      Buffer.byteLength(JSON.stringify(payload)) > 8000
    ) {
      const points = Array.from(payload.text);
      let low = 0,
        high = points.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (
          Buffer.byteLength(
            JSON.stringify({
              ...payload,
              text: points.slice(0, mid).join("") + "…",
            }),
          ) <= 8000
        )
          low = mid;
        else high = mid - 1;
      }
      payload.text = points.slice(0, low).join("") + "…";
    }
    return store.appendEvent({ ...event, payload });
  }
  function safeAppend(event: AppendProgressEvent) {
    try {
      append(event);
    } catch {
      /* Observation failure must never replay or fail an external effect. */
    }
  }
  const contextJobs = async (contextId: string) => {
    const context = store.getContext(contextId);
    return (
      await Promise.all(
        (context?.jobIds ?? []).map((id) =>
          Promise.resolve(options.getJob(id)).catch(() => undefined),
        ),
      )
    ).filter((j): j is CommandJob => j !== undefined);
  };
  function reservationIdentity(
    r: ReturnType<ProgressStore["listExecutionReservations"]>[number],
  ) {
    return {
      reservationId: r.reservationId,
      contextId: r.contextId,
      requestId: r.requestId,
      generation: r.generation,
    };
  }
  function releaseReservation(
    identity: {
      reservationId: string;
      contextId: string;
      requestId: string;
      generation: number;
    },
    jobs: CommandJob[] = [],
  ): boolean {
    const held = store
      .listExecutionReservations(identity.contextId)
      .filter(
        (r) =>
          r.reservationId === identity.reservationId && r.state !== "released",
      );
    if (!held.length) return true;
    const dispatchId = held.find((r) => r.nativeDispatchId)?.nativeDispatchId;
    const proof = dispatchId
      ? jobs.find((job) => job.dispatchId === dispatchId && terminal(job))
      : undefined;
    if (dispatchId && !proof) {
      options.reservations.retainForRecovery(identity);
      return false;
    }
    options.reservations.release({
      ...identity,
      ...(proof
        ? {
            nativeCompletion: {
              dispatchId: proof.dispatchId!,
              state: proof.state as "succeeded" | "failed" | "stopped",
            },
          }
        : {}),
    });
    return true;
  }
  async function notify(job: CommandJob) {
    if (
      job.execution &&
      (store.getContextAgent(job.execution.contextId)?.generation ?? 0) >
        job.execution.generation
    )
      return;
    let link =
      job.execution && store.getContext(job.execution.contextId)
        ? {
            contextId: job.execution.contextId,
            requestId: job.execution.requestId,
          }
        : jobLinks.get(job.id);
    if (!link) {
      const context = store
        .listContexts()
        .find((c) => c.jobIds.includes(job.id));
      if (!context) return;
      const candidates = store
        .listContextJobs(context.contextId)
        .filter((link) => link.jobId === job.id);
      const persisted =
        candidates.find(
          (link) => job.dispatchId && link.dispatchId === job.dispatchId,
        ) ?? candidates.at(-1);
      if (!persisted) return;
      link = { contextId: context.contextId, requestId: persisted.requestId };
      jobLinks.set(job.id, link);
    }
    const reservations = store
      .listExecutionReservations(link.contextId)
      .filter((r) => r.state !== "released" && r.requestId === link!.requestId);
    const native = job as CommandJob & { dispatchId?: string };
    if (native.dispatchId) {
      const prior = store
        .listContextJobs(link.contextId)
        .filter((item) => item.jobId === job.id)
        .at(-1);
      if (prior?.dispatchId && prior.dispatchId !== native.dispatchId && prior.requestId === link.requestId) {
        // A task-level observation is not proof that a different attempt belongs to this request.
        for (const r of reservations)
          options.reservations.retainForRecovery(reservationIdentity(r));
        if (!terminal(job)) executor.restoreNative(link.contextId, job.id);
        store.updateContext({ contextId: link.contextId, state: "recovery_required" });
        return;
      }
      if (!prior || prior.requestId === link.requestId)
        store.linkContextJob({
          contextId: link.contextId,
          requestId: link.requestId,
          jobId: job.id,
          dispatchId: native.dispatchId,
        });
      else if (job.execution?.requestId === link.requestId)
        store.rebindContextJob({
          contextId: link.contextId,
          requestId: link.requestId,
          jobId: job.id,
          dispatchId: native.dispatchId,
        });
      for (const r of reservations)
        if (!r.nativeDispatchId) {
          try {
            options.reservations.linkNativeDispatch({
              ...reservationIdentity(r),
              nativeDispatchId: native.dispatchId,
            });
          } catch {
            /* Retain ambiguous linkage. */
          }
        }
    }
    safeAppend({
      ...nativeProgress(job),
      requestId: link.requestId,
      contextId: link.contextId,
    });
    if (job.state === "recovery_required") {
      for (const r of reservations)
        options.reservations.retainForRecovery(reservationIdentity(r));
    }
    const jobs = await contextJobs(link.contextId);
    const current = store.getContext(link.contextId)!;
    const allKnown = current.jobIds.every((id) =>
      jobs.some((j) => j.id === id),
    );
    if (terminal(job) && allKnown && jobs.every(terminal)) {
      const released = reservations
        .map((r) => releaseReservation(reservationIdentity(r), jobs))
        .every(Boolean);
      if (!released) {
        store.updateContext({
          contextId: link.contextId,
          state: "recovery_required",
        });
        return;
      }
      executor.observeNative(link.contextId, job.id, job.state);
      executor.observeNative(
        link.contextId,
        "unknown:" + link.requestId,
        job.state,
      );
    } else if (!terminal(job)) executor.restoreNative(link.contextId, job.id);
    store.updateContext({
      contextId: link.contextId,
      state: allKnown
        ? nativeContextState(jobs, turns.has(link.contextId))
        : "recovery_required",
    });
  }
  async function executePart(
    request: SubmitProgressRequest,
    partId: string,
    contextId: string,
    instruction: string,
    relation: "new" | "continue",
    control: ExecutionControl,
  ): Promise<ManagedCommandResult> {
    const currentGeneration = (generation = Math.max(
      generation + 1,
      (store.getContextAgent(contextId)?.generation ?? 0) + 1,
    ));
    const reservationId = "res_" + stable(contextId, request.requestId, partId);
    const cancellation = new AbortController();
    cancellations.set(contextId, cancellation);
    const identity = {
      reservationId,
      contextId,
      requestId: request.requestId,
      generation: currentGeneration,
    };
    let reserved = false,
      nativeAttempt = false,
      observation = 0,
      waitReason = "";
    const scope = {
      requestId: request.requestId,
      contextId,
      agentId,
      generation: currentGeneration,
    };
    const emit = (
      kind: ProgressEventKind,
      payload: Record<string, string | number>,
      key?: string,
    ) =>
      safeAppend({
        ...scope,
        eventKey:
          key ??
          stable(
            "agent",
            contextId,
            request.requestId,
            partId,
            String(++observation),
          ),
        kind,
        source: "hq",
        payload,
      });
    const active = () => {
      if (cancellation.signal.aborted)
        throw new Error("context_turn_cancelled");
      control.assertActive();
      store.assertExecutionGeneration(contextId, currentGeneration);
    };
    store.setContextAgent({
      contextId,
      agentId,
      state: "running",
      generation: currentGeneration,
      currentRequestId: request.requestId,
    });
    store.updateRequest({ requestId: request.requestId, state: "executing" });
    store.updateContext({ contextId, state: "running" });
    turns.add(contextId);
    emit(relation === "new" ? "agent.started" : "agent.resumed", {
      text:
        relation === "new" ? "업무 에이전트 시작" : "업무 에이전트 이어서 진행",
    });
    const reserve = async (
      resources: ResourceAccess[],
      signal?: AbortSignal,
    ) => {
      active();
      if (reserved) throw new Error("전체 실행 자원을 한 번에 선언해주세요.");
      for (;;) {
        if (signal?.aborted) throw new Error("context_turn_cancelled");
        active();
        if (options.hasLegacyConflict?.(resources)) {
          if (waitReason !== "legacy") {
            emit("agent.waiting", {
              text: "기존 채널의 Orca 작업 완료 대기",
              reason: "legacy",
            });
            waitReason = "legacy";
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const claim = options.reservations.claim({
          ...identity,
          agentId,
          resources,
        });
        if (claim.acquired) {
          reserved = true;
          break;
        }
        if (waitReason !== "resources") {
          emit("agent.waiting", {
            text: "다른 작업의 자원 사용 완료 대기",
            reason: "resources",
          });
          waitReason = "resources";
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    };
    try {
      let result = await options.execute({
        signal: cancellation.signal,
        id: request.requestId + "-" + partId,
        text: instruction,
        source: "terminal",
        userId: "local",
        sessionId: request.sessionId,
        conversationId: "context:" + contextId,
        onThread: (threadId) => store.updateContext({ contextId, threadId }),
        onProgress: async (text) =>
          emit("hq.progress", { text: publicProgressText(text) }),
        onToolEvent(name, phase, callId) {
          const event = toolProgress(name, phase, callId);
          safeAppend({
            ...scope,
            ...event,
            eventKey: stable(
              "tool",
              contextId,
              request.requestId,
              partId,
              callId,
              phase,
            ),
          });
        },
        execution: {
          contextId,
          requestId: request.requestId,
          generation: currentGeneration,
          assertActive: active,
          reserve,
          async beforeNative(jobId) {
            active();
            const context = store.getContext(contextId)!;
            if (jobId && !context.jobIds.includes(jobId))
              throw new Error("context_job_not_owned");
            const jobs = await contextJobs(contextId);
            if (jobs.some((j) => !terminal(j)))
              throw new Error("context_native_worker_limit");
            if (context.jobIds.some((id) => !jobs.some((j) => j.id === id)))
              throw new Error("native_ownership_unknown");
            if (jobId) {
              const job = jobs.find((j) => j.id === jobId)!;
              if (!job.worktreePath) throw new Error("native_checkout_unknown");
              const links = store.listContextJobs(contextId).filter(link =>
                link.jobId === jobId && job.dispatchId && link.dispatchId === job.dispatchId,
              );
              const provenance = store.listExecutionReservations(contextId).filter(r =>
                job.dispatchId && r.nativeDispatchId === job.dispatchId &&
                links.some(link => link.requestId === r.requestId) &&
                (!job.execution || (
                  job.execution.contextId === r.contextId &&
                  job.execution.requestId === r.requestId &&
                  job.execution.generation === r.generation
                )),
              );
              if (links.length !== 1 || !provenance.length ||
                new Set(provenance.map(r => r.reservationId)).size !== 1) {
                throw new Error("native_resource_provenance_unknown");
              }
              // Released rows are durable attempt provenance, including every secondary/external target.
              await reserve(provenance.map(r => ({ resourceKey: r.resourceKey, mode: r.mode })));
            }
          },
          markNativeAttempt() {
            active();
            nativeAttempt = true;
          },
          async onNative(jobId) {
            nativeAttempt = true;
            control.retainNative(jobId);
            jobLinks.set(jobId, { contextId, requestId: request.requestId });
            if (
              !store
                .listContextJobs(contextId)
                .some((link) => link.jobId === jobId)
            )
              store.linkContextJob({
                contextId,
                requestId: request.requestId,
                jobId,
              });
            emit(
              "job.linked",
              { jobId, text: "Orca 작업 접수" },
              stable("job-linked", contextId, request.requestId, jobId),
            );
            const job = await options.getJob(jobId);
            if (job) await notify(job);
          },
        },
      });
      if (cancellation.signal.aborted)
        result = {
          ...result,
          text: "사용자 요청으로 업무 에이전트를 중지했습니다.",
          state: "failed",
        };
      // Results can include read-only jobs.show; only the mutation callback owns a native slot.
      store.updateContext({
        contextId,
        summary: publicProgressText(result.text),
      });
      const jobs = await contextJobs(contextId);
      if (
        nativeAttempt &&
        !store
          .getContext(contextId)!
          .jobIds.some(
            (id) => jobLinks.get(id)?.requestId === request.requestId,
          )
      ) {
        if (reserved) options.reservations.retainForRecovery(identity);
        executor.restoreNative(contextId, "unknown:" + request.requestId);
        store.updateContext({ contextId, state: "recovery_required" });
      } else {
        if (reserved && jobs.every(terminal))
          releaseReservation(identity, jobs);
        store.updateContext({
          contextId,
          state: jobs.some((job) => !terminal(job))
            ? nativeContextState(jobs)
            : result.state === "failed" || result.state === "recovery_required"
              ? result.state
              : nativeContextState(jobs),
        });
      }
      if (store.getContext(contextId)!.state === "recovery_required" ||
        store.listExecutionReservations(contextId).some(r =>
          r.requestId === request.requestId && r.state === "recovery_required",
        )) {
        result = { ...result, state: "recovery_required" };
        store.updateContext({ contextId, state: "recovery_required" });
      }
      store.setContextAgent({
        contextId,
        agentId,
        state: result.state ?? store.getContext(contextId)!.state,
        generation: currentGeneration,
        currentRequestId: request.requestId,
      });
      return result;
    } catch (error) {
      if (reserved && nativeAttempt) {
        options.reservations.retainForRecovery(identity);
        executor.restoreNative(contextId, "unknown:" + request.requestId);
      } else if (reserved) releaseReservation(identity);
      store.updateContext({
        contextId,
        state: nativeAttempt || (error instanceof Error && error.message === "native_resource_provenance_unknown")
          ? "recovery_required" : "failed",
      });
      throw error;
    } finally {
      turns.delete(contextId);
      cancellations.delete(contextId);
    }
  }
  async function classify(requestId: string) {
    const request = store.getRequestInput(requestId);
    if (!request) throw new Error("request_not_found");
    try {
      const contexts = store.listContexts(request.sessionId);
      const explicit =
        request.contextHint?.mode === "continue"
          ? request.contextHint.contextId
          : request.text.match(/^\/context\s+(\S+)/u)?.[1];
      if (explicit && !contexts.some((c) => c.contextId === explicit)) {
        const other = store.getContext(explicit);
        if (other) contexts.unshift(other);
      }
      // Explicit native job IDs may refer to older contexts in the same owner namespace.
      for (const c of store.listContexts())
        if (
          c.jobIds.some((id) => request.text.split(/\s+/u).includes(id)) &&
          !contexts.some((known) => known.contextId === c.contextId)
        )
          contexts.push(c);
      const projects = (await options.catalog.list()).filter((p) => p.enabled);
      const pendingQuestions = store
        .readEvents({ sessionId: request.sessionId, after: 0, limit: 1000 })
        .events.filter(
          (e) =>
            e.kind === "clarification.required" &&
            store.getRequest(e.requestId)?.state === "awaiting_input",
        )
        .slice(-20)
        .map((e) => ({
          requestId: e.requestId,
          text: store.getRequestInput(e.requestId)?.text ?? "",
          question: String(e.payload.text ?? ""),
        }));
      const priorAssignments = store.listRequestAssignments(requestId);
      const decision: RoutingDecision = priorAssignments.length
        ? {
            parts: priorAssignments.map((part) => ({
              action: "continue" as const,
              contextId: part.contextId,
              text: part.instruction,
            })),
          }
        : await options.router.route(
            { ...request, pendingQuestions } as RoutingRequest,
            contexts,
            projects,
          );
      const answered = pendingQuestions.find(
        (q) => q.requestId === decision.answersRequestId,
      );
      const effectiveText = answered
        ? `이전 요청: ${answered.text}\n확인 질문: ${answered.question}\n현재 사용자 답변: ${request.text}`
        : request.text;
      if (decision.control) {
        const { contextId, action } = decision.control;
        const context = store.getContext(contextId)!;
        assign({
          requestId,
          partId: "control",
          contextId,
          relation: "continue",
          instruction: request.text,
        });
        if (action === "stop") cancellations.get(contextId)?.abort();
        const jobs = await contextJobs(contextId);
        const job = jobs.filter((j) => !terminal(j)).at(-1) ?? jobs.at(-1);
        let result: ManagedCommandResult = {
          text: context.summary || context.state,
        };
        if (action === "guidance" && (!job || terminal(job)))
          throw new Error("native_guidance_requires_active_worker");
        store.updateRequest({ requestId, state: "executing" });
        if (job && options.controlJob)
          result = await options.controlJob(
            action,
            job.id,
            requestId,
            request.text,
          );
        else if (action === "stop" && turns.has(contextId))
          result = { text: "업무 에이전트 중지를 요청했습니다." };
        else if (action !== "status")
          throw new Error("native_control_unavailable");
        store.completeAssignment({
          requestId,
          partId: "control",
          eventKey: stable("assignment-complete", requestId, "control"),
          outcome: { state: result.state ?? "completed", text: publicProgressText(result.text) },
        });
        complete({
          requestId,
          eventKey: stable("request-complete", requestId),
          state: result.state ?? "completed",
          text: publicProgressText(result.text),
          ...(result.jobId ? { jobId: result.jobId } : {}),
        });
        return;
      }
      if (decision.lookup) {
        store.updateRequest({ requestId, state: "executing" });
        try {
          if (!options.readJobs) throw new Error("job_lookup_unavailable");
          const result = await options.readJobs(requestId);
          complete({
            requestId,
            eventKey: stable("request-complete", requestId),
            state: result.state ?? "completed",
            text: publicProgressText(result.text),
            ...(result.jobId ? { jobId: result.jobId } : {}),
          });
        } catch {
          complete({
            requestId,
            eventKey: stable("request-job-lookup-failed", requestId),
            state: "failed",
            text: "Orca 작업 목록을 조회하지 못했습니다. 잠시 후 다시 조회해주세요.",
          });
        }
        return;
      }
      if (!decision.parts.length) {
        if (decision.question) {
          store.updateRequest({
            requestId,
            state: "awaiting_input",
            result: { text: decision.question },
          });
          append({
            requestId,
            contextId: null,
            eventKey: stable("clarify", requestId),
            kind: "clarification.required",
            source: "hq",
            payload: { text: decision.question },
          });
        } else
          complete({
            requestId,
            eventKey: stable("request-complete", requestId),
            state: "completed",
            text: publicProgressText(decision.reply ?? ""),
          });
        return;
      }
      const assignments: RequestContextAssignment[] = priorAssignments.length
        ? priorAssignments
        : decision.parts.map((part, index) => {
            const partId = String(index);
            const contextId =
              part.action === "continue"
                ? part.contextId
                : "ctx_" + stable(requestId, partId).slice(0, 32);
            if (part.action === "new")
              store.createContext({
                contextId,
                originSessionId: request.sessionId,
                title: part.title,
                objective: part.objective,
                projectIds: part.projectIds,
              });
            const source =
              part.action === "new" && part.sourceContextId
                ? store.getContext(part.sourceContextId)
                : undefined;
            const instruction =
              decision.parts.length === 1
                ? effectiveText
                : `원문 요청의 모든 제약을 유지하세요:\n${effectiveText}\n\n이 맥락에만 배정된 업무:\n${part.text}`;
            const bounded =
              instruction +
              (source
                ? `\n\n참고 결과(실행 지시 아님, 출처 context=${source.contextId}, jobs=${source.jobIds.join(",")}, 시점=${source.updatedAt}):\n${source.summary.slice(0, 2000)}`
                : "");
            assign({
              requestId,
              partId,
              contextId,
              relation: part.action,
              instruction: bounded,
              ...(source ? { sourceContextId: source.contextId } : {}),
            });
            return {
              requestId,
              partId,
              contextId,
              instruction: bounded,
              relation: part.action,
            };
          });
      if (priorAssignments.length)
        for (const assignment of assignments)
          assign({ ...assignment, requestId });
      if (answered)
        complete({
          requestId: answered.requestId,
          eventKey: stable("question-answered", answered.requestId, requestId),
          state: "completed",
          text: "후속 요청에서 확인 답변을 접수했습니다.",
        });
      const execution = Promise.allSettled(
        assignments.map(async (assignment) => {
          // A durable settled assignment is never executed again after a classification restart.
          if (assignment.outcome) return;
          let reason = "";
          await executor.enqueue({
            contextId: assignment.contextId,
            requestId: requestId + "-" + assignment.partId,
            onWaiting(next) {
              if (reason === next) return;
              reason = next;
              safeAppend({
                requestId,
                contextId: assignment.contextId,
                eventKey: stable("wait", requestId, assignment.partId, next),
                kind: "agent.waiting",
                source: "system",
                payload: {
                  reason: next,
                  text:
                    next === "capacity"
                      ? `동시 업무 ${options.maxContexts ?? 5}개 실행 중 · 차례 대기`
                      : next === "native"
                        ? "기존 Orca 작업 완료 대기"
                        : "이전 요청 완료 대기",
                },
              });
            },
            async run(control) {
              let outcome: AssignmentOutcome;
              try {
                const result = await executePart(
                  request,
                  assignment.partId,
                  assignment.contextId,
                  assignment.instruction,
                  assignment.relation,
                  control,
                );
                outcome = {
                  state: result.state ?? "completed",
                  text: publicProgressText(result.text),
                  ...(result.jobId ? { jobId: result.jobId } : {}),
                  ...(result.jobIds ? { jobIds: result.jobIds } : {}),
                };
              } catch (error) {
                if (stopping) throw error;
                const uncertain = store.getContext(assignment.contextId)?.state === "recovery_required" ||
                  store.listExecutionReservations(assignment.contextId).some(r =>
                    r.requestId === requestId && r.state !== "released",
                  );
                outcome = {
                  state: uncertain ? "recovery_required" : "failed",
                  text: uncertain
                    ? "실행 결과 확인이 필요합니다. 기존 작업은 자동 재실행하지 않습니다."
                    : "업무 실행에 실패했습니다. 자동 재실행하지 않았습니다.",
                };
                store.updateContext({ contextId: assignment.contextId, summary: outcome.text });
              }
              // Persist this part and its own viewer final before releasing its execution slot.
              store.completeAssignment({
                requestId,
                partId: assignment.partId,
                eventKey: stable("assignment-complete", requestId, assignment.partId),
                outcome,
              });
            },
          });
        }),
      );
      track(
        execution.then((settled) => {
          if (stopping) return;
          const persisted = store.listRequestAssignments(requestId);
          const results: AssignmentOutcome[] = assignments.map((assignment, index) => {
            const outcome = persisted.find(p => p.partId === assignment.partId)?.outcome;
            return settled[index]?.status === "fulfilled" && outcome ? outcome : {
              state: "recovery_required",
              text: "업무 결과 기록을 확인해야 합니다. 자동 재실행하지 않습니다.",
            };
          });
          const labels = { completed: "완료", failed: "실패", recovery_required: "결과 확인 필요" };
          const text = results.map((result, index) => assignments.length === 1
            ? result.text
            : `[${store.getContext(assignments[index]!.contextId)!.title} · ${labels[result.state]}]\n${result.text}`,
          ).join("\n\n");
          const jobId = results.flatMap(r => r.jobIds ?? (r.jobId ? [r.jobId] : [])).at(-1);
          complete({
            requestId,
            eventKey: stable("request-complete", requestId),
            state: results.some(r => r.state === "recovery_required") ? "recovery_required"
              : results.some(r => r.state === "failed") ? "failed" : "completed",
            text: publicProgressText(text),
            ...(jobId ? { jobId } : {}),
          });
        }).catch(() => {
          if (!stopping) complete({
            requestId,
            eventKey: stable("request-failed", requestId),
            state: "recovery_required",
            text: "실행 결과 확인이 필요합니다. 기존 작업은 자동 재실행하지 않습니다.",
          });
        }),
      );
    } catch {
      if (stopping) return;
      complete({
        requestId,
        eventKey: stable("request-failed", requestId),
        state: "recovery_required",
        text: "요청을 마무리하지 못했습니다. 기존 작업 상태를 확인한 뒤 이어서 지시해주세요. 자동 재실행하지 않았습니다.",
      });
    }
  }
  function drain() {
    if (!started || stopping) return;
    while (routing < 4) {
      const claimed = store.claimNextRequest(claimantId);
      if (!claimed) break;
      routing++;
      const work = classify(claimed.request.requestId).finally(() => {
        routing--;
        drain();
      });
      track(work);
    }
  }
  const http: ProgressHttpPort = {
    submit(input: ProgressSubmission) {
      const normalized: SubmitProgressRequest = {
        requestId: input.requestId,
        sessionId: input.sessionId,
        text: input.text,
        ...(input.contextHint
          ? {
              contextHint:
                input.contextHint.mode === "new"
                  ? { mode: "new" as const }
                  : {
                      mode: "continue" as const,
                      contextId: input.contextHint.contextId ?? "",
                    },
            }
          : {}),
      };
      const receipt = store.acceptRequest(normalized);
      setImmediate(drain);
      return receipt;
    },
    request: (id) => store.getRequest(id),
    contexts: (sessionId) => store.listContexts(sessionId),
    context: (id) => store.getContext(id),
    events(filter) {
      const page = store.readEvents({ ...filter, limit: 1000 });
      return {
        events: page.events,
        ...(page.compacted
          ? {
              compacted: {
                kind: "history.compacted",
                occurredAt: new Date().toISOString(),
                oldestSeq: page.oldestSeq,
                latestSeq: page.latestSeq,
                snapshots: page.snapshots,
              },
            }
          : {}),
      };
    },
    viewer(action, contextId, input) {
      if (action === "acquire")
        return store.acquireViewerLease({
          contextId,
          viewerInstanceId: input.viewerInstanceId,
        });
      const mutation = {
        contextId,
        viewerInstanceId: input.viewerInstanceId,
        leaseToken: input.leaseToken ?? "",
      };
      return action === "heartbeat"
        ? store.heartbeatViewerLease(mutation)
        : store.releaseViewerLease(mutation);
    },
  };
  return {
    ...http,
    executor,
    async executeLegacy(
      input: ManagedCommandInput,
    ): Promise<ManagedCommandResult> {
      const requestId =
        "legacy_" + stable(input.source, input.userId, input.id);
      const sessionId =
        "session_" +
        stable(
          input.source,
          input.userId,
          input.conversationId ?? input.sessionId ?? "default",
        );
      http.submit({ requestId, sessionId, text: input.text });
      let cursor = 0;
      for (;;) {
        if (stopping) throw new Error("progress_runtime_closed");
        const result = store.getRequest(requestId)!;
        if (input.onProgress) {
          for (const event of store.readEvents({
            sessionId,
            after: cursor,
            limit: 1000,
          }).events) {
            cursor = event.seq;
            if (
              event.requestId === requestId &&
              event.kind === "hq.progress" &&
              typeof event.payload.text === "string"
            )
              try {
                await input.onProgress(event.payload.text);
              } catch {
                /* Channel progress is optional. */
              }
          }
        }
        if (
          [
            "completed",
            "failed",
            "recovery_required",
            "awaiting_input",
          ].includes(result.state)
        )
          return {
            text: result.result?.text ?? "입력 확인이 필요합니다.",
            ...(result.result?.jobId ? { jobId: result.result.jobId } : {}),
            ...(result.state === "failed" ||
            result.state === "recovery_required"
              ? { state: result.state }
              : {}),
          };
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    },
    async start() {
      if (started) return;
      store.recoverInterruptedRequests({ requeueClassifying: true });
      for (const context of store.listContexts())
        for (const jobId of context.jobIds) {
          const job = await Promise.resolve(options.getJob(jobId)).catch(
            () => undefined,
          );
          if (!job || !terminal(job))
            executor.restoreNative(context.contextId, jobId);
          if (job) await notify(job);
        }
      for (const r of store.listExecutionReservations())
        if (r.state !== "released") {
          generation = Math.max(generation, r.generation);
          if (!store.getContext(r.contextId)?.jobIds.length) {
            options.reservations.retainForRecovery(reservationIdentity(r));
            executor.restoreNative(r.contextId, "unknown:" + r.requestId);
          }
        }
      started = true;
      maintainCompletedDetail();
      retentionTimer = setInterval(maintainCompletedDetail, 60 * 60 * 1000);
      retentionTimer.unref();
      timer = setInterval(() => {
        drain();
        for (const r of store.listExecutionReservations())
          if (r.state !== "released")
            try {
              options.reservations.heartbeat(reservationIdentity(r));
            } catch {
              /* Ownership remains reserved. */
            }
      }, options.pollMs ?? 1000);
      timer.unref();
      drain();
    },
    notify,
    async close() {
      stopping = true;
      started = false;
      if (timer) clearInterval(timer);
      if (retentionTimer) clearInterval(retentionTimer);
      for (const cancellation of cancellations.values()) cancellation.abort();
      await executor.close();
      await Promise.allSettled([...pending]);
    },
  };
}
