import type { OperationsApi } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import { SourceBadge } from "../components/source-badge.js";
import { useRead } from "../hooks.js";
import { loadCurrentHqQuestions } from "../operations-state.js";

export function OperationsEvidence({ api }: Readonly<{ api: OperationsApi }>) {
  const read = useRead(async (signal) => {
    const [workers, hqQuestions, orcaQuestions] = await Promise.all([api.workers(undefined, signal), loadCurrentHqQuestions(api, signal), api.orcaQuestions(signal)]);
    return { workers, hqQuestions, orcaQuestions };
  }, [api]);
  if (!read.data || read.state !== "ready") return <AsyncState state={read.state} onRetry={read.reload} />;
  return <><div className="view-head"><h1>리서치 / 기획 증거</h1><p>운영 화면이 사용한 실제 공개 출처와 검증 수준을 확인합니다.</p></div><div className="grid-2">
    <section className="card card-body"><h2><SourceBadge source="hq" /> HQ store</h2>{!read.data.hqQuestions.coverage.complete ? <p className="mutation-result unknown">질문 범위 일부만 확인됨 · {read.data.hqQuestions.coverage.reason}</p> : read.data.hqQuestions.questions.length === 0 ? <p>현재 질문 증거 없음</p> : read.data.hqQuestions.questions.map((item) => <dl className="kv" key={item.requestId}><dt>request</dt><dd>{item.requestId}</dd><dt>observed</dt><dd>{item.evidence.observedAt}</dd><dt>verification</dt><dd>{item.evidence.verification}</dd></dl>)}</section>
    <section className="card card-body"><h2><SourceBadge source="orca" /> Orca CLI</h2><dl className="kv"><dt>workers</dt><dd>{read.data.workers.workers.length}</dd><dt>questions</dt><dd>{read.data.orcaQuestions.count}</dd><dt>pending state</dt><dd>{read.data.orcaQuestions.support.pendingState.supported ? "supported" : `지원 안 함 · ${read.data.orcaQuestions.support.pendingState.reason}`}</dd><dt>observed</dt><dd>{read.data.workers.evidence.observedAt}</dd></dl></section>
  </div></>;
}
