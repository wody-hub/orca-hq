import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { OperationsApiError, type OperationsApi, type OperationsMutationReceipt } from "../api.js";
import { mutationIdentity, type OperationsMutationRegistry } from "../operations-state.js";

export function ReviewedMutation({ mutations, mutationKey, label, title, review, disabled = false, execute, onConflict }: Readonly<{
  api: OperationsApi;
  mutations: OperationsMutationRegistry;
  mutationKey: string;
  label: string;
  title: string;
  review: ReactNode;
  disabled?: boolean;
  execute(requestId: string): Promise<OperationsMutationReceipt>;
  onConflict?: () => void;
}>) {
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [capacityBlocked, setCapacityBlocked] = useState(false);
  const entry = useSyncExternalStore(mutations.subscribe, () => mutations.get(mutationKey));
  const receipt = entry?.receipt;
  const submitting = entry?.state === "pending";
  const close = () => { setOpen(false); queueMicrotask(() => trigger.current?.focus()); };
  useEffect(() => () => mutations.clearResolved(mutationKey), [mutations, mutationKey]);
  useEffect(() => {
    if (!open) return;
    confirm.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) { event.preventDefault(); close(); }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [open, submitting]);
  const submit = async () => {
    const reserved = mutations.reserve(mutationKey);
    if (submitting || receipt || !reserved) return;
    mutations.pending(mutationKey);
    try {
      const next = await execute(reserved.requestId);
      mutations.settle(mutationKey, next);
      if (next.state === "rejected") onConflict?.();
    } catch (error) {
      const rejected = error instanceof OperationsApiError && error.status === 409;
      mutations.settle(mutationKey, { requestId: reserved.requestId, action: "unconfirmed", targetId: mutationKey, state: rejected ? "rejected" : "unknown", observedAt: new Date().toISOString(), detail: error instanceof OperationsApiError ? error.code : "network_error" });
      if (rejected) onConflict?.();
    } finally { setOpen(false); }
  };
  return <div className="reviewed-mutation">
    <button ref={trigger} type="button" disabled={disabled || submitting || !!receipt} onClick={() => { const reserved = mutations.reserve(mutationKey); if (!reserved) setCapacityBlocked(true); else { setCapacityBlocked(false); setOpen(true); } }}>{label}</button>
    {receipt?.state === "accepted" ? <p className="mutation-result accepted" role="status">접수되었지만 완료된 것은 아닙니다. 이후 권위 있는 상태 관찰로 완료를 확인하세요.</p> : null}
    {receipt?.state === "rejected" ? <p className="mutation-result rejected" role="status">현재 증거와 충돌해 실행되지 않았습니다. 새로 읽은 상태를 확인하세요.</p> : null}
    {receipt?.state === "unknown" ? <p className="mutation-result unknown" role="alert">결과를 확인할 수 없습니다. inspect-only로 상태를 확인하고 이 요청을 자동 재시도하지 마세요.</p> : null}
    {submitting ? <p className="mutation-result unknown" role="status">결과를 기다리는 중입니다. 화면을 이동해도 같은 요청 ID가 보호됩니다.</p> : null}
    {capacityBlocked ? <p className="mutation-result unknown" role="alert">해결되지 않은 요청이 너무 많아 이 세션에서 새 제어를 시작할 수 없습니다.</p> : null}
    {entry ? <small className="mono">request {entry.requestId}</small> : null}
    {open ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) close(); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2><div className="review-copy">{review}</div><dl className="kv compact"><dt>request ID</dt><dd className="mono">{entry?.requestId}</dd></dl><p className="muted">접수 응답은 작업 완료를 뜻하지 않습니다.</p>
      <div className="modal-actions"><button type="button" onClick={close} disabled={submitting}>취소</button><button ref={confirm} type="button" className="primary" onClick={() => void submit()} disabled={submitting}>{submitting ? "제출 중" : "확인 후 제출"}</button></div>
    </section></div> : null}
  </div>;
}

export function OperationsCompose({ api, mutations }: Readonly<{ api: OperationsApi; mutations: OperationsMutationRegistry }>) {
  const [mode, setMode] = useState<"new" | "continue">("new");
  const [sessionId, setSessionId] = useState("");
  const [contextId, setContextId] = useState("");
  const [text, setText] = useState("");
  const [taskId, setTaskId] = useState("");
  const [runId, setRunId] = useState("");
  const [terminalHandle, setTerminalHandle] = useState("");
  const [incarnation, setIncarnation] = useState("");
  const [inject, setInject] = useState(false);
  const hqValid = sessionId.trim().length > 0 && sessionId.length <= 100 && text.trim().length > 0 && text.length <= 8000 && (mode === "new" || contextId.trim().length > 0);
  const dispatchValid = [taskId, runId, terminalHandle, incarnation].every((value) => value.trim().length > 0 && value.length <= 512);
  return <><div className="view-head"><h1>새 지시</h1><p>입력 전체와 고정 요청 ID를 검토한 뒤 실제 HQ 또는 Orca 제어 경로로 제출합니다.</p></div><div className="grid-2 controls-grid">
    <section className="card card-body"><h2>HQ 지시</h2><label>문맥 방식<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="new">새 문맥</option><option value="continue">기존 문맥 계속</option></select></label><label>세션 ID<input value={sessionId} maxLength={100} onChange={(event) => setSessionId(event.target.value)} /></label>{mode === "continue" ? <label>문맥 ID<input value={contextId} maxLength={100} onChange={(event) => setContextId(event.target.value)} /></label> : null}<label>지시 내용<textarea value={text} maxLength={8000} rows={10} onChange={(event) => setText(event.target.value)} /></label><small>{text.length} / 8000</small>
      <ReviewedMutation api={api} mutations={mutations} mutationKey={mutationIdentity("hq_request", mode === "continue" ? contextId : sessionId)} label="제출 전 검토" title="HQ 지시 검토" disabled={!hqValid} review={<><p className="review-text">{text}</p><dl className="kv compact"><dt>session</dt><dd className="mono">{sessionId}</dd><dt>mode</dt><dd>{mode}</dd>{mode === "continue" ? <><dt>context</dt><dd className="mono">{contextId}</dd></> : null}</dl></>} execute={(requestId) => api.mutate("/api/operations/hq/requests", { requestId, sessionId, text, contextHint: mode === "new" ? { mode: "new" } : { mode: "continue", contextId } }, requestId)} />
    </section>
    <section className="card card-body"><h2>Orca Task dispatch</h2><p className="muted">서버가 현재 Run 소유권, Task 생성 provenance, 대상 PTY incarnation을 다시 확인합니다. 이 저수준 dispatch는 worker-start supervision이나 resource ownership을 만들지 않는 unsupervised 작업입니다.</p><label>Task ID<input value={taskId} maxLength={512} onChange={(event) => setTaskId(event.target.value)} /></label><label>Run ID<input value={runId} maxLength={512} onChange={(event) => setRunId(event.target.value)} /></label><label>Terminal handle<input value={terminalHandle} maxLength={512} onChange={(event) => setTerminalHandle(event.target.value)} /></label><label>Expected incarnation<input value={incarnation} maxLength={512} onChange={(event) => setIncarnation(event.target.value)} /></label><label><input type="checkbox" checked={inject} onChange={(event) => setInject(event.target.checked)} />기존 terminal agent에 inject</label>
      <ReviewedMutation api={api} mutations={mutations} mutationKey={mutationIdentity("dispatch", taskId)} label="dispatch 검토" title="Orca dispatch 검토" disabled={!dispatchValid} review={<><p className="muted">unsupervised 저수준 dispatch이며 terminal 전달 외의 resource 소유권을 증명하지 않습니다.</p><dl className="kv compact"><dt>task</dt><dd className="mono">{taskId}</dd><dt>run</dt><dd className="mono">{runId}</dd><dt>terminal</dt><dd className="mono">{terminalHandle}</dd><dt>incarnation</dt><dd className="mono">{incarnation}</dd><dt>inject</dt><dd>{String(inject)}</dd></dl></>} execute={(requestId) => api.mutate("/api/operations/orca/dispatches", { taskId, runId, terminalHandle, expectedIncarnation: incarnation, inject }, requestId)} />
    </section>
  </div></>;
}
