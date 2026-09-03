import { useState } from "react";

import type { CommandDetail, DashboardApi } from "../api.js";
import { ApprovalCard } from "../components/approval-card.js";

function Status({ children }: Readonly<{ children: string }>) { return <span className="status">상태: {children}</span>; }
function CodeList({ values }: Readonly<{ values: readonly string[] }>) { return <ul>{values.map((value) => <li key={value}><code>{value}</code></li>)}</ul>; }
function deliveryLabel(channel: string, status: CommandDetail["delivery"][number]["status"]): string {
  return `${channel} 전송 ${status === "pending" ? "대기" : status === "sent" ? "완료" : "실패"}`;
}
function verificationLabel(status: CommandDetail["verification"]["status"]): string {
  if (status === "passed") return "검증 완료";
  if (status === "pending") return "검증 대기";
  return "검증 실패";
}

export function CommandDetailView({ command, api, onBack, onRefresh }: Readonly<{
  command: CommandDetail; api: DashboardApi; onBack(): void; onRefresh(): void;
}>) {
  const [actionState, setActionState] = useState<"idle" | "working" | "stopped" | "retried" | "error">("idle");
  const action = async (kind: "stop" | "retry", dispatchId: string) => {
    setActionState("working");
    try {
      kind === "stop" ? await api.stopDispatch(dispatchId) : await api.retryDispatch(dispatchId);
      setActionState(kind === "stop" ? "stopped" : "retried");
    } catch { setActionState("error"); }
  };
  return <article className="detail">
    <button type="button" className="back" onClick={onBack}>목록으로 돌아가기</button>
    <section className="card"><h1>{command.summary}</h1><Status>{command.status}</Status><p>프로젝트: {command.project.displayName} (<code>{command.project.path}</code>)</p><p>현재 단계: {command.tasks[0]?.title ?? "대기"}</p></section>
    <section className="card"><h2>경로 선택 근거</h2><p>선택 점수: {command.routing.score}</p><p>{command.routing.selectedReason}</p><CodeList values={command.routing.candidates} /></section>
    <section className="card"><h2>변경 계약</h2><dl><dt>base</dt><dd><code>{command.contract.base}</code></dd><dt>허용 scope</dt><dd><CodeList values={command.contract.allowedScope} /></dd><dt>금지 효과</dt><dd><CodeList values={command.contract.prohibitedEffects} /></dd><dt>test commands</dt><dd><CodeList values={command.contract.testCommands} /></dd></dl></section>
    <section className="card"><h2>Task DAG</h2><ul>{command.tasks.map((task) => <li key={task.id}><strong>{task.id}</strong> — {task.title} <Status>{task.status}</Status><p>의존성: {task.dependencies.join(", ") || "없음"}</p><p>{`worker: ${task.workerFamily} · verifier: ${task.verifierFamily}`}</p><p>Dispatch: <code>{task.dispatchId}</code> ({task.dispatchStatus})</p></li>)}</ul></section>
    <section className="card"><h2>diff/test</h2><p>{command.diff.summary}</p><p>{verificationLabel(command.verification.status)}</p><p>상태: {command.verification.status}</p><CodeList values={command.verification.commands} /></section>
    <ApprovalCard approval={command.approval} contract={command.contract} api={api} onDone={onRefresh} />
    <section className="card"><h2>승인 이력</h2>{command.approvalHistory.length === 0
      ? <p>승인 이력이 없습니다.</p>
      : <ol>{command.approvalHistory.map((approval) => <li key={approval.id}>
          <p><code>{approval.id}</code> · {approval.level} · <span>{approval.status}</span></p>
          <p>digest: <code>{approval.digest}</code></p>
          {approval.approvedAt && <p>승인 시각: <time dateTime={approval.approvedAt}>{approval.approvedAt}</time></p>}
          {approval.expiresAt && <p>만료 시각: <time dateTime={approval.expiresAt}>{approval.expiresAt}</time></p>}
        </li>)}</ol>}</section>
    <section className="card"><h2>감사 이력</h2>{command.auditHistory.length === 0
      ? <p>감사 참조: <code>{command.audit.reference}</code> · {command.audit.summary}</p>
      : <ol>{command.auditHistory.map((audit) => <li key={audit.reference}>
          <p><code>{audit.subjectId}</code> · <span>{audit.summary}</span></p>
          <p>감사 참조: <code>{audit.reference}</code></p>
          <time dateTime={audit.occurredAt}>{audit.occurredAt}</time>
        </li>)}</ol>}</section>
    <section className="card"><h2>채널 전달</h2>{command.delivery.length === 0
      ? <p>전달 이력이 없습니다.</p>
      : <ul>{command.delivery.map((delivery) => <li key={delivery.channel}>{deliveryLabel(delivery.channel, delivery.status)}</li>)}</ul>}</section>
    <section className="card"><h2>Dispatch 제어</h2><p>중지는 Dispatch만 중지하며 worktree를 삭제하지 않습니다.</p><ul>{command.tasks.map((task) => <li key={task.id}><strong>{task.id}</strong> — {task.title} <p>Dispatch: <code>{task.dispatchId}</code> ({task.dispatchStatus})</p><button type="button" disabled={actionState === "working" || !task.canStop} onClick={() => void action("stop", task.dispatchId)} aria-label={`Dispatch 중지: ${task.title} (${task.dispatchId})`}>Dispatch 중지</button><button type="button" disabled={actionState === "working" || !task.canRetry} onClick={() => void action("retry", task.dispatchId)} aria-label={`Dispatch 재시도: ${task.title} (${task.dispatchId})`}>Dispatch 재시도</button></li>)}</ul><p role="status">{actionState === "working" ? "Dispatch 요청 처리 중입니다." : actionState === "stopped" ? "Dispatch 중지 요청이 완료되었습니다." : actionState === "retried" ? "Dispatch 재시도 요청이 완료되었습니다." : actionState === "error" ? "Dispatch 요청을 처리하지 못했습니다." : ""}</p></section>
  </article>;
}
