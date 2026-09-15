import { useState } from "react";
import type { HqQuestion, OperationsApi, OrcaQuestionPage } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import { SourceBadge } from "../components/source-badge.js";
import { useRead } from "../hooks.js";
import { loadCurrentHqQuestions, mutationIdentity, type OperationsMutationRegistry } from "../operations-state.js";
import { ReviewedMutation } from "./operations-compose.js";

function Answer({ api, mutations, source, item, runId }: Readonly<{ api: OperationsApi; mutations: OperationsMutationRegistry; source: "HQ" | "Orca"; item: HqQuestion | OrcaQuestionPage["messages"][number]; runId?: string | undefined }>) {
  const [body, setBody] = useState("");
  const hq = source === "HQ" ? item as HqQuestion : undefined;
  const orca = source === "Orca" ? item as OrcaQuestionPage["messages"][number] : undefined;
  const id = hq?.requestId ?? orca!.id;
  const isHqRouter = hq?.kind === "router_clarification";
  const valid = body.trim().length > 0 && body.length <= 8000 && (isHqRouter || !!runId);
  const messageId = hq?.messageId ?? orca?.id ?? "";
  return <div className="answer-form"><label>{source} 답변 {id}<textarea rows={4} maxLength={8000} value={body} onChange={(event) => setBody(event.target.value)} /></label><ReviewedMutation api={api} mutations={mutations} mutationKey={mutationIdentity(isHqRouter ? "hq_request" : "reply", id)} label={`${source} 답변 검토 ${id}`} title={`${source} 답변 검토`} disabled={!valid} review={<p className="review-text">{body}</p>} execute={(requestId) => isHqRouter ? api.mutate("/api/operations/hq/requests", { requestId, sessionId: hq!.sessionId, text: body }, requestId) : api.mutate("/api/operations/orca/replies", { messageId, runId: runId!, body }, requestId)} /></div>;
}

export function OperationsQuestions({ api, mutations }: Readonly<{ api: OperationsApi; mutations: OperationsMutationRegistry }>) {
  const read = useRead(async (signal) => { const [hq, orca] = await Promise.all([loadCurrentHqQuestions(api, signal), api.orcaQuestions(signal)]); return { hq, orca }; }, [api]);
  if (!read.data || read.state !== "ready") return <AsyncState state={read.state} onRetry={read.reload} />;
  const runFor = (question: HqQuestion) => question.messageId ? read.data!.orca.messages.find((message) => message.id === question.messageId)?.run_id ?? undefined : undefined;
  return <><div className="view-head"><h1>질문함</h1><p>HQ pending 질문과 Orca inbox 관찰을 분리하고, 제출 직전 서버가 권위 상태를 다시 확인합니다.</p></div><div className="grid-2 controls-grid">
    <section className="card card-body"><h2><SourceBadge source="hq" /> HQ 질문</h2>{!read.data.hq.coverage.complete ? <p className="mutation-result unknown">질문 범위 일부만 확인됨 · {read.data.hq.coverage.reason}</p> : read.data.hq.questions.length === 0 ? <p className="empty-copy">대기 질문 없음</p> : <ul className="question-list">{read.data.hq.questions.map((item) => <li key={`${item.requestId}:${item.occurredAt}`}><strong>{item.body}</strong><small>{item.requestId} · {item.state}</small><Answer api={api} mutations={mutations} source="HQ" item={item} runId={runFor(item)} /></li>)}</ul>}</section>
    <section className="card card-body"><h2><SourceBadge source="orca" /> Orca inbox</h2>{read.data.orca.messages.length === 0 ? <p className="empty-copy">관찰된 질문 없음</p> : <ul className="question-list">{read.data.orca.messages.map((item) => <li key={item.id}><strong>{item.subject || item.body}</strong><small>{item.run_id ?? "Run 미제공"}</small><Answer api={api} mutations={mutations} source="Orca" item={item} runId={item.run_id ?? undefined} /></li>)}</ul>}<p className="muted">공개 inbox에는 권위 있는 pending 상태가 없습니다. 관찰 이력만 표시하며 서버의 fresh gate가 거부할 수 있습니다.</p></section>
  </div></>;
}
