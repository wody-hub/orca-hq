import type { OperationsApi } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import { SourceBadge } from "../components/source-badge.js";
import { useRead } from "../hooks.js";

export function OperationsResources({ api }: Readonly<{ api: OperationsApi }>) {
  const read = useRead((signal) => api.resources(signal), [api]);
  if (!read.data || read.state !== "ready") return <AsyncState state={read.state} onRetry={read.reload} />;
  return <><div className="view-head"><h1>프로젝트 / 터미널</h1><p>공개 Orca 인벤토리의 bounded hierarchy와 host scope를 그대로 표시합니다.</p></div><section className="card card-body"><h2><SourceBadge source="orca" /> 리소스 계층</h2>
    {read.data.projects.length === 0 ? <AsyncState state="empty" /> : <ul className="tree">{read.data.projects.map((project) => <li key={project.id}><div className="tree-row"><strong>Project</strong><span className="mono">{project.id}</span><span className={`badge ${project.hostScope === "covered" ? "ok" : "unknown"}`}>{project.hostScope}</span></div><ul>{project.setups.map((setup) => <li key={setup.id}><div className="tree-row"><strong>Setup</strong><span className="mono">{setup.id}</span>{setup.truncated ? <span className="badge unknown">truncated</span> : null}</div><ul>{setup.worktrees.map((worktree) => <li key={worktree.id}><div className="tree-row"><strong>Worktree</strong><span className="mono">{worktree.id}</span>{worktree.truncated ? <span className="badge unknown">truncated</span> : null}</div><ul>{worktree.terminals.map((terminal) => <li className="tree-row" key={terminal.handle}><strong>Terminal</strong><span className="mono">{terminal.handle}</span></li>)}</ul></li>)}</ul></li>)}</ul></li>)}</ul>}
    <p className="evidence-line">{read.data.evidence.source} · {read.data.evidence.verification} · {read.data.evidence.observedAt}</p>
  </section></>;
}
