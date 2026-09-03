import { useEffect, useRef, useState } from "react";

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
  const requestEpoch = useRef(0);
  const loadList = async () => { const epoch = ++requestEpoch.current; setState("loading"); setDetail(undefined); try { const result = await api.listCommands(); if (epoch !== requestEpoch.current) return; setCommands(result.commands); setState("ready"); } catch (cause) { if (epoch !== requestEpoch.current) return; setError(message(cause)); setState("error"); } };
  const loadDetail = async (id: string, push: boolean) => { const epoch = ++requestEpoch.current; setState("loading"); try { const result = await api.getCommand(id); if (epoch !== requestEpoch.current) return; setDetail(result); if (push) window.history.pushState({}, "", `/commands/${encodeURIComponent(id)}`); setState("ready"); } catch (cause) { if (epoch !== requestEpoch.current) return; setError(message(cause)); setState(cause instanceof DashboardApiError && cause.status === 404 ? "not-found" : "error"); } };
  const loadPath = async (push = false) => {
    const commandId = commandIdFromPath();
    if (commandId === undefined) await loadList();
    else await loadDetail(commandId, push);
  };
  useEffect(() => {
    const initialPath = initialCommandId === undefined ? commandIdFromPath() : initialCommandId;
    const epoch = ++requestEpoch.current;
    const start = async () => {
      try {
        await api.bootstrap();
        if (epoch !== requestEpoch.current) return;
        if (initialPath === undefined) await loadList();
        else await loadDetail(initialPath, false);
      } catch (cause) { if (epoch === requestEpoch.current) { setError(message(cause)); setState("error"); } }
    };
    const onPopState = () => { void loadPath(); };
    window.addEventListener("popstate", onPopState);
    void start();
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const back = () => { window.history.pushState({}, "", "/commands"); void loadList(); };
  const connectionLabel = state === "ready" ? "연결됨 · 최신 정보" : state === "loading" ? "정보 갱신 중" : state === "error" ? "갱신 실패 · 재시도 필요" : "요청한 명령 확인 필요";
  return <><header><nav aria-label="주요 탐색"><a href="/commands" onClick={(event) => { event.preventDefault(); back(); }}>Orca HQ</a><span>{connectionLabel}</span></nav></header><main>
    {state === "loading" && <p role="status">정보를 불러오는 중입니다.</p>}
    {state === "error" && <section className="card" role="alert"><h1>확인 필요</h1><p>{error}</p><button type="button" onClick={() => void loadPath()}>다시 시도</button></section>}
    {state === "not-found" && <section className="card" role="alert"><h1>명령을 찾을 수 없음</h1><p>{error}</p><button type="button" onClick={back}>명령 목록으로</button></section>}
    {state === "ready" && (detail ? <CommandDetailView command={detail} api={api} onBack={back} onRefresh={() => void loadDetail(detail.id, false)} /> : <CommandList commands={commands} onSelect={(id) => void loadDetail(id, true)} />)}
  </main></>;
}
