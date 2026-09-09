import { describe, it, expect, vi } from "vitest";
import { createContextRouter } from "../src/context-router.js";
const contexts = [
  {
    contextId: "ctx_a",
    title: "GH 법령 이력",
    summary: "검토 결과",
    projectIds: ["gh"],
    jobIds: ["job_a"],
    updatedAt: "2026-09-08",
    originSessionId: "session",
  },
];
describe("context routing boundary", () => {
  it("routes the exact Korean global job-list request to a validated read-only lookup without consulting the model", async () => {
    const propose = vi.fn(async () => ({
      parts: [],
      reply: "현재 작업 정보가 없습니다.",
    }));
    const router = createContextRouter({ propose });

    await expect(
      router.route(
        {
          requestId: "global-jobs",
          sessionId: "session",
          text: "지금 돌아가고 있는 작업 내용들 리스트업해줘",
        },
        contexts,
      ),
    ).resolves.toEqual({ parts: [], lookup: { action: "jobs.list" } });
    expect(propose).not.toHaveBeenCalled();
  });
  it("keeps requests to build a job-list screen on the execution route", async () => {
    const propose = vi.fn(async () => ({
      parts: [
        {
          action: "new",
          title: "작업 목록 화면",
          objective: "작업 목록 화면 개발",
          projectIds: ["gh"],
          text: "작업 목록 화면을 개발해줘",
        },
      ],
    }));
    const router = createContextRouter({ propose });

    const decision = await router.route(
      {
        requestId: "build-job-list",
        sessionId: "session",
        text: "작업 목록 화면을 개발해줘",
      },
      contexts,
    );

    expect(decision.parts[0]).toMatchObject({
      action: "new",
      title: "작업 목록 화면",
    });
    expect(propose).toHaveBeenCalledOnce();
  });
  it("does not intercept a review of a job-list screen as a global lookup", async () => {
    const propose = vi.fn(async () => ({
      parts: [
        {
          action: "new",
          title: "작업 목록 화면 오류",
          objective: "화면 오류 검토",
          projectIds: ["gh"],
          text: "현재 작업 목록 화면의 오류를 검토해줘",
        },
      ],
    }));
    const router = createContextRouter({ propose });

    const decision = await router.route(
      {
        requestId: "review-job-list-screen",
        sessionId: "session",
        text: "현재 작업 목록 화면의 오류를 검토해줘",
      },
      contexts,
    );

    expect(decision.parts[0]).toMatchObject({
      action: "new",
      title: "작업 목록 화면 오류",
    });
    expect(propose).toHaveBeenCalledOnce();
  });
  it("accepts semantic global-list variants only as the read-only lookup action", async () => {
    const router = createContextRouter({
      propose: async () => ({
        parts: [],
        lookup: { action: "jobs.list" },
      }),
    });

    await expect(
      router.route(
        {
          requestId: "semantic-global-jobs",
          sessionId: "session",
          text: "현재 진행 중인 것들을 전부 알려줘",
        },
        contexts,
      ),
    ).resolves.toEqual({ parts: [], lookup: { action: "jobs.list" } });
  });
  it("uses semantic structured routing for independent features in the same project", async () => {
    const propose = vi.fn(async () => ({
      parts: [
        {
          action: "new",
          title: "GH 자체안전점검",
          objective: "검토",
          projectIds: ["gh"],
          text: "GH 자체안전점검 검토",
        },
      ],
    }));
    const router = createContextRouter({ propose });
    expect(
      (
        await router.route(
          {
            requestId: "r",
            sessionId: "session",
            text: "GH 자체안전점검 검토",
          },
          contexts,
        )
      ).parts[0]?.action,
    ).toBe("new");
    expect(propose).toHaveBeenCalled();
  });
  it("honors explicit continuation and rejects model IDs outside session candidates", async () => {
    const propose = vi.fn(async () => ({
      parts: [{ action: "continue", contextId: "ctx_other", text: "수정" }],
    }));
    const router = createContextRouter({ propose });
    expect(
      (
        await router.route(
          { requestId: "r", sessionId: "session", text: "/context ctx_a 수정" },
          contexts,
        )
      ).parts[0],
    ).toMatchObject({ action: "continue", contextId: "ctx_a" });
    expect(propose).not.toHaveBeenCalled();
    await expect(
      router.route(
        { requestId: "r2", sessionId: "session", text: "수정" },
        contexts,
      ),
    ).rejects.toThrow("context_choice_not_allowed");
  });
  it.each([
    ["/context ctx_a status", "status"],
    ["/context ctx_a stop", "stop"]
  ] as const)("preserves inline native worker control for %s", async (text, action) => {
    const propose = vi.fn();
    const router = createContextRouter({ propose });
    await expect(router.route(
      { requestId: `control-${action}`, sessionId: "session", text },
      contexts
    )).resolves.toEqual({ parts: [], control: { action, contextId: "ctx_a" } });
    expect(propose).not.toHaveBeenCalled();
  });
  it("returns clarification without executing and retains original constraints for split tasks", async () => {
    const router = createContextRouter({
      propose: async () => ({ parts: [], question: "어느 기능을 수정할까요?" }),
    });
    expect(
      await router.route(
        { requestId: "r", sessionId: "session", text: "수정" },
        contexts,
      ),
    ).toMatchObject({ parts: [], question: "어느 기능을 수정할까요?" });
  });

  it("rejects mixed inline replies and native work parts", async () => {
    const router = createContextRouter({
      propose: async () => ({
        parts: [{
          action: "new",
          title: "Gateway review",
          objective: "Review the gateway source",
          projectIds: ["gh"],
          text: "Review the gateway source"
        }],
        reply: "The gateway looks fine."
      })
    });

    await expect(router.route(
      { requestId: "review", sessionId: "session", text: "Review the gateway source" },
      contexts
    )).rejects.toThrow("ambiguous_context_choice");
  });

});
