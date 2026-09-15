export function SourceBadge({ source }: Readonly<{ source: "hq" | "orca" }>) {
  return <span className={`badge ${source}`}>{source === "hq" ? "HQ" : "Orca"}</span>;
}
