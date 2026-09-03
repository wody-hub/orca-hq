import { useState } from "react";

import type { CommandDetail, DashboardApi } from "../api.js";
import { ApprovalCard } from "../components/approval-card.js";

function Status({ children }: Readonly<{ children: string }>) { return <span className="status">상태: {children}</span>; }
function CodeList({ values }: Readonly<{ values: readonly string[] }>) { return <ul>{values.map((value) => <li key={value}><code>{value}</code></li>)}</ul>; }
function deliveryLabel(channel: string, status: CommandDetail["delivery"][number]["status"]): string {
  return `${channel} 전송 ${status === "pending" ? "대기" : status === "sent" ? "완료" : "실패"}`;
}
function verificationLabel(status: string): string {
  if (status === "passed" || status === "완료") return "검증 완료";
  if (status === "pending" || status === "대기") return "검증 대기";
  if (status === "failed" || status === "실패") return "검증 실패";
  return `검증 ${status}`;
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
    <section className="card"><h2>Task DAG 및 Dispatch 제어</h2><p>중지는 Dispatch만 중지하며 worktree를 삭제하지 않습니다.</p><ul>{command.tasks.map((task) => <li key={task.id}><strong>{task.id}</strong> — {task.title} <Status>{task.status}</Status><p>의존성: {task.dependencies.join(", ") || "없음"}</p><p>{`worker: ${task.workerFamily} · verifier: ${task.verifierFamily}`}</p><p>Dispatch: <code>{task.dispatchId}</code> ({task.dispatchStatus})</p><button type="button" disabled={actionState === "working"} onClick={() => void action("stop", task.dispatchId)} aria-label={`Dispatch 중지: ${task.title} (${task.dispatchId})`}>Dispatch 중지</button><button type="button" disabled={actionState === "working"} onClick={() => void action("retry", task.dispatchId)} aria-label={`Dispatch 재시도: ${task.title} (${task.dispatchId})`}>Dispatch 재시도</button></li>)}</ul><p role="status">{actionState === "working" ? "Dispatch 요청 처리 중입니다." : actionState === "stopped" ? "Dispatch 중지 요청이 완료되었습니다." : actionState === "retried" ? "Dispatch 재시도 요청이 완료되었습니다." : actionState === "error" ? "Dispatch 요청을 처리하지 못했습니다." : ""}</p></section>
    <section className="card"><h2>diff/test</h2><p>{command.diff.summary}</p><p>{verificationLabel(command.verification.status)}</p><p>상태: {command.verification.status}</p><CodeList values={command.verification.commands} /></section>
    <ApprovalCard approval={command.approval} contract={command.contract} api={api} onDone={onRefresh} />
    <section className="card"><h2>감사 및 채널 전달</h2><p>감사 참조: <code>{command.audit.reference}</code> · {command.audit.summary}</p><ul>{command.delivery.map((delivery) => <li key={delivery.channel}>{deliveryLabel(delivery.channel, delivery.status)}</li>)}</ul></section>
  </article>;
}
