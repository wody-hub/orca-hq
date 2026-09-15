import { expect, test, type Page, type Route } from "@playwright/test";

const at = "2026-09-15T09:00:00.000Z";
const evidence = { source: "orca_cli", observedAt: at, verification: "observed" };
const hqEvidence = { ...evidence, source: "hq_store" };
const context = { contextId: "context-1", title: "정산 배치 확인", state: "executing", summary: "실제 HQ 문맥", projectIds: ["project-1"], jobIds: [], createdAt: at, updatedAt: at, lastSeq: 3 };
const worker = { dispatchId: "dispatch-1", projection: { dispatchId: "dispatch-1", taskId: "task-1", runId: "run-1", liveness: { verdict: "live" } } };
const workerDetail = { source: "orca", dispatch: { id: "dispatch-1", runId: "run-1", taskId: "task-1", status: "dispatched", processIncarnation: "pty-1:inc-1" }, worker: { dispatchId: "dispatch-1", state: "ready", stage: "working", agentTerminalHandle: "term-1" }, projection: { dispatchId: "dispatch-1", taskId: "task-1", runId: "run-1", liveness: { verdict: "live" }, resource: { state: "owned", ownerDispatchId: "dispatch-1", releaseState: "not_requested" } }, observation: { status: "live", exactWorker: true }, terminal: { handle: "term-1", incarnationId: "inc-1", ptyId: "pty-1", connected: true, writable: true, orphaned: false, executionHostId: "local", worktreeId: "wt-1" }, terminalResource: { id: "term-1", ownershipState: "owned", releaseState: "not_requested", ownerDispatchId: "dispatch-1", terminalHandle: "term-1", endpointIncarnation: "pty-1:inc-1" }, evidence };

async function fakeApi(page: Page) {
  const mutations: Array<{ path: string; body: unknown; requestId: string }> = [];
  await page.route("**/api/operations/**", async (route: Route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (request.method() === "POST") {
      const requestId = request.headers()["idempotency-key"] ?? "missing";
      mutations.push({ path, body: request.postDataJSON(), requestId });
      await route.fulfill({ status: 202, json: { requestId, action: path.split("/").at(-1) ?? "mutation", targetId: requestId, state: "accepted", observedAt: at } }); return;
    }
    let body: unknown;
    if (path.endsWith("/status")) body = { collectedAt: at, hq: { state: "running", capacity: { limit: 10, source: "default", active: 1, queued: 0, byState: { executing: 1 }, updateSupported: false, reason: "restart_safe_mutation_contract_unavailable" } }, orca: { state: "ready", reachable: true, version: "1.4.203", runtimeId: "runtime-1", features: { controls: { supported: true } } }, metrics: { tokens: { available: false, reason: "not_collected" }, cost: { available: false, reason: "not_collected" } } };
    else if (path.endsWith("/hq/contexts/context-1")) body = { source: "hq", context, evidence: hqEvidence };
    else if (path.endsWith("/hq/contexts")) body = { contexts: [context] };
    else if (path.endsWith("/hq/events")) body = { events: [{ source: "hq", eventSource: "hq", seq: 3, eventKey: "event-3", requestId: "request-1", contextId: "context-1", kind: "worker.ready", occurredAt: at, payload: {}, receiptLink: { runId: "run-1", taskId: "task-1", dispatchId: "dispatch-1", terminalHandle: "term-1" } }], snapshots: [context], cursor: "3", compacted: false, oldestSeq: 1, latestSeq: 3 };
    else if (path.endsWith("/hq/questions")) body = { source: "hq", questions: [{ source: "hq", kind: "router_clarification", requestId: "request-1", sessionId: "session-1", body: "어느 프로젝트인가요?", occurredAt: at, state: "awaiting_input", evidence: hqEvidence }], cursor: "3", compacted: false };
    else if (path.endsWith("/orca/runs")) body = { source: "orca", runs: [{ id: "run-1", objective: "검증", coordinator_handle: "term-owner", consumer_generation: 2 }], evidence };
    else if (path.endsWith("/orca/tasks")) body = { source: "orca", tasks: [{ id: "task-1", status: "pending", run_id: "run-1", created_by_terminal_handle: "term-owner", created_by_process_incarnation: "pty-owner:inc-owner", created_by_run_generation: 2 }], evidence };
    else if (path.endsWith("/orca/workers/dispatch-1/output")) body = url.searchParams.get("cursor") ? { source: url.searchParams.get("source"), archived: false, warnings: [], ...(url.searchParams.get("source") === "terminal" ? { lines: ["second output"] } : { messages: [{ id: "message-2", role: "assistant", text: "second transcript" }] }) } : { source: url.searchParams.get("source"), cursor: "next-log", archived: false, warnings: [], ...(url.searchParams.get("source") === "terminal" ? { lines: ["first output"] } : { messages: [{ id: "message-1", role: "assistant", text: "first transcript" }] }) };
    else if (path.endsWith("/orca/workers/dispatch-1")) body = workerDetail;
    else if (path.endsWith("/orca/workers")) body = { source: "orca", workers: [worker], page: { hasMore: false }, scope: { source: "all" }, evidence };
    else if (path.endsWith("/orca/questions")) body = { source: "orca", messages: [{ id: "message-1", type: "question", subject: "배포할까요?", body: "확인이 필요합니다", run_id: "run-1" }], count: 1, support: { pendingState: { supported: false, reason: "inbox_has_no_authoritative_pending_question_state" } }, evidence };
    else if (path.endsWith("/orca/resources")) body = { source: "orca", projects: [{ id: "project-1", hostScope: "covered", setups: [{ id: "setup-1", covered: true, truncated: false, worktrees: [{ id: "wt-1", terminals: [{ handle: "term-1" }] }] }] }], evidence };
    else { await route.fulfill({ status: 404, json: { error: "fake_route_missing" } }); return; }
    await route.fulfill({ status: 200, json: body });
  });
  return mutations;
}

for (const viewport of [{ name: "1440", width: 1440, height: 900 }, { name: "1280", width: 1280, height: 800 }, { name: "390", width: 390, height: 844 }]) {
  test(`${viewport.name} renders all console routes without overflow or browser errors`, async ({ page }) => {
    await page.setViewportSize(viewport); await fakeApi(page);
    const errors: string[] = []; const external: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { const url = new URL(request.url()); if (url.origin !== "http://127.0.0.1:4173") external.push(request.url()); });
    const routes = [["/overview", "운영 개요"], ["/work", "업무 목록"], ["/work/hq/context-1", "정산 배치 확인"], ["/work/orca/dispatch-1", "dispatch-1"], ["/compose", "새 지시"], ["/questions", "질문함"], ["/resources", "프로젝트 / 터미널"], ["/settings", "운영 설정"], ["/evidence", "리서치 / 기획 증거"]] as const;
    for (const [path, heading] of routes) {
      await page.goto(path); await expect(page.getByRole("heading", { name: new RegExp(heading) }).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
    await page.goto("/overview"); await page.screenshot({ path: `../../screenshots/2026-09-15-operations-${viewport.name}.png`, fullPage: true });
    expect(errors).toEqual([]); expect(external).toEqual([]);
  });
}

test("filters, searches, pages logs, and reviews controls with keyboard focus", async ({ page }) => {
  const mutations = await fakeApi(page);
  await page.goto("/work");
  await page.getByRole("button", { name: "Orca" }).click(); await expect(page.getByText("dispatch-1")).toBeVisible(); await expect(page.getByText("정산 배치 확인")).toHaveCount(0);
  await page.getByRole("button", { name: "전체" }).click(); await page.getByLabel("업무 검색").fill("context-1"); await expect(page.getByText("정산 배치 확인")).toBeVisible(); await expect(page.getByText("dispatch-1")).toHaveCount(0);
  await page.goto("/work/orca/dispatch-1"); await page.getByRole("tab", { name: "터미널 로그" }).click(); await expect(page.getByText("first output")).toBeVisible(); await page.getByRole("button", { name: "다음 로그 페이지" }).click(); await expect(page.getByText("second output")).toBeVisible();
  await page.goto("/compose"); await page.getByLabel("세션 ID").fill("session-1"); await page.getByLabel("지시 내용").fill("reviewed request"); const trigger = page.getByRole("button", { name: "제출 전 검토" }); await trigger.click(); await page.keyboard.press("Escape"); await expect(trigger).toBeFocused(); await trigger.click(); await page.getByRole("button", { name: "확인 후 제출" }).click(); await expect(page.getByText(/접수되었지만 완료된 것은 아닙니다/)).toBeVisible();
  expect(mutations).toHaveLength(1); expect(mutations[0]?.path).toBe("/api/operations/hq/requests"); expect(mutations[0]?.requestId).toMatch(/^request_[0-9a-f-]{36}$/);
  await page.goto("/settings"); await expect(page.getByRole("button", { name: "용량 변경 지원 안 함" })).toBeDisabled();
});
