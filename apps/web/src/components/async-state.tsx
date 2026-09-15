import type { ReactNode } from "react";

export type LoadState = "loading" | "ready" | "empty" | "disconnected" | "error" | "unknown";
export function AsyncState({ state, children, onRetry }: Readonly<{ state: LoadState; children?: ReactNode; onRetry?: () => void }>) {
  if (state === "ready") return <>{children}</>;
  const labels: Record<Exclude<LoadState, "ready">, string> = {
    loading: "실제 운영 데이터를 불러오는 중입니다.",
    empty: "표시할 운영 데이터가 없습니다.",
    disconnected: "운영 브리지 연결이 끊겼습니다. hq console을 다시 실행해 주세요.",
    error: "데이터 형식 또는 요청을 확인할 수 없습니다.",
    unknown: "현재 상태를 판정할 수 없습니다. 자동 조작 없이 관찰만 계속합니다.",
  };
  return <section className={`async-state ${state}`} role={state === "loading" ? "status" : "alert"}>
    <strong>{labels[state]}</strong>
    {onRetry && state !== "loading" ? <button type="button" onClick={onRetry}>다시 읽기</button> : null}
  </section>;
}
