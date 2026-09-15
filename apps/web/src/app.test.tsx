import { act, cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { OperationsApiError, type OperationsApi } from "./api.js";
import { OperationsMutationRegistry } from "./operations-state.js";

const at = "2026-09-15T09:00:00.000Z";
const evidence = { source: "orca_cli" as const, observedAt: at, verification: "observed" as const };
const hqEvidence = { ...evidence, source: "hq_store" as const };
const context = { contextId: "context-1", title: "정산 배치 확인", state: "executing", summary: "실제 HQ 문맥", projectIds: ["project-1"], jobIds: [], createdAt: at, updatedAt: at, lastSeq: 3 };
const worker = { dispatchId: "dispatch-1", projection: { dispatchId: "dispatch-1", taskId: "task-1", runId: "run-1", liveness: { verdict: "live" } } };
function apiFor(overrides: Partial<OperationsApi> = {}): OperationsApi {
  return {
    bootstrap: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ collectedAt: at, hq: { state: "running", capacity: { limit: 10, source: "default", active: 1, queued: 0, byState: { executing: 1 }, updateSupported: false, reason: "restart_safe_mutation_contract_unavailable" } }, orca: { state: "ready", reachable: true, version: "1.4.203", features: {} }, metrics: { tokens: { available: false, reason: "not_collected" }, cost: { available: false, reason: "not_collected" } } }),
    contexts: vi.fn().mockResolvedValue({ contexts: [context] }),
    context: vi.fn().mockResolvedValue({ source: "hq", context, evidence: hqEvidence }),
    events: vi.fn().mockResolvedValue({ events: [{ source: "hq", eventSource: "hq", seq: 3, eventKey: "event-3", requestId: "request-1", contextId: "context-1", kind: "worker.ready", occurredAt: at, payload: {}, receiptLink: { runId: "run-1", taskId: "task-1", dispatchId: "dispatch-1", terminalHandle: "term-1" } }], snapshots: [context], cursor: "3", compacted: false, oldestSeq: 1, latestSeq: 3 }),
    hqQuestions: vi.fn().mockResolvedValue({ source: "hq", questions: [], cursor: "3", compacted: false }),
    runs: vi.fn().mockResolvedValue({ source: "orca", runs: [{ id: "run-1", objective: "검증" }], evidence }),
    tasks: vi.fn().mockResolvedValue({ source: "orca", tasks: [{ id: "task-1", status: "open", run_id: "run-1" }], evidence }),
    workers: vi.fn().mockResolvedValue({ source: "orca", workers: [worker], page: { hasMore: false }, scope: { source: "all" }, evidence }),
    worker: vi.fn().mockResolvedValue({ source: "orca", dispatch: { id: "dispatch-1", runId: "run-1", taskId: "task-1", status: "dispatched" }, worker: { dispatchId: "dispatch-1", state: "ready", stage: "working", agentTerminalHandle: "term-1" }, projection: { dispatchId: "dispatch-1", taskId: "task-1", runId: "run-1", liveness: { verdict: "live" }, resource: { state: "owned", releaseState: "active" } }, observation: { status: "ready", exactWorker: true }, terminal: { handle: "term-1", incarnationId: "inc-1", connected: true, writable: true, executionHostId: "host-1", worktreeId: "wt-1" }, terminalResource: { id: "term-1", ownershipState: "owned", releaseState: "active" }, evidence }),
    output: vi.fn().mockResolvedValue({ source: "terminal", cursor: "opaque-1", archived: false, warnings: [], lines: ["real output"] }),
    orcaQuestions: vi.fn().mockResolvedValue({ source: "orca", messages: [], count: 0, support: { pendingState: { supported: false, reason: "inbox_has_no_authoritative_pending_question_state" } }, evidence }),
    resources: vi.fn().mockResolvedValue({ source: "orca", projects: [{ id: "project-1", hostScope: "covered", setups: [{ id: "setup-1", worktrees: [{ id: "wt-1", terminals: [{ handle: "term-1" }] }] }] }], evidence }),
    mutate: vi.fn(),
    ...overrides,
  };
}

describe("read-first operations console", () => {
  beforeEach(() => window.history.replaceState({}, "", "/overview"));
  afterEach(cleanup);

  it("keeps HQ and Orca sources separate and renders unavailable metrics honestly", async () => {
    render(<App api={apiFor()} />);
    expect(await screen.findByRole("heading", { name: "운영 개요" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /HQ 업무/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Orca 실행/ })).toBeTruthy();
    expect(screen.getAllByText("수집되지 않음")).toHaveLength(2);
  });

  it("filters the work list without merging source-specific rows", async () => {
    window.history.replaceState({}, "", "/work"); const user = userEvent.setup();
    render(<App api={apiFor()} />); await screen.findByText("정산 배치 확인");
    await user.click(screen.getByRole("button", { name: "Orca" }));
    expect(screen.queryByText("정산 배치 확인")).toBeNull();
    expect(screen.getByText("dispatch-1")).toBeTruthy();
  });

  it("searches source-specific work rows without changing their identities", async () => {
    // Break caught: visual search can merge or relabel HQ contexts and Orca Dispatch records.
    window.history.replaceState({}, "", "/work"); const user = userEvent.setup();
    render(<App api={apiFor()} />); await screen.findByText("정산 배치 확인");
    await user.type(screen.getByLabelText("업무 검색"), "dispatch-1");
    expect(screen.queryByText("정산 배치 확인")).toBeNull();
    expect(screen.getByText("dispatch-1")).toBeTruthy();
  });

  it("keeps unverifiable Orca inbox observations out of actionable attention", async () => {
    const orcaQuestions = vi.fn().mockResolvedValue({ source: "orca", messages: [{ id: "message-1", type: "question", subject: "historical question", body: "body" }], count: 1, support: { pendingState: { supported: false, reason: "inbox_has_no_authoritative_pending_question_state" } }, evidence });
    render(<App api={apiFor({ orcaQuestions })} />);
    expect(await screen.findByText("historical question")).toBeTruthy();
    const attention = screen.getByText("관심 필요").parentElement;
    expect(attention?.querySelector("strong")?.textContent).toBe("0");
    expect(screen.getByText(/pending 상태 판정 불가/)).toBeTruthy();
  });

  it.each([
    ["/overview", "101번째 이후 질문"],
    ["/questions", "101번째 이후 질문"],
    ["/evidence", "request-late"],
  ])("traverses empty filtered pages before showing current HQ questions on %s", async (path, expected) => {
    // Break caught: treating the first empty filtered page as exhaustion hides a later pending clarification.
    window.history.replaceState({}, "", path);
    const pending = { source: "hq" as const, kind: "router_clarification" as const, requestId: "request-late", sessionId: "session-1", body: "101번째 이후 질문", occurredAt: at, state: "awaiting_input", evidence: hqEvidence };
    const hqQuestions = vi.fn().mockImplementation((cursor = "0") => Promise.resolve(
      cursor === "0"
        ? { source: "hq", questions: [], cursor: "100", compacted: false }
        : cursor === "100"
          ? { source: "hq", questions: [pending], cursor: "102", compacted: false }
          : { source: "hq", questions: [pending], cursor: "102", compacted: false },
    ));
    render(<App api={apiFor({ hqQuestions })} />);
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(hqQuestions).toHaveBeenCalledWith("100", expect.any(AbortSignal));
  });

  it("labels a bounded HQ question scan as partial instead of claiming no questions", async () => {
    // Break caught: exhausting the client traversal budget must not produce authoritative empty-state copy.
    window.history.replaceState({}, "", "/questions");
    let page = 0;
    const hqQuestions = vi.fn().mockImplementation(() => Promise.resolve({ source: "hq", questions: [], cursor: String(++page * 100), compacted: false }));
    render(<App api={apiFor({ hqQuestions })} />);
    expect(await screen.findByText(/질문 범위 일부만 확인됨/)).toBeTruthy();
    expect(screen.queryByText("대기 질문 없음")).toBeNull();
    expect(hqQuestions.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("reconciles a question resolved between bounded snapshot passes", async () => {
    // Break caught: append-only pagination can keep an already-resolved question actionable.
    window.history.replaceState({}, "", "/questions");
    const pending = { source: "hq" as const, kind: "router_clarification" as const, requestId: "resolved-request", sessionId: "session-1", body: "이미 해결된 질문", occurredAt: at, state: "awaiting_input", evidence: hqEvidence };
    let call = 0;
    const hqQuestions = vi.fn().mockImplementation((cursor = "0") => {
      call++;
      const firstPass = call <= 2;
      return Promise.resolve({ source: "hq", questions: firstPass ? [pending] : [], cursor: cursor === "0" ? "1" : "1", compacted: false });
    });
    render(<App api={apiFor({ hqQuestions })} />);
    expect(await screen.findByText("대기 질문 없음")).toBeTruthy();
    expect(screen.queryByText("이미 해결된 질문")).toBeNull();
  });

  it("bounds the session registry without evicting pending or unknown identities", () => {
    // Break caught: bounded cleanup must refuse new work instead of dropping an ambiguity fence and minting a new ID.
    const registry = new OperationsMutationRegistry(2);
    const first = registry.reserve("stop:one")!;
    registry.pending("stop:one");
    const second = registry.reserve("stop:two")!;
    registry.settle("stop:two", { requestId: second.requestId, action: "stop", targetId: "two", state: "unknown", observedAt: at });
    expect(registry.reserve("stop:three")).toBeUndefined();
    expect(registry.reserve("stop:one")?.requestId).toBe(first.requestId);
    expect(registry.reserve("stop:two")?.requestId).toBe(second.requestId);
  });

  it("shows native Run rows and loads Task rows only for the selected Run", async () => {
    window.history.replaceState({}, "", "/work"); const user = userEvent.setup(); const api = apiFor();
    render(<App api={api} />);
    expect(await screen.findByText("검증")).toBeTruthy();
    expect(api.tasks).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /run-1/ }));
    expect((await screen.findAllByText("task-1")).length).toBeGreaterThan(1);
    expect(screen.getByText("open")).toBeTruthy();
    expect(api.tasks).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
  });

  it("advances list cursors once and appends the next page", async () => {
    window.history.replaceState({}, "", "/work"); const user = userEvent.setup();
    const next = { ...context, contextId: "context-2", title: "다음 실제 문맥" };
    const contexts = vi.fn().mockImplementation((cursor?: string) => Promise.resolve(cursor ? { contexts: [next] } : { contexts: [context], cursor: "100" }));
    render(<App api={apiFor({ contexts })} />); await screen.findByText("정산 배치 확인");
    await user.click(await screen.findByRole("button", { name: "다음 페이지 읽기" }));
    expect(await screen.findByText("다음 실제 문맥")).toBeTruthy();
    expect(contexts).toHaveBeenCalledWith("100", expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "다음 페이지 읽기" })).toBeNull();
  });

  it("preserves an exhausted page chain across an unchanged visible poll", async () => {
    window.history.replaceState({}, "", "/work"); const user = userEvent.setup();
    const next = { ...context, contextId: "context-2", title: "마지막 실제 문맥" };
    const contexts = vi.fn().mockImplementation((cursor?: string) => Promise.resolve(cursor ? { contexts: [next] } : { contexts: [context], cursor: "100" }));
    render(<App api={apiFor({ contexts })} />); await screen.findByText("정산 배치 확인");
    await user.click(await screen.findByRole("button", { name: "다음 페이지 읽기" }));
    expect(await screen.findByText("마지막 실제 문맥")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "다음 페이지 읽기" })).toBeNull();
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.findByText("마지막 실제 문맥");
    expect(screen.queryByRole("button", { name: "다음 페이지 읽기" })).toBeNull();
  });

  it("drops appended pages when a changed first page invalidates the cursor chain", async () => {
    window.history.replaceState({}, "", "/work"); const user = userEvent.setup();
    const next = { ...context, contextId: "context-2", title: "오래된 두 번째 페이지" };
    const replacement = { ...context, contextId: "context-3", title: "새 첫 페이지" };
    let changed = false;
    const contexts = vi.fn().mockImplementation((cursor?: string) => Promise.resolve(cursor ? { contexts: [next] } : changed ? { contexts: [replacement] } : { contexts: [context], cursor: "100" }));
    render(<App api={apiFor({ contexts })} />); await screen.findByText("정산 배치 확인");
    await user.click(await screen.findByRole("button", { name: "다음 페이지 읽기" }));
    expect(await screen.findByText("오래된 두 번째 페이지")).toBeTruthy();
    changed = true; document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByText("새 첫 페이지")).toBeTruthy();
    expect(screen.queryByText("오래된 두 번째 페이지")).toBeNull();
  });

  it("restores pagination after a changed first page supersedes an in-flight page", async () => {
    window.history.replaceState({}, "", "/work"); const user = userEvent.setup();
    const replacement = { ...context, contextId: "context-3", title: "교체된 첫 페이지" };
    const stale = { ...context, contextId: "context-2", title: "취소된 두 번째 페이지" };
    let changed = false;
    let resolvePage!: (value: Awaited<ReturnType<OperationsApi["contexts"]>>) => void;
    const contexts = vi.fn().mockImplementation((cursor?: string) => cursor
      ? new Promise((resolve) => { resolvePage = resolve; })
      : Promise.resolve(changed ? { contexts: [replacement], cursor: "200" } : { contexts: [context], cursor: "100" }));
    render(<App api={apiFor({ contexts })} />); await screen.findByText("정산 배치 확인");
    await user.click(await screen.findByRole("button", { name: "다음 페이지 읽기" }));
    const pageSignal = contexts.mock.calls.find(([cursor]) => cursor === "100")?.[1] as AbortSignal | undefined;
    changed = true; document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByText("교체된 첫 페이지")).toBeTruthy();
    expect(pageSignal?.aborted).toBe(true);
    expect((await screen.findByRole("button", { name: "다음 페이지 읽기" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => resolvePage({ contexts: [stale] }));
    expect(screen.queryByText("취소된 두 번째 페이지")).toBeNull();
  });

  it("loads Orca detail and logs only when its detail tab is selected", async () => {
    window.history.replaceState({}, "", "/work/orca/dispatch-1"); const api = apiFor(); const user = userEvent.setup();
    render(<App api={api} />); await screen.findByText("Dispatch / projection");
    expect(api.output).not.toHaveBeenCalled();
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.getAllByText("true").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("tab", { name: "터미널 로그" }));
    expect(await screen.findByText("real output")).toBeTruthy();
    expect(api.output).toHaveBeenCalledWith("dispatch-1", "terminal", undefined, expect.any(AbortSignal));
  });

  it("aborts and ignores stale Orca output when the selected source changes", async () => {
    window.history.replaceState({}, "", "/work/orca/dispatch-1"); const user = userEvent.setup();
    let resolveTerminal!: (value: Awaited<ReturnType<OperationsApi["output"]>>) => void;
    let resolveTranscript!: (value: Awaited<ReturnType<OperationsApi["output"]>>) => void;
    const output = vi.fn().mockImplementation((_id: string, source: string) => new Promise((resolve) => { if (source === "terminal") resolveTerminal = resolve; else resolveTranscript = resolve; }));
    render(<App api={apiFor({ output })} />); await screen.findByText("Dispatch / projection");
    await user.click(screen.getByRole("tab", { name: "터미널 로그" }));
    const terminalSignal = output.mock.calls[0]?.[3] as AbortSignal | undefined;
    await user.click(screen.getByRole("tab", { name: "대화 로그" }));
    expect(terminalSignal?.aborted).toBe(true);
    resolveTranscript({ source: "transcript", cursor: "transcript-1", archived: false, warnings: [], messages: [{ id: "message-1", role: "assistant", text: "fresh transcript" }] });
    expect(await screen.findByText("fresh transcript")).toBeTruthy();
    resolveTerminal({ source: "terminal", cursor: "terminal-1", archived: false, warnings: [], lines: ["stale terminal"] });
    await Promise.resolve();
    expect(screen.queryByText("stale terminal")).toBeNull();
  });

  it("shows only receipt-backed HQ event links and reports compaction", async () => {
    window.history.replaceState({}, "", "/work/hq/context-1");
    const api = apiFor({ events: vi.fn().mockResolvedValue({ events: [{ source: "hq", eventSource: "hq", seq: 3, eventKey: "event-3", requestId: "request-1", contextId: "context-1", kind: "history.compacted", occurredAt: at, payload: {} }], snapshots: [context], cursor: "3", compacted: true, oldestSeq: 3, latestSeq: 3 }) });
    render(<App api={api} />); await screen.findByText("history.compacted");
    expect(screen.queryByRole("button", { name: "연결된 Dispatch 보기" })).toBeNull();
    expect(screen.getByText("연결 영수증 아직 없음")).toBeTruthy();
    expect(screen.getAllByText(/compacted/).length).toBeGreaterThan(0);
  });

  it("aborts stale overview reads when navigation changes", async () => {
    const signals: AbortSignal[] = [];
    const api = apiFor({ status: vi.fn().mockImplementation((next?: AbortSignal) => { if (next) signals.push(next); return new Promise(() => undefined); }) });
    const user = userEvent.setup(); render(<App api={api} />);
    await user.click(screen.getByRole("link", { name: "운영 설정" }));
    expect(signals[0]?.aborted).toBe(true);
  });

  it("renders resource scope hierarchy and disabled capacity updates", async () => {
    window.history.replaceState({}, "", "/resources"); const user = userEvent.setup(); render(<App api={apiFor()} />);
    expect(await screen.findByText("setup-1")).toBeTruthy(); expect(screen.getByText("term-1")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "운영 설정" }));
    expect(await screen.findByRole("button", { name: "용량 변경 지원 안 함" })).toHaveProperty("disabled", true);
    expect(screen.getByText("restart_safe_mutation_contract_unavailable")).toBeTruthy();
  });

  it("shows actionable hq console guidance for failed claim authentication", async () => {
    render(<App api={apiFor({ bootstrap: vi.fn().mockRejectedValue(new OperationsApiError(401, "claim_expired")) })} />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("hq console")).toBeTruthy();
    expect(within(alert).queryByText(/secret/)).toBeNull();
  });

  it("reviews a full HQ request, restores focus on Escape, and submits one stable request ID", async () => {
    // Break caught: an unreviewed or regenerated browser request can bypass the idempotency contract.
    window.history.replaceState({}, "", "/compose"); const user = userEvent.setup();
    const mutate = vi.fn().mockImplementation(async (_path: string, _body: object, requestId: string) => ({ requestId, action: "hq_request", targetId: requestId, state: "accepted" as const, observedAt: at }));
    render(<App api={apiFor({ mutate })} />);
    await user.type(await screen.findByLabelText("세션 ID"), "session-1");
    await user.type(screen.getByLabelText("지시 내용"), "실제 요청을 검토하고 제출합니다.");
    const review = screen.getByRole("button", { name: "제출 전 검토" });
    await user.click(review);
    const dialog = await screen.findByRole("dialog", { name: "HQ 지시 검토" });
    expect(within(dialog).getByText("실제 요청을 검토하고 제출합니다.")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(review);
    await user.click(review);
    await user.click(await screen.findByRole("button", { name: "확인 후 제출" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const [path, body, requestId] = mutate.mock.calls[0]!;
    expect(path).toBe("/api/operations/hq/requests");
    expect(body).toEqual({ requestId, sessionId: "session-1", text: "실제 요청을 검토하고 제출합니다.", contextHint: { mode: "new" } });
    expect(requestId).toMatch(/^request_[0-9a-f-]{36}$/);
    expect(await screen.findByText(/접수되었지만 완료된 것은 아닙니다/)).toBeTruthy();
  });

  it("keeps unknown HQ mutation inspect-only without retrying or minting another ID", async () => {
    // Break caught: an ambiguous effect can be repeated under a new ID and execute twice.
    window.history.replaceState({}, "", "/compose"); const user = userEvent.setup();
    const mutate = vi.fn().mockResolvedValue({ requestId: "unknown-id", action: "hq_request", targetId: "unknown-id", state: "unknown", observedAt: at, detail: "effect_unverifiable" });
    render(<App api={apiFor({ mutate })} />);
    await user.type(await screen.findByLabelText("세션 ID"), "session-1");
    await user.type(screen.getByLabelText("지시 내용"), "모호한 결과를 다시 실행하지 않습니다.");
    await user.click(screen.getByRole("button", { name: "제출 전 검토" }));
    await user.click(await screen.findByRole("button", { name: "확인 후 제출" }));
    expect(await screen.findByText(/결과를 확인할 수 없습니다/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /다시|재시도|새 요청/ })).toBeNull();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("keeps an unknown stop fenced across evidence inspection and route departure", async () => {
    // Break caught: unmounting the state controls or the detail route must not erase an ambiguous effect identity.
    window.history.replaceState({}, "", "/work/orca/dispatch-1"); const user = userEvent.setup();
    const base = await apiFor().worker("dispatch-1");
    const safe = { ...base, observation: { ...base.observation, status: "live" }, terminalResource: { ...base.terminalResource, ownerDispatchId: "dispatch-1", terminalHandle: "term-1", endpointIncarnation: "pty-1:inc-1", releaseState: "not_requested" }, projection: { ...base.projection, resource: { state: "owned", ownerDispatchId: "dispatch-1", releaseState: "not_requested" } }, dispatch: { ...base.dispatch, processIncarnation: "pty-1:inc-1" }, terminal: base.terminal && { ...base.terminal, ptyId: "pty-1", executionHostId: "local" } };
    const mutate = vi.fn().mockImplementation(async (_path: string, _body: object, requestId: string) => ({ requestId, action: "stop", targetId: "dispatch-1", state: "unknown" as const, observedAt: at, detail: "effect_unverifiable" }));
    render(<App api={apiFor({ worker: vi.fn().mockResolvedValue(safe), mutate })} />);
    await screen.findByText("Dispatch / projection");
    await user.click(screen.getByRole("button", { name: "stop" }));
    await user.click(await screen.findByRole("button", { name: "확인 후 제출" }));
    const request = (await screen.findByText(/^request request_/)).textContent;
    await user.click(screen.getByRole("tab", { name: "증거" }));
    await user.click(screen.getByRole("tab", { name: "상태" }));
    expect(await screen.findByText(/결과를 확인할 수 없습니다/)).toBeTruthy();
    expect(screen.getByText(request!)).toBeTruthy();
    expect(screen.getByRole("button", { name: "stop" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("link", { name: "운영 개요" }));
    await screen.findByRole("heading", { name: "운영 개요" });
    act(() => { window.history.pushState({}, "", "/work/orca/dispatch-1"); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(await screen.findByText(/결과를 확인할 수 없습니다/)).toBeTruthy();
    expect(screen.getByText(request!)).toBeTruthy();
    expect(screen.getByRole("button", { name: "stop" })).toHaveProperty("disabled", true);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("reviews typed inject selection and discloses low-level unsupervised dispatch", async () => {
    // Break caught: the browser can omit the approved inject choice or imply worker-start ownership that dispatch does not create.
    window.history.replaceState({}, "", "/compose"); const user = userEvent.setup();
    const mutate = vi.fn().mockImplementation(async (_path: string, _body: object, requestId: string) => ({ requestId, action: "dispatch", targetId: "task-1", state: "accepted" as const, observedAt: at }));
    render(<App api={apiFor({ mutate })} />);
    await user.type(await screen.findByLabelText("Task ID"), "task-1");
    await user.type(screen.getByLabelText("Run ID"), "run-1");
    await user.type(screen.getByLabelText("Terminal handle"), "term-1");
    await user.type(screen.getByLabelText("Expected incarnation"), "inc-1");
    await user.click(screen.getByLabelText("기존 terminal agent에 inject"));
    await user.click(screen.getByRole("button", { name: "dispatch 검토" }));
    const dialog = await screen.findByRole("dialog", { name: "Orca dispatch 검토" });
    expect(within(dialog).getByText(/unsupervised/)).toBeTruthy();
    expect(within(dialog).getByText("true")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "확인 후 제출" }));
    expect(mutate.mock.calls[0]?.[1]).toEqual({ taskId: "task-1", runId: "run-1", terminalHandle: "term-1", expectedIncarnation: "inc-1", inject: true });
  });

  it("routes HQ clarification answers and observed Orca replies through their exact APIs", async () => {
    // Break caught: a native HQ answer can be sent to public reply without the trusted Run scope, or vice versa.
    window.history.replaceState({}, "", "/questions"); const user = userEvent.setup();
    const mutate = vi.fn().mockResolvedValue({ requestId: "accepted-id", action: "reply", targetId: "message-1", state: "accepted", observedAt: at });
    const hqQuestions = vi.fn().mockResolvedValue({ source: "hq", questions: [{ source: "hq", kind: "router_clarification", requestId: "request-1", sessionId: "session-1", body: "어느 프로젝트인가요?", occurredAt: at, state: "awaiting_input", evidence: hqEvidence }], cursor: "3", compacted: false });
    const orcaQuestions = vi.fn().mockResolvedValue({ source: "orca", messages: [{ id: "message-1", type: "question", subject: "배포할까요?", body: "확인이 필요합니다", run_id: "run-1" }], count: 1, support: { pendingState: { supported: false, reason: "inbox_has_no_authoritative_pending_question_state" } }, evidence });
    render(<App api={apiFor({ hqQuestions, orcaQuestions, mutate })} />);
    await user.type(await screen.findByLabelText("HQ 답변 request-1"), "project-1입니다.");
    await user.click(screen.getByRole("button", { name: "HQ 답변 검토 request-1" }));
    await user.click(await screen.findByRole("button", { name: "확인 후 제출" }));
    const hqCall = mutate.mock.calls[0]!;
    expect(hqCall[0]).toBe("/api/operations/hq/requests");
    expect(hqCall[1]).toEqual({ requestId: hqCall[2], sessionId: "session-1", text: "project-1입니다." });
    await user.type(screen.getByLabelText("Orca 답변 message-1"), "진행하세요.");
    await user.click(screen.getByRole("button", { name: "Orca 답변 검토 message-1" }));
    await user.click(await screen.findByRole("button", { name: "확인 후 제출" }));
    expect(mutate.mock.calls[1]?.[0]).toBe("/api/operations/orca/replies");
    expect(mutate.mock.calls[1]?.[1]).toEqual({ messageId: "message-1", runId: "run-1", body: "진행하세요." });
  });

  it("uses displayed Run and incarnation for reviewed follow-up and keeps unsafe lifecycle controls disabled", async () => {
    // Break caught: a control can target stale browser IDs or become enabled on non-live observation.
    window.history.replaceState({}, "", "/work/orca/dispatch-1"); const user = userEvent.setup();
    const mutate = vi.fn().mockResolvedValue({ requestId: "accepted-id", action: "followup", targetId: "dispatch-1", state: "accepted", observedAt: at });
    const base = await apiFor().worker("dispatch-1");
    const safe = { ...base, observation: { ...base.observation, status: "live" }, terminalResource: { ...base.terminalResource, ownerDispatchId: "dispatch-1", terminalHandle: "term-1", endpointIncarnation: "pty-1:inc-1", releaseState: "not_requested" }, projection: { ...base.projection, resource: { state: "owned", ownerDispatchId: "dispatch-1", releaseState: "not_requested" } }, dispatch: { ...base.dispatch, processIncarnation: "pty-1:inc-1" }, terminal: base.terminal && { ...base.terminal, ptyId: "pty-1", executionHostId: "local" } };
    render(<App api={apiFor({ worker: vi.fn().mockResolvedValue(safe), mutate })} />);
    await user.type(await screen.findByLabelText("후속 지시"), "focused tests를 실행하세요.");
    await user.click(screen.getByRole("button", { name: "후속 지시 검토" }));
    await user.click(await screen.findByRole("button", { name: "확인 후 제출" }));
    expect(mutate.mock.calls[0]?.[0]).toBe("/api/operations/orca/followups");
    expect(mutate.mock.calls[0]?.[1]).toEqual({ dispatchId: "dispatch-1", runId: "run-1", expectedIncarnation: "inc-1", body: "focused tests를 실행하세요." });
    expect(screen.getByRole("button", { name: "release" })).toHaveProperty("disabled", true);
  });
});
