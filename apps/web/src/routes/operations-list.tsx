import { useEffect, useRef, useState } from "react";
import type { HqContext, OperationsApi, OrcaWorkerPage } from "../api.js";
import { AsyncState, type LoadState } from "../components/async-state.js";
import { SourceBadge } from "../components/source-badge.js";
import { stateForError, useRead, useVisiblePolling } from "../hooks.js";

type Worker = OrcaWorkerPage["workers"][number];

function RunTasks({ api, runId }: Readonly<{ api: OperationsApi; runId: string }>) {
  const read = useRead((signal) => api.tasks(runId, signal), [api, runId]);
  if (!read.data || read.state !== "ready") return <AsyncState state={read.state} onRetry={read.reload} />;
  return <div className="table-wrap"><table><thead><tr><th>Task</th><th>status</th><th>created by</th></tr></thead><tbody>{read.data.tasks.map((task) => <tr key={task.id}><td className="mono">{task.id}</td><td>{task.status}</td><td className="mono">{task.created_by_terminal_handle ?? "제공되지 않음"}</td></tr>)}</tbody></table>{read.data.tasks.length === 0 ? <p className="empty-copy">이 Run의 Task가 없습니다.</p> : null}</div>;
}

export function OperationsList({ api, navigate }: Readonly<{ api: OperationsApi; navigate: (path: string) => void }>) {
  const [filter, setFilter] = useState<"all" | "hq" | "orca">("all");
  const [query, setQuery] = useState("");
  const [selectedRun, setSelectedRun] = useState<string>();
  const [moreContexts, setMoreContexts] = useState<readonly HqContext[]>([]);
  const [moreWorkers, setMoreWorkers] = useState<readonly Worker[]>([]);
  const [contextCursor, setContextCursor] = useState<string>();
  const [workerCursor, setWorkerCursor] = useState<string>();
  const [pageState, setPageState] = useState<LoadState>("ready");
  const contextFirstPage = useRef<string | undefined>(undefined);
  const workerFirstPage = useRef<string | undefined>(undefined);
  const pageRequest = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
  const read = useVisiblePolling(async (signal) => {
    const [contexts, workers, runs] = await Promise.all([api.contexts(undefined, signal), api.workers(undefined, signal), api.runs(undefined, signal)]);
    return { contexts, workers, runs };
  }, 5000, [api]);
  const contextSignature = read.data ? JSON.stringify([read.data.contexts.cursor ?? null, read.data.contexts.compacted ?? false, read.data.contexts.contexts.map((row) => [row.contextId, row.updatedAt])]) : undefined;
  const workerSignature = read.data ? JSON.stringify([read.data.workers.page.nextCursor ?? null, read.data.workers.page.hasMore, read.data.workers.workers.map((row) => row.dispatchId)]) : undefined;

  useEffect(() => {
    if (!read.data || contextSignature === undefined || workerSignature === undefined) return;
    let invalidated = false;
    if (contextFirstPage.current !== contextSignature) {
      contextFirstPage.current = contextSignature;
      setMoreContexts([]);
      setContextCursor(read.data.contexts.cursor);
      invalidated = true;
    }
    if (workerFirstPage.current !== workerSignature) {
      workerFirstPage.current = workerSignature;
      setMoreWorkers([]);
      setWorkerCursor(read.data.workers.page.nextCursor ?? undefined);
      invalidated = true;
    }
    if (invalidated) {
      pageRequest.current.generation++;
      pageRequest.current.controller?.abort();
      setPageState("ready");
    }
  }, [read.data, contextSignature, workerSignature]);

  useEffect(() => {
    const cancel = () => { pageRequest.current.generation++; pageRequest.current.controller?.abort(); };
    const visibility = () => { if (document.hidden) { cancel(); setPageState("ready"); } };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); cancel(); };
  }, []);

  if (!read.data || read.state !== "ready") return <AsyncState state={read.state} onRetry={read.reload} />;
  const needle = query.trim().toLocaleLowerCase();
  const contexts = [...read.data.contexts.contexts, ...(contextFirstPage.current === contextSignature ? moreContexts : [])].filter((row, index, all) => all.findIndex((candidate) => candidate.contextId === row.contextId) === index).filter((row) => !needle || [row.contextId, row.title, row.state].some((value) => value.toLocaleLowerCase().includes(needle)));
  const workers = [...read.data.workers.workers, ...(workerFirstPage.current === workerSignature ? moreWorkers : [])].filter((row, index, all) => all.findIndex((candidate) => candidate.dispatchId === row.dispatchId) === index).filter((row) => !needle || [row.dispatchId, row.projection.taskId, row.projection.runId, row.projection.liveness.verdict].some((value) => value.toLocaleLowerCase().includes(needle)));
  const runs = read.data.runs.runs.filter((row) => !needle || [row.id, row.objective].some((value) => value.toLocaleLowerCase().includes(needle)));
  const loadMore = async () => {
    if (pageState === "loading") return;
    const contextNext = filter !== "orca" ? contextCursor : undefined;
    const workerNext = filter !== "hq" ? workerCursor : undefined;
    if (!contextNext && !workerNext) return;
    const generation = ++pageRequest.current.generation;
    pageRequest.current.controller?.abort();
    const controller = new AbortController();
    pageRequest.current.controller = controller;
    setPageState("loading");
    try {
      const [contextPage, workerPage] = await Promise.all([
        contextNext ? api.contexts(contextNext, controller.signal) : Promise.resolve(undefined),
        workerNext ? api.workers(workerNext, controller.signal) : Promise.resolve(undefined),
      ]);
      if (controller.signal.aborted || generation !== pageRequest.current.generation) return;
      if (contextPage && contextNext) {
        setMoreContexts((value) => [...value, ...contextPage.contexts]);
        setContextCursor(contextPage.cursor && contextPage.cursor !== contextNext ? contextPage.cursor : undefined);
      }
      if (workerPage && workerNext) {
        setMoreWorkers((value) => [...value, ...workerPage.workers]);
        const next = workerPage.page.nextCursor ?? undefined;
        setWorkerCursor(next && next !== workerNext ? next : undefined);
      }
      setPageState("ready");
    } catch (error) {
      if (!controller.signal.aborted && generation === pageRequest.current.generation) setPageState(stateForError(error));
    }
  };

  return <><div className="view-head"><h1>업무 목록</h1><p>HQ 문맥과 Orca Run/Task/Dispatch를 합성하지 않고 나란히 조회합니다.</p></div>
    <div className="list-tools"><div className="filters" aria-label="출처 필터">{(["all", "hq", "orca"] as const).map((value) => <button className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{value === "all" ? "전체" : value === "hq" ? "HQ" : "Orca"}</button>)}</div><label>업무 검색<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    {(filter === "all" || filter === "hq") && <section className="card"><div className="card-head"><h2><SourceBadge source="hq" /> 문맥/요청</h2><span>{contexts.length}건</span></div><div className="table-wrap"><table><thead><tr><th>제목</th><th>상태</th><th>문맥 ID</th><th>갱신</th></tr></thead><tbody>{contexts.map((item) => <tr key={item.contextId} onClick={() => navigate(`/work/hq/${encodeURIComponent(item.contextId)}`)}><td>{item.title}</td><td>{item.state}</td><td className="mono">{item.contextId}</td><td>{new Date(item.updatedAt).toLocaleString()}</td></tr>)}</tbody></table>{contexts.length === 0 ? <p className="empty-copy">HQ 문맥이 없습니다.</p> : null}</div></section>}
    {(filter === "all" || filter === "orca") && <><section className="card section-gap"><div className="card-head"><h2><SourceBadge source="orca" /> Run</h2><span>{runs.length}건</span></div><div className="table-wrap"><table><thead><tr><th>Run</th><th>objective</th><th>coordinator</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td><button className="mono" onClick={() => setSelectedRun(run.id)} aria-pressed={selectedRun === run.id}>{run.id}</button></td><td>{run.objective || "목표 없음"}</td><td className="mono">{run.coordinator_handle ?? "제공되지 않음"}</td></tr>)}</tbody></table>{runs.length === 0 ? <p className="empty-copy">Orca Run이 없습니다.</p> : null}</div>{selectedRun ? <div className="card-body"><h3><span className="mono">{selectedRun}</span> Task</h3><RunTasks api={api} runId={selectedRun} /></div> : <p className="card-body muted">Run을 선택하면 native Task를 읽습니다.</p>}</section>
    <section className="card section-gap"><div className="card-head"><h2><SourceBadge source="orca" /> Dispatch</h2><span>{workers.length}건</span></div><div className="table-wrap"><table><thead><tr><th>Dispatch</th><th>liveness</th><th>Task</th><th>Run</th></tr></thead><tbody>{workers.map((item) => <tr key={item.dispatchId} onClick={() => navigate(`/work/orca/${encodeURIComponent(item.dispatchId)}`)}><td className="mono">{item.dispatchId}</td><td>{item.projection.liveness.verdict}</td><td>{item.projection.taskId}</td><td>{item.projection.runId}</td></tr>)}</tbody></table>{workers.length === 0 ? <p className="empty-copy">Orca Dispatch가 없습니다.</p> : null}</div></section></>}
    {pageState !== "ready" && pageState !== "loading" ? <AsyncState state={pageState} onRetry={() => void loadMore()} /> : null}
    {((filter !== "orca" && contextCursor) || (filter !== "hq" && workerCursor)) ? <button className="load-more" disabled={pageState === "loading"} onClick={() => void loadMore()}>{pageState === "loading" ? "읽는 중" : "다음 페이지 읽기"}</button> : null}
  </>;
}
