import { useEffect, useRef, useState } from "react";
import type { HqEventPage, OperationsApi, OrcaOutputPage } from "../api.js";
import { AsyncState, type LoadState } from "../components/async-state.js";
import { SourceBadge } from "../components/source-badge.js";
import { stateForError, useRead } from "../hooks.js";
import { ReviewedMutation } from "./operations-compose.js";
import { mutationIdentity, type OperationsMutationRegistry } from "../operations-state.js";

export function HqDetail({ api, contextId, navigate }: Readonly<{ api: OperationsApi; contextId: string; navigate: (path: string) => void }>) {
  const detail = useRead((signal) => api.context(contextId, signal), [api, contextId]);
  const [events, setEvents] = useState<HqEventPage["events"]>([]);
  const [eventState, setEventState] = useState<LoadState>("loading");
  const [compacted, setCompacted] = useState(false);
  const cursor = useRef("0");
  useEffect(() => {
    let stopped = false, timer: number | undefined, controller: AbortController | undefined, generation = 0;
    const poll = async (current: number) => {
      if (stopped || document.hidden || current !== generation) return;
      controller = new AbortController();
      try {
        const page = await api.events(contextId, cursor.current, controller.signal);
        if (stopped) return;
        setCompacted((value) => value || page.compacted);
        setEvents((current) => [...current, ...page.events].filter((row, index, all) => all.findIndex((candidate) => candidate.seq === row.seq) === index).slice(-500));
        if (page.cursor && Number(page.cursor) >= Number(cursor.current)) cursor.current = page.cursor;
        setEventState("ready");
      } catch (error) { if (!stopped && !(error instanceof DOMException && error.name === "AbortError")) setEventState(stateForError(error)); }
      finally { if (!stopped && !document.hidden && current === generation) timer = window.setTimeout(() => void poll(current), 2000); }
    };
    const restart = () => { generation++; controller?.abort(); if (timer !== undefined) clearTimeout(timer); if (!document.hidden) void poll(generation); };
    const visibility = () => restart();
    document.addEventListener("visibilitychange", visibility); restart();
    return () => { stopped = true; generation++; controller?.abort(); if (timer !== undefined) clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [api, contextId]);
  if (!detail.data || detail.state !== "ready") return <AsyncState state={detail.state} onRetry={detail.reload} />;
  return <><button className="back" onClick={() => navigate("/work")}>← 업무 목록</button><div className="view-head"><h1><SourceBadge source="hq" /> {detail.data.context.title}</h1><p>{detail.data.context.summary || "요약 없음"}</p></div>
    <div className="grid-2"><section className="card card-body"><h2>문맥</h2><dl className="kv"><dt>context</dt><dd className="mono">{detail.data.context.contextId}</dd><dt>state</dt><dd>{detail.data.context.state}</dd><dt>projects</dt><dd>{detail.data.context.projectIds.join(", ") || "아직 없음"}</dd><dt>updated</dt><dd>{detail.data.context.updatedAt}</dd></dl></section>
      <section className="card card-body"><h2>출처 증거</h2><dl className="kv"><dt>source</dt><dd>{detail.data.evidence.source}</dd><dt>verification</dt><dd>{detail.data.evidence.verification}</dd><dt>observed</dt><dd>{detail.data.evidence.observedAt}</dd></dl></section></div>
    <section className="card section-gap"><div className="card-head"><h2>HQ 이벤트</h2><span>cursor {cursor.current}{compacted ? " · 이전 이력 compacted" : ""}</span></div>
      {eventState !== "ready" ? <AsyncState state={eventState} /> : events.length === 0 ? <AsyncState state="empty" /> : <ol className="timeline">{events.map((event) => <li key={event.seq}><time>{new Date(event.occurredAt).toLocaleString()}</time><strong>{event.kind}</strong><span>{event.eventSource}</span>{event.receiptLink ? <button onClick={() => navigate(`/work/orca/${encodeURIComponent(event.receiptLink!.dispatchId)}`)}>연결된 Dispatch 보기</button> : <em>연결 영수증 아직 없음</em>}</li>)}</ol>}
    </section>
  </>;
}

export function OrcaDetail({ api, mutations, dispatchId, navigate }: Readonly<{ api: OperationsApi; mutations: OperationsMutationRegistry; dispatchId: string; navigate: (path: string) => void }>) {
  const detail = useRead((signal) => api.worker(dispatchId, signal), [api, dispatchId]);
  const [tab, setTab] = useState<"state" | "terminal" | "transcript" | "evidence">("state");
  const [log, setLog] = useState<OrcaOutputPage>();
  const [logState, setLogState] = useState<LoadState>("loading");
  const [followup, setFollowup] = useState("");
  const lastRequestedCursor = useRef<string | undefined>(undefined);
  const logRequest = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
  useEffect(() => {
    const cancel = () => { logRequest.current.generation++; logRequest.current.controller?.abort(); };
    const visibility = () => { if (document.hidden) cancel(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); cancel(); };
  }, [dispatchId]);
  const loadLog = async (source: "terminal" | "transcript", next?: string) => {
    const prior = log?.source === source ? log : undefined;
    if (next && lastRequestedCursor.current === next) return;
    lastRequestedCursor.current = next;
    const generation = ++logRequest.current.generation;
    logRequest.current.controller?.abort();
    const controller = new AbortController();
    logRequest.current.controller = controller;
    setLogState("loading");
    try {
      const page = await api.output(dispatchId, source, next, controller.signal);
      if (controller.signal.aborted || generation !== logRequest.current.generation) return;
      if (prior && prior.source === page.source) {
        if (page.source === "terminal" && prior.source === "terminal") setLog({ ...page, lines: [...prior.lines, ...page.lines].slice(-500) });
        else if (page.source === "transcript" && prior.source === "transcript") setLog({ ...page, messages: [...prior.messages, ...page.messages].filter((row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index).slice(-500) });
      } else setLog(page);
      setLogState("ready");
    } catch (error) { if (!controller.signal.aborted && generation === logRequest.current.generation) setLogState(stateForError(error)); }
  };
  const selectTab = (next: typeof tab) => { setTab(next); if ((next === "terminal" || next === "transcript") && log?.source !== next) { lastRequestedCursor.current = undefined; void loadLog(next); } };
  if (!detail.data || detail.state !== "ready") return <AsyncState state={detail.state} onRetry={detail.reload} />;
  const item = detail.data;
  const uncertain = new Set(["unknown", "unverifiable", "release_pending", "release_unknown", "transferred"]);
  const terminal = item.terminal;
  const ptyId = terminal && typeof terminal.ptyId === "string" ? terminal.ptyId : undefined;
  const resource = item.terminalResource;
  const projectedResource = item.projection.resource;
  const exact = !!terminal && item.observation.exactWorker && terminal.executionHostId === "local" && terminal.handle === item.worker.agentTerminalHandle && !!ptyId && item.dispatch.processIncarnation === `${ptyId}:${terminal.incarnationId}` && resource.endpointIncarnation === item.dispatch.processIncarnation && resource.ownerDispatchId === dispatchId && resource.terminalHandle === terminal.handle && ["owned", "retained"].includes(resource.ownershipState) && ["not_requested", "retained"].includes(resource.releaseState) && projectedResource?.ownerDispatchId === dispatchId && ["owned", "retained"].includes(projectedResource.state) && typeof projectedResource.releaseState === "string" && ["not_requested", "retained"].includes(projectedResource.releaseState) && ![item.worker.state, item.dispatch.status, item.projection.liveness.verdict, item.observation.status].some((value) => uncertain.has(value));
  const live = exact && item.projection.liveness.verdict === "live" && item.observation.status === "live" && terminal.connected && terminal.writable && terminal.orphaned !== true;
  const settled = exact && ["succeeded", "failed", "stopped"].includes(item.projection.outcome ?? "") && ["worker_done", "completed", "succeeded", "failed", "stopped"].includes(item.dispatch.status) && ["live", "exited"].includes(item.projection.liveness.verdict) && ["live", "exited"].includes(item.observation.status);
  const scope = terminal ? { runId: item.dispatch.runId, expectedIncarnation: terminal.incarnationId } : undefined;
  const lifecycle = (action: "stop" | "retain" | "release") => (requestId: string) => api.mutate(`/api/operations/orca/workers/${encodeURIComponent(dispatchId)}/${action}`, scope!, requestId);
  return <><button className="back" onClick={() => navigate("/work")}>← 업무 목록</button><div className="view-head"><h1><SourceBadge source="orca" /> {item.dispatch.id}</h1><p>Dispatch, worker projection, PTY 상태를 각각 표시합니다.</p></div>
    <div className="tabs" role="tablist">{(["state", "terminal", "transcript", "evidence"] as const).map((value) => <button role="tab" aria-selected={tab === value} key={value} onClick={() => selectTab(value)}>{value === "state" ? "상태" : value === "terminal" ? "터미널 로그" : value === "transcript" ? "대화 로그" : "증거"}</button>)}</div>
    {tab === "state" && <><div className="grid-2"><section className="card card-body"><h2>Dispatch / projection</h2><dl className="kv"><dt>dispatch status</dt><dd>{item.dispatch.status}</dd><dt>worker stage</dt><dd>{item.worker.stage}</dd><dt>liveness</dt><dd>{item.projection.liveness.verdict}</dd><dt>observation</dt><dd>{item.observation.status}</dd><dt>outcome</dt><dd>{item.projection.outcome ?? "아직 없음"}</dd></dl></section><section className="card card-body"><h2>PTY / resource</h2><dl className="kv"><dt>connected</dt><dd>{item.terminal ? String(item.terminal.connected) : "터미널 없음"}</dd><dt>writable</dt><dd>{item.terminal ? String(item.terminal.writable) : "터미널 없음"}</dd><dt>incarnation</dt><dd className="mono">{item.terminal?.incarnationId ?? "아직 없음"}</dd><dt>ownership</dt><dd>{item.terminalResource.ownershipState}</dd><dt>release</dt><dd>{item.terminalResource.releaseState}</dd></dl></section></div>
      <section className="card card-body control-panel"><h2>검토된 제어</h2><p className="muted">브라우저에 표시된 Run/Dispatch/incarnation만 전송하며 서버가 fresh owner/liveness/resource 증거를 다시 읽습니다.</p><label>후속 지시<textarea rows={5} maxLength={8000} value={followup} onChange={(event) => setFollowup(event.target.value)} /></label><ReviewedMutation api={api} mutations={mutations} mutationKey={mutationIdentity("followup", dispatchId)} label="후속 지시 검토" title="Orca 후속 지시 검토" disabled={!live || followup.trim().length === 0} review={<><p className="review-text">{followup}</p><dl className="kv compact"><dt>dispatch</dt><dd className="mono">{dispatchId}</dd><dt>run</dt><dd className="mono">{item.dispatch.runId}</dd><dt>incarnation</dt><dd className="mono">{terminal?.incarnationId ?? "없음"}</dd></dl></>} execute={(requestId) => api.mutate("/api/operations/orca/followups", { dispatchId, ...scope!, body: followup }, requestId)} onConflict={detail.reload} />
        <div className="control-actions"><ReviewedMutation api={api} mutations={mutations} mutationKey={mutationIdentity("stop", dispatchId)} label="stop" title="worker stop 검토" disabled={!live} review={<p>live/live인 정확한 worker를 중지 요청합니다.</p>} execute={lifecycle("stop")} onConflict={detail.reload} /><ReviewedMutation api={api} mutations={mutations} mutationKey={mutationIdentity("retain", dispatchId)} label="retain" title="resource retain 검토" disabled={!(live || settled)} review={<p>현재 Dispatch 소유 terminal resource를 유지합니다.</p>} execute={lifecycle("retain")} onConflict={detail.reload} /><ReviewedMutation api={api} mutations={mutations} mutationKey={mutationIdentity("release", dispatchId)} label="release" title="resource release 검토" disabled={!settled} review={<p>권위 있게 settled이고 releasable인 resource만 해제합니다.</p>} execute={lifecycle("release")} onConflict={detail.reload} /></div>
        {!live && !settled ? <p className="mutation-result unknown">현재 증거는 inspect-only입니다. unknown/unverifiable/non-live 상태에서는 제어하지 않습니다.</p> : null}
      </section></>}
    {(tab === "terminal" || tab === "transcript") && <section className="card card-body log-card"><h2>{tab === "terminal" ? "Orca 터미널 출력" : "Orca transcript"}</h2>{logState !== "ready" ? <AsyncState state={logState} /> : log?.source === "terminal" ? <pre>{log.lines.join("\n") || "출력 없음"}</pre> : log?.source === "transcript" ? <ol>{log.messages.map((message) => <li key={message.id}><strong>{message.role}</strong><p>{message.text}</p></li>)}</ol> : null}{log?.cursor && log.cursor !== lastRequestedCursor.current ? <button onClick={() => void loadLog(tab, log.cursor)}>다음 로그 페이지</button> : null}</section>}
    {tab === "evidence" && <section className="card card-body"><h2>Orca 관찰 증거</h2><dl className="kv"><dt>source</dt><dd>{item.evidence.source}</dd><dt>verification</dt><dd>{item.evidence.verification}</dd><dt>observed</dt><dd>{item.evidence.observedAt}</dd><dt>exact worker</dt><dd>{String(item.observation.exactWorker)}</dd></dl></section>}
  </>;
}
