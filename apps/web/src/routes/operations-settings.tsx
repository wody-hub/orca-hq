import type { OperationsApi } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import { useRead } from "../hooks.js";

export function OperationsSettings({ api }: Readonly<{ api: OperationsApi }>) {
  const read = useRead((signal) => api.status(signal), [api]);
  if (!read.data || read.state !== "ready") return <AsyncState state={read.state} onRetry={read.reload} />;
  const status = read.data;
  return <><div className="view-head"><h1>운영 설정</h1><p>안전하게 변경할 수 없는 값은 실제 지원 상태와 이유를 표시합니다.</p></div><div className="grid-2">
    <section className="card card-body"><h2>HQ 용량</h2><dl className="kv"><dt>limit</dt><dd>{status.hq.capacity.limit}</dd><dt>source</dt><dd>{status.hq.capacity.source}</dd><dt>active</dt><dd>{status.hq.capacity.active}</dd><dt>queued</dt><dd>{status.hq.capacity.queued}</dd></dl><button disabled>용량 변경 지원 안 함</button><p className="muted">{status.hq.capacity.reason}</p></section>
    <section className="card card-body"><h2>계측</h2><dl className="kv"><dt>tokens</dt><dd>수집되지 않음</dd><dt>cost</dt><dd>수집되지 않음</dd><dt>currency</dt><dd>수집되지 않음</dd><dt>ETA / percent</dt><dd>수집되지 않음</dd></dl></section>
  </div></>;
}
