import type { OperationsApi } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import { SourceBadge } from "../components/source-badge.js";
import { useVisiblePolling } from "../hooks.js";
import { loadCurrentHqQuestions } from "../operations-state.js";

export function OperationsOverview({ api, navigate }: Readonly<{ api: OperationsApi; navigate: (path: string) => void }>) {
  const read = useVisiblePolling(async (signal) => {
    const [status, contexts, workers, hqQuestions, orcaQuestions] = await Promise.all([
      api.status(signal), api.contexts(undefined, signal), api.workers(undefined, signal), loadCurrentHqQuestions(api, signal), api.orcaQuestions(signal),
    ]);
    return { status, contexts, workers, hqQuestions, orcaQuestions };
  }, 5000, [api]);
  if (!read.data || read.state !== "ready") return <AsyncState state={read.state} onRetry={read.reload} />;
  const { status, contexts, workers, hqQuestions, orcaQuestions } = read.data;
  const uncertain = workers.workers.filter((item) => ["unknown", "unverifiable"].includes(item.projection.liveness.verdict));
  const attention = hqQuestions.questions.length + uncertain.length;
  return <>
    <div className="view-head"><h1>운영 개요</h1><p>HQ 업무와 Orca 실행은 서로 다른 실제 출처로 분리해 표시합니다.</p></div>
    <div className="stat-row">
      <div className="stat"><span>HQ 진행중 업무</span><strong>{status.hq.capacity.active}</strong><small>HQ admission 기준</small></div>
      <div className="stat"><span>Orca 관찰 워커</span><strong>{workers.workers.length}</strong><small>외부 fleet는 HQ 용량에서 제외</small></div>
      <div className="stat"><span>관심 필요</span><strong>{attention}</strong><small>질문 · 불확실 상태</small></div>
      <div className="stat"><span>HQ 용량</span><strong>{status.hq.capacity.active} / {status.hq.capacity.limit}</strong><small>{status.hq.capacity.source} 설정</small></div>
    </div>
    <div className="grid-2">
      <section className="card"><div className="card-head"><h2>관심함</h2><span>실제 읽기</span></div><div className="card-body attention-list">
        {attention === 0 && hqQuestions.coverage.complete ? <p className="empty-copy">권위 있게 확인된 관심 항목이 없습니다.</p> : null}
        {!hqQuestions.coverage.complete ? <p className="mutation-result unknown">질문 범위 일부만 확인됨 · {hqQuestions.coverage.reason}</p> : null}
        {hqQuestions.questions.map((question) => <button className="attention" key={question.requestId} onClick={() => navigate(question.contextId ? `/work/hq/${encodeURIComponent(question.contextId)}` : "/questions")}><SourceBadge source="hq" /><span>{question.body}</span></button>)}
        {uncertain.map((worker) => <button className="attention" key={worker.dispatchId} onClick={() => navigate(`/work/orca/${encodeURIComponent(worker.dispatchId)}`)}><SourceBadge source="orca" /><span>{worker.dispatchId} · 상태 판정 필요</span></button>)}
        {orcaQuestions.messages.length > 0 ? <div className="attention"><SourceBadge source="orca" /><span>{orcaQuestions.messages.map((question) => question.subject || question.body).join(" · ")}</span></div> : null}
        <p className="muted">Orca inbox {orcaQuestions.messages.length}건 관찰 · pending 상태 판정 불가{orcaQuestions.support.pendingState.supported ? "" : ` · ${orcaQuestions.support.pendingState.reason}`}</p>
      </div></section>
      <section className="card"><div className="card-head"><h2>연결 및 수집</h2><span>{new Date(status.collectedAt).toLocaleTimeString()}</span></div><dl className="kv card-body">
        <dt>HQ</dt><dd>{status.hq.state}</dd><dt>Orca</dt><dd>{status.orca.reachable ? `연결됨 · ${status.orca.version}` : `연결 안 됨 · ${status.orca.state}`}</dd>
        <dt>tokens</dt><dd>수집되지 않음</dd><dt>cost</dt><dd>수집되지 않음</dd>
      </dl></section>
    </div>
    <div className="grid-2 section-gap">
      <section className="card"><div className="card-head"><h2>HQ 업무</h2><span>{contexts.contexts.length}건</span></div><div className="table-wrap"><table><thead><tr><th>제목</th><th>상태</th><th>갱신</th></tr></thead><tbody>{contexts.contexts.slice(0, 5).map((item) => <tr key={item.contextId} onClick={() => navigate(`/work/hq/${encodeURIComponent(item.contextId)}`)}><td>{item.title}</td><td>{item.state}</td><td>{new Date(item.updatedAt).toLocaleTimeString()}</td></tr>)}</tbody></table></div></section>
      <section className="card"><div className="card-head"><h2>Orca 실행</h2><span>{workers.workers.length}건</span></div><div className="table-wrap"><table><thead><tr><th>Dispatch</th><th>liveness</th><th>Run</th></tr></thead><tbody>{workers.workers.slice(0, 5).map((item) => <tr key={item.dispatchId} onClick={() => navigate(`/work/orca/${encodeURIComponent(item.dispatchId)}`)}><td>{item.dispatchId}</td><td>{item.projection.liveness.verdict}</td><td>{item.projection.runId}</td></tr>)}</tbody></table></div></section>
    </div>
  </>;
}
