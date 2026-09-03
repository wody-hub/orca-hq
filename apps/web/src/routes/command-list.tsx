import type { CommandSummary } from "../api.js";

export function CommandList({ commands, onSelect }: Readonly<{ commands: readonly CommandSummary[]; onSelect(id: string): void }>) {
  return <section className="card command-list" aria-labelledby="commands-heading">
    <h1 id="commands-heading">명령</h1>
    {commands.length === 0 ? <p>표시할 명령이 없습니다.</p> : <ul>{commands.map((command) => <li key={command.id}>
      <a href={`/commands/${encodeURIComponent(command.id)}`} onClick={(event) => { event.preventDefault(); onSelect(command.id); }}>{command.summary}</a>
      <p>{command.projectKey} · 위험 {command.riskLevel} · {command.status}</p><time dateTime={command.updatedAt}>최근 갱신 {command.updatedAt}</time>
    </li>)}</ul>}
  </section>;
}
