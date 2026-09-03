import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.js";
import { DashboardApiError, type DashboardApi, type CommandDetail } from "./api.js";

const detail: CommandDetail = {
  id: "cmd-42",
  summary: "승인 대시보드를 배포합니다",
  projectKey: "hq",
  status: "진행 중",
  createdAt: "2026-09-01T08:00:00Z",
  updatedAt: "2026-09-01T08:10:00Z",
  riskLevel: "L3",
  project: { key: "hq", displayName: "Orca HQ", path: "/redacted/hq" },
  routing: { score: 92, selectedReason: "보호된 경로와 일치", candidates: ["primary: 92", "fallback: 61"] },
  contract: {
    base: "main",
    allowedScope: ["apps/web/**"],
    prohibitedEffects: ["외부 메시지 전송"],
    testCommands: ["pnpm --filter @orca-hq/web test"]
  },
  tasks: [{ id: "task-ui", title: "모바일 화면", status: "진행 중", dependencies: [], workerFamily: "gpt-5", verifierFamily: "gpt-5", dispatchId: "dispatch-42", dispatchStatus: "running" }],
  verification: { status: "완료", commands: ["pnpm test"] },
  diff: { summary: "3 files changed, 20 insertions" },
  approval: { id: "approval-42", level: "L3", digest: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z", operationPhrase: "APPROVE RELEASE", status: "pending", permitted: true },
  audit: { reference: "audit:cmd-42", summary: "승인 대기 이벤트" },
  delivery: [{ channel: "Slack", status: "pending" }, { channel: "Telegram", status: "sent" }]
};

const secondTask = {
  id: "task-verify", title: "검증 실행", status: "대기", dependencies: ["task-ui"], workerFamily: "claude", verifierFamily: "gpt-5", dispatchId: "dispatch-99", dispatchStatus: "queued"
};

function apiFor(overrides: Partial<DashboardApi> = {}): DashboardApi {
  return {
    bootstrap: vi.fn().mockResolvedValue(undefined),
    listCommands: vi.fn().mockResolvedValue({ commands: [detail] }),
    getCommand: vi.fn().mockResolvedValue(detail),
    confirmApproval: vi.fn().mockResolvedValue(undefined),
    stopDispatch: vi.fn().mockResolvedValue(undefined),
    retryDispatch: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("private dashboard", () => {
  afterEach(cleanup);
  beforeEach(() => { window.history.replaceState({}, "", "/commands"); });

  it("shows verification and pending Slack delivery as independent evidence", async () => {
    const user = userEvent.setup();
    render(<App api={apiFor()} />);
    await screen.findByText("승인 대시보드를 배포합니다");
    await user.click(screen.getByRole("link", { name: "승인 대시보드를 배포합니다" }));
    expect(await screen.findByText("검증 완료")).toBeTruthy();
    expect(screen.getByText("Slack 전송 대기")).toBeTruthy();
  });

  it("allows L3 approval only for the exact server phrase and sends digest and phrase", async () => {
    const user = userEvent.setup();
    const api = apiFor();
    render(<App api={api} />);
    await screen.findByText("승인 대시보드를 배포합니다");
    await user.click(screen.getByRole("link", { name: "승인 대시보드를 배포합니다" }));
    expect(await screen.findByText("APPROVE RELEASE")).toBeTruthy();
    for (const text of ["main", "apps/web/**", "외부 메시지 전송", "pnpm --filter @orca-hq/web test"]) {
      expect(within(screen.getByRole("heading", { name: "승인" }).closest("section")!).getByText(text)).toBeTruthy();
    }
    const approve = await screen.findByRole("button", { name: "L3 승인" });
    const phrase = screen.getByLabelText("승인 문구 입력");
    await user.type(phrase, "approve release");
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    await user.clear(phrase);
    await user.type(phrase, "APPROVE RELEASE");
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    await user.click(approve);
    expect(api.confirmApproval).toHaveBeenCalledWith("approval-42", { digest: "a".repeat(64), phrase: "APPROVE RELEASE" });
  });

  it("renders complete evidence and sends only dispatch ids for control actions", async () => {
    const user = userEvent.setup();
    const api = apiFor();
    render(<App api={api} />);
    await screen.findByText("승인 대시보드를 배포합니다");
    await user.click(screen.getByRole("link", { name: "승인 대시보드를 배포합니다" }));
    for (const label of ["/redacted/hq", "경로 선택 근거", "worker: gpt-5 · verifier: gpt-5", "3 files changed, 20 insertions", "audit:cmd-42", "Telegram 전송 완료"]) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    expect(within(screen.getByRole("heading", { name: "Task DAG" }).closest("section")!).getByText("task-ui")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dispatch 중지: 모바일 화면 (dispatch-42)" }));
    expect(await screen.findByText("Dispatch 중지 요청이 완료되었습니다.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dispatch 재시도: 모바일 화면 (dispatch-42)" }));
    expect(api.stopDispatch).toHaveBeenCalledWith("dispatch-42");
    expect(api.retryDispatch).toHaveBeenCalledWith("dispatch-42");
  });

  it("explains unauthorized access without rendering server response text", async () => {
    render(<App api={apiFor({ listCommands: vi.fn().mockRejectedValue(new DashboardApiError(401)) })} />);
    expect(await screen.findByText("로그인 또는 세션을 다시 확인해 주세요.")).toBeTruthy();
    expect(screen.queryByText("secret server detail")).toBeNull();
  });

  it("makes expired, unauthorized, and pending approvals unavailable", async () => {
    const expired = { ...detail, approval: { ...detail.approval, expiresAt: "2020-01-01T00:00:00Z" } };
    render(<App api={apiFor({ getCommand: vi.fn().mockResolvedValue(expired) })} initialCommandId="cmd-42" />);
    expect((await screen.findByRole("button", { name: "L3 승인" })) as HTMLButtonElement).toHaveProperty("disabled", true);
    expect(screen.getByText("만료되어 승인할 수 없습니다.")).toBeTruthy();
  });

  it("does not present failed verification as complete", async () => {
    const failed = { ...detail, verification: { ...detail.verification, status: "실패" } };
    render(<App api={apiFor({ getCommand: vi.fn().mockResolvedValue(failed) })} initialCommandId="cmd-42" />);
    expect(await screen.findByText("검증 실패")).toBeTruthy();
    expect(screen.queryByText("검증 완료")).toBeNull();
  });

  it("controls only the selected task dispatch in a multi-task DAG", async () => {
    const user = userEvent.setup();
    const api = apiFor({ getCommand: vi.fn().mockResolvedValue({ ...detail, tasks: [...detail.tasks, secondTask] }) });
    render(<App api={api} initialCommandId="cmd-42" />);
    const stop = await screen.findByRole("button", { name: "Dispatch 중지: 검증 실행 (dispatch-99)" });
    const retry = screen.getByRole("button", { name: "Dispatch 재시도: 검증 실행 (dispatch-99)" });
    await user.click(stop);
    await user.click(retry);
    expect(api.stopDispatch).toHaveBeenCalledWith("dispatch-99");
    expect(api.retryDispatch).toHaveBeenCalledWith("dispatch-99");
    expect(api.stopDispatch).not.toHaveBeenCalledWith("dispatch-42");
    expect(api.retryDispatch).not.toHaveBeenCalledWith("dispatch-42");
  });

  it("places dispatch controls after approval and audit evidence", async () => {
    window.history.replaceState({}, "", "/commands/cmd-42");
    render(<App api={apiFor()} initialCommandId="cmd-42" />);
    await screen.findByRole("heading", { name: "Dispatch 제어" });

    const cardHeadings = Array.from(document.querySelectorAll("article.detail > section > h2"), (heading) => heading.textContent);
    expect(cardHeadings).toEqual(["경로 선택 근거", "변경 계약", "Task DAG", "diff/test", "승인", "감사 및 채널 전달", "Dispatch 제어"]);
  });

  it("returns to the command list when browser history goes back", async () => {
    const user = userEvent.setup();
    render(<App api={apiFor()} />);
    await user.click(await screen.findByRole("link", { name: "승인 대시보드를 배포합니다" }));
    expect(window.location.pathname).toBe("/commands/cmd-42");
    window.history.back();
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "명령" })).toBeTruthy();
    expect(window.location.pathname).toBe("/commands");
  });

  it("does not claim to be connected when loading fails", async () => {
    render(<App api={apiFor({ listCommands: vi.fn().mockRejectedValue(new DashboardApiError()) })} />);
    expect(await screen.findByText("정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.")).toBeTruthy();
    expect(screen.queryByText(/연결됨/)).toBeNull();
    expect(screen.getByText("갱신 실패 · 재시도 필요")).toBeTruthy();
  });

  it.each([
    [403, "이 정보에 접근할 권한이 없습니다."],
    [404, "요청한 명령을 찾을 수 없습니다."],
    [409, "제안이 변경되었습니다. 최신 정보를 확인해 주세요."],
    [undefined, "정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."]
  ])("shows a generalized error and retry for status %s", async (status, expected) => {
    render(<App api={apiFor({ listCommands: vi.fn().mockRejectedValue(new DashboardApiError(status)) })} />);
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });

  it("shows an empty command list", async () => {
    render(<App api={apiFor({ listCommands: vi.fn().mockResolvedValue({ commands: [] }) })} />);
    expect(await screen.findByText("표시할 명령이 없습니다.")).toBeTruthy();
  });

  it.each([
    ["권한 없음", { permitted: false }, "이 역할에는 승인 권한이 없습니다."],
    ["처리됨", { status: "approved" as const }, "이미 처리되어 승인할 수 없습니다."],
    ["문구 없음", { operationPhrase: undefined }, "서버가 승인 문구를 제공하지 않았습니다."]
  ])("makes %s approval unavailable", async (_caseName, approval, explanation) => {
    const command = { ...detail, approval: { ...detail.approval, ...approval } };
    render(<App api={apiFor({ getCommand: vi.fn().mockResolvedValue(command) })} initialCommandId="cmd-42" />);
    expect((await screen.findByRole("button", { name: "L3 승인" })) as HTMLButtonElement).toHaveProperty("disabled", true);
    expect(screen.getByText(explanation)).toBeTruthy();
  });

  it("keeps approval unavailable while a mutation is in progress", async () => {
    let resolveApproval: (() => void) | undefined;
    const api = apiFor({ confirmApproval: vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveApproval = resolve; })) });
    const user = userEvent.setup();
    render(<App api={api} initialCommandId="cmd-42" />);
    const approve = await screen.findByRole("button", { name: "L3 승인" });
    await user.type(screen.getByLabelText("승인 문구 입력"), "APPROVE RELEASE");
    await user.click(approve);
    expect(approve).toHaveProperty("disabled", true);
    resolveApproval?.();
  });

  it("allows approval to be retried after a mutation error", async () => {
    const user = userEvent.setup();
    const api = apiFor({ confirmApproval: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined) });
    render(<App api={api} initialCommandId="cmd-42" />);
    const approve = await screen.findByRole("button", { name: "L3 승인" });
    await user.type(screen.getByLabelText("승인 문구 입력"), "APPROVE RELEASE");
    await user.click(approve);
    expect(await screen.findByText("승인 요청을 처리하지 못했습니다.")).toBeTruthy();
    expect(approve).toHaveProperty("disabled", false);
    await user.click(approve);
    expect(api.confirmApproval).toHaveBeenCalledTimes(2);
  });

  it("keeps the command list after a stale detail request resolves", async () => {
    let resolveDetail: ((command: CommandDetail) => void) | undefined;
    const api = apiFor({ getCommand: vi.fn().mockImplementation(() => new Promise<CommandDetail>((resolve) => { resolveDetail = resolve; })) });
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole("link", { name: "승인 대시보드를 배포합니다" }));
    await user.click(screen.getByRole("link", { name: "Orca HQ" }));
    resolveDetail?.(detail);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(window.location.pathname).toBe("/commands");
    expect(screen.getByRole("heading", { name: "명령" })).toBeTruthy();
  });

  it("keeps the main content out of a broad live region", async () => {
    render(<App api={apiFor()} />);
    await screen.findByRole("heading", { name: "명령" });
    expect(document.querySelector("main")?.getAttribute("aria-live")).toBeNull();
  });

  it("bootstraps the same-origin session before loading a direct command URL", async () => {
    const api = apiFor();
    render(<App api={api} initialCommandId="cmd-42" />);
    await screen.findByText("승인 대시보드를 배포합니다");
    expect(api.bootstrap).toHaveBeenCalledOnce();
  });
});
