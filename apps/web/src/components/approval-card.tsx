import { useState } from "react";

import type { CommandDetail, DashboardApi } from "../api.js";

export function ApprovalCard({ approval, api, onDone }: Readonly<{
  approval: CommandDetail["approval"];
  api: DashboardApi;
  onDone(): void;
}>) {
  const [phrase, setPhrase] = useState("");
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const expired = Date.parse(approval.expiresAt) <= Date.now() || approval.status === "expired";
  const unavailable = expired || approval.status !== "pending" || !approval.permitted || state === "working";
  const phraseMatches = approval.level !== "L3" || phrase === approval.operationPhrase;
  const submit = async () => {
    setState("working");
    try {
      await api.confirmApproval(approval.id, approval.level === "L3"
        ? { digest: approval.digest, phrase }
        : { digest: approval.digest });
      setPhrase("");
      setState("done");
      onDone();
    } catch {
      setState("error");
    }
  };
  return <section className="card" aria-labelledby="approval-heading">
    <h2 id="approval-heading">승인</h2>
    <p><strong>{approval.level}</strong> · 상태: {approval.status}</p>
    <dl><dt>위험 등급</dt><dd>{approval.level}</dd><dt>변경 digest</dt><dd><code>{approval.digest}</code></dd><dt>만료 시각</dt><dd>{approval.expiresAt}</dd></dl>
    {approval.level === "L3" && <label>승인 문구 입력
      <input aria-label="승인 문구 입력" autoComplete="off" spellCheck={false} value={phrase} onChange={(event) => setPhrase(event.target.value)} disabled={unavailable} />
    </label>}
    {!approval.permitted && <p role="status">이 역할에는 승인 권한이 없습니다.</p>}
    {expired && <p role="status">만료되어 승인할 수 없습니다.</p>}
    {approval.status !== "pending" && !expired && <p role="status">이미 처리되어 승인할 수 없습니다.</p>}
    <button type="button" onClick={submit} disabled={unavailable || !phraseMatches}>{approval.level} 승인</button>
    <p aria-live="polite">{state === "working" ? "승인 요청 중입니다." : state === "done" ? "승인되었습니다." : state === "error" ? "승인 요청을 처리하지 못했습니다." : ""}</p>
  </section>;
}
