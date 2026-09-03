import { useEffect, useState } from "react";

import { createDashboardApi, DashboardApiError, type CommandDetail, type CommandSummary, type DashboardApi } from "./api.js";
import { CommandDetailView } from "./routes/command-detail.js";
import { CommandList } from "./routes/command-list.js";

type ViewState = "loading" | "ready" | "error" | "not-found";
function commandIdFromPath(): string | undefined {
  const match = window.location.pathname.match(/^\/commands\/([^/]+)$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}
function message(error: unknown): string {
  const status = error instanceof DashboardApiError ? error.status : undefined;
  if (status === 401) return "로그인 또는 세션을 다시 확인해 주세요.";
  if (status === 403) return "이 정보에 접근할 권한이 없습니다.";
  if (status === 409) return "제안이 변경되었습니다. 최신 정보를 확인해 주세요.";
  if (status === 404) return "요청한 명령을 찾을 수 없습니다.";
  return "정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
}
export function App({ api = createDashboardApi(), initialCommandId }: Readonly<{ api?: DashboardApi; initialCommandId?: string }>) {
  const [commands, setCommands] = useState<readonly CommandSummary[]>([]);
  const [detail, setDetail] = useState<CommandDetail>();
  const [state, setState] = useState<ViewState>("loading");
  const [error, setError] = useState("");
  const loadList = async () => { setState("loading"); try { await api.bootstrap(); const result = await api.listCommands(); setCommands(result.commands); setState("ready"); } catch (cause) { setError(message(cause)); setState("error"); } };
  const select = async (id: string) => { setState("loading"); try { const result = await api.getCommand(id); setDetail(result); window.history.pushState({}, "", `/commands/${encodeURIComponent(id)}`); setState("ready"); } catch (cause) { setError(message(cause)); setState(cause instanceof DashboardApiError && cause.status === 404 ? "not-found" : "error"); } };
  useEffect(() => {
    const commandId = initialCommandId ?? commandIdFromPath();
    if (commandId === undefined) { void loadList(); return; }
    void api.bootstrap().then(() => select(commandId)).catch((cause: unknown) => { setError(message(cause)); setState("error"); });
  }, []);
  const back = () => { setDetail(undefined); window.history.pushState({}, "", "/commands"); void loadList(); };
  return <><header><nav aria-label="주요 탐색"><a href="/commands" onClick={(event) => { event.preventDefault(); back(); }}>Orca HQ</a><span>연결됨 · 갱신 상태 확인 중</span></nav></header><main aria-live="polite">
    {state === "loading" && <p>정보를 불러오는 중입니다.</p>}
    {state === "error" && <section className="card"><h1>확인 필요</h1><p>{error}</p><button type="button" onClick={() => void loadList()}>다시 시도</button></section>}
    {state === "not-found" && <section className="card"><h1>명령을 찾을 수 없음</h1><p>{error}</p><button type="button" onClick={back}>명령 목록으로</button></section>}
    {state === "ready" && (detail ? <CommandDetailView command={detail} api={api} onBack={back} onRefresh={() => void select(detail.id)} /> : <CommandList commands={commands} onSelect={(id) => void select(id)} />)}
  </main></>;
}
