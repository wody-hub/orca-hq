import { useEffect, useRef, useState } from "react";
import { createOperationsApi, OperationsApiError, type OperationsApi } from "./api.js";
import { AsyncState } from "./components/async-state.js";
import { OperationsCompose } from "./routes/operations-compose.js";
import { HqDetail, OrcaDetail } from "./routes/operations-detail.js";
import { OperationsEvidence } from "./routes/operations-evidence.js";
import { OperationsList } from "./routes/operations-list.js";
import { OperationsOverview } from "./routes/operations-overview.js";
import { OperationsQuestions } from "./routes/operations-questions.js";
import { OperationsResources } from "./routes/operations-resources.js";
import { OperationsSettings } from "./routes/operations-settings.js";
import { OperationsMutationRegistry } from "./operations-state.js";

const nav = [
  ["/overview", "운영 개요"], ["/work", "업무 목록"], ["/compose", "새 지시"], ["/questions", "질문함"],
  ["/resources", "프로젝트/터미널"], ["/settings", "운영 설정"], ["/evidence", "리서치/기획"],
] as const;

function Screen({ path, api, mutations, navigate }: Readonly<{ path: string; api: OperationsApi; mutations: OperationsMutationRegistry; navigate: (path: string) => void }>) {
  const hq = path.match(/^\/work\/hq\/([^/]+)$/);
  const orca = path.match(/^\/work\/orca\/([^/]+)$/);
  if (hq?.[1]) return <HqDetail api={api} contextId={decodeURIComponent(hq[1])} navigate={navigate} />;
  if (orca?.[1]) return <OrcaDetail api={api} mutations={mutations} dispatchId={decodeURIComponent(orca[1])} navigate={navigate} />;
  if (path === "/work") return <OperationsList api={api} navigate={navigate} />;
  if (path === "/resources") return <OperationsResources api={api} />;
  if (path === "/settings") return <OperationsSettings api={api} />;
  if (path === "/evidence") return <OperationsEvidence api={api} />;
  if (path === "/questions") return <OperationsQuestions api={api} mutations={mutations} />;
  if (path === "/compose") return <OperationsCompose api={api} mutations={mutations} />;
  return <OperationsOverview api={api} navigate={navigate} />;
}

export function App({ api = createOperationsApi() }: Readonly<{ api?: OperationsApi }>) {
  const [path, setPath] = useState(window.location.pathname === "/" ? "/overview" : window.location.pathname);
  const [session, setSession] = useState<"loading" | "ready" | "error">("loading");
  const [sessionError, setSessionError] = useState("");
  const mutations = useRef(new OperationsMutationRegistry()).current;
  const navigate = (next: string) => { window.history.pushState({}, "", next); setPath(next); };
  useEffect(() => {
    let active = true;
    const start = async () => { try { await api.bootstrap(); if (active) setSession("ready"); } catch (error) { if (active) { setSession("error"); setSessionError(error instanceof OperationsApiError ? error.code : "session_required"); } } };
    const pop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", pop); void start();
    return () => { active = false; window.removeEventListener("popstate", pop); };
  }, [api]);
  const activeBase = path.startsWith("/work/") ? "/work" : path;
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><strong>HQ / Orca Operations</strong><small>실제 읽기 콘솔</small></div><nav aria-label="주요 화면">{nav.map(([href, label]) => <a className={activeBase === href ? "active" : ""} href={href} key={href} onClick={(event) => { event.preventDefault(); navigate(href); }}><span className="nav-dot" />{label}</a>)}</nav><p className="nav-footer">단일 운영자용 로컬 콘솔<br />HQ와 Orca 출처를 분리합니다.</p></aside>
    <div className="content-shell"><header className="topbar"><span className={`connection ${session}`}><i />{session === "loading" ? "세션 확인 중" : session === "ready" ? "로컬 세션" : "인증 필요"}</span><span>same-origin · reviewed controls</span></header><main className="main-content">
      {session === "loading" ? <AsyncState state="loading" /> : session === "error" ? <section className="auth-error" role="alert"><h1>로컬 세션을 열 수 없습니다</h1><p>터미널에서 <code>hq console</code>을 실행해 새 단일 사용 링크로 접속하세요.</p><small>{sessionError}</small></section> : <Screen key={path} path={path} api={api} mutations={mutations} navigate={navigate} />}
    </main></div>
  </div>;
}
