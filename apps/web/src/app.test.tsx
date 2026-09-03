import { cleanup, render, screen } from "@testing-library/react";
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
    for (const label of ["/redacted/hq", "경로 선택 근거", "main", "apps/web/**", "외부 메시지 전송", "task-ui", "worker: gpt-5 · verifier: gpt-5", "3 files changed, 20 insertions", "audit:cmd-42", "Telegram 전송 완료"]) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    await user.click(screen.getByRole("button", { name: "Dispatch 중지" }));
    expect(await screen.findByText("Dispatch 중지 요청이 완료되었습니다.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dispatch 재시도" }));
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

  it("bootstraps the same-origin session before loading a direct command URL", async () => {
    const api = apiFor();
    render(<App api={api} initialCommandId="cmd-42" />);
    await screen.findByText("승인 대시보드를 배포합니다");
    expect(api.bootstrap).toHaveBeenCalledOnce();
  });
});
