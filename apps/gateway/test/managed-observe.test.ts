import { describe, expect, it, vi } from "vitest";

import { createOrcaObserver, type OrcaObserverRun } from "../src/managed-observe.js";

const project = {
  id: "repo-1",
  name: "샘플",
  absolutePath: "/workspace/sample",
  sensitivePaths: [".env", ".env.*", "**/*.pem"]
};

function receipt(result: unknown): string {
  return JSON.stringify({ id: "request", ok: true, result, _meta: {} });
}

describe("Orca observer", () => {
  it("reports every native worktree and recent terminal facts without inventing progress", async () => {
    // Break caught: the observer may silently pick one workspace or turn terminal activity into a made-up percentage.
    const run = vi.fn<OrcaObserverRun>(async (_command, args) => {
      if (args[0] === "worktree") return receipt({ worktrees: [
        { id: "wt-a", identity: "identity-a", path: "/workspace/sample/a", displayName: "기능 A", branch: "feature/a", workspaceStatus: "active", lastActivityAt: "2026-09-07T01:02:03Z" },
        { id: "wt-b", identity: "identity-b", path: "/workspace/sample/b", displayName: "기능 B", branch: "feature/b", workspaceStatus: "idle", lastActivityAt: "2026-09-06T01:02:03Z" }
      ] });
      if (args[0] === "terminal" && args[1] === "list" && args.includes("identity:identity-a")) {
        return receipt({ terminals: [{ handle: "term-a", title: "Codex", status: "running", updatedAt: "2026-09-07T01:02:03Z" }] });
      }
      if (args[0] === "terminal" && args[1] === "list") return receipt({ terminals: [] });
      if (args[0] === "terminal" && args[1] === "read") {
        return receipt({ terminal: "term-a", source: "stream", tail: [
          "테스트 실행 중",
          "authorization=Bearer super-secret-token",
          "로그: https://example.test/callback?access_token=secret"
        ], nextCursor: 42 });
      }
      throw new Error("unexpected command");
    });

    const text = await createOrcaObserver({ run }).observe(project, "status");

    expect(text).toContain("작업 공간 2개");
    expect(text).toContain("wt-a");
    expect(text).toContain("feature/a");
    expect(text).toContain("테스트 실행 중");
    expect(text).toContain("wt-b");
    expect(text).toContain("최근 출력이 없어 현재 단계를 확정할 수 없습니다");
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("access_token");
    expect(text).not.toMatch(/\b\d{1,3}%/);
    expect(run).toHaveBeenCalledWith("orca", ["worktree", "list", "--repo", "id:repo-1", "--limit", "50", "--json"], expect.any(Object));
    expect(run).toHaveBeenCalledWith("orca", ["terminal", "read", "--terminal", "term-a", "--limit", "40", "--json"], expect.any(Object));
  });

  it("uses metadata only for protected HQ projects", async () => {
    // Break caught: terminal previews can repeat protected file content even when no direct file read is attempted.
    const run = vi.fn<OrcaObserverRun>(async (_command, args) => {
      if (args[0] === "worktree") return receipt({ worktrees: [
        { id: "wt-protected", identity: "protected-identity", path: "/Users/test/orca/workspaces/orca-hq/task", branch: "task", workspaceStatus: "active" }
      ] });
      if (args[0] === "terminal" && args[1] === "list") {
        return receipt({ terminals: [{ handle: "term-protected", title: "Codex", status: "running" }] });
      }
      throw new Error("terminal content must not be read");
    });

    const text = await createOrcaObserver({ run }).observe({
      ...project,
      absolutePath: "/Users/test/orca/workspaces/orca-hq",
      sensitivePaths: ["docs/private-pilot-roadmap.md"]
    }, "status");

    expect(text).toContain("보호 프로젝트");
    expect(text).toContain("메타데이터만 표시");
    expect(text).toContain("term-protected");
    expect(run.mock.calls.some(([, args]) => args[1] === "read" || args[1] === "show")).toBe(false);
  });

  it("lists all review candidates and requires an explicit ID or path when the target is ambiguous", async () => {
    // Break caught: reviewing an arbitrary first worktree can report on the wrong external Orca task.
    const run = vi.fn<OrcaObserverRun>(async (_command, args) => {
      if (args[0] === "worktree") return receipt({ worktrees: [
        { id: "wt-a", identity: "identity-a", path: "/workspace/sample/a", branch: "feature/a", workspaceStatus: "active" },
        { id: "wt-b", identity: "identity-b", path: "/workspace/sample/b", branch: "feature/b", workspaceStatus: "idle" }
      ] });
      if (args[0] === "terminal") return receipt({ terminals: [] });
      throw new Error("unexpected command");
    });
    const summarize = vi.fn(async () => "모델 리뷰");

    const text = await createOrcaObserver({ run, summarize }).observe(project, "review");

    expect(text).toContain("wt-a");
    expect(text).toContain("/workspace/sample/a");
    expect(text).toContain("wt-b");
    expect(text).toContain("ID 또는 경로를 지정");
    expect(summarize).not.toHaveBeenCalled();
    expect(run.mock.calls.some(([command]) => command === "git")).toBe(false);
    expect(run.mock.calls.some(([, args]) => args[1] === "read" || args[1] === "show")).toBe(false);
  });

  it("returns a native review target for one workspace without starting a second review engine", async () => {
    // Break caught: a review request may duplicate Orca's worker by spawning a local summarizer.
    const run = vi.fn<OrcaObserverRun>(async (_command, args) => {
      if (args[0] === "worktree") return receipt({ worktrees: [
        { id: "wt-only", identity: "only", path: "/workspace/sample/only", branch: "feature/only", workspaceStatus: "active" }
      ] });
      if (args[0] === "terminal") return receipt({ terminals: [{ handle: "term-only", status: "running" }] });
      throw new Error("unexpected command");
    });
    const summarize = vi.fn(async () => "모델 리뷰");

    const text = await createOrcaObserver({ run, summarize }).observe(project, "review");

    expect(text).toContain("wt-only");
    expect(text).toContain("/workspace/sample/only");
    expect(text).toContain("Orca 작업으로 검토를 요청");
    expect(summarize).not.toHaveBeenCalled();
    expect(run.mock.calls.some(([command]) => command === "git")).toBe(false);
  });

  it("fails closed on malformed Orca output without echoing it", async () => {
    // Break caught: provider output containing credentials may escape through parse errors.
    const run = vi.fn<OrcaObserverRun>(async () => "not-json token=provider-secret");

    await expect(createOrcaObserver({ run }).observe(project, "status"))
      .rejects.toThrow("Orca 상태 응답을 확인할 수 없습니다");
  });
});
