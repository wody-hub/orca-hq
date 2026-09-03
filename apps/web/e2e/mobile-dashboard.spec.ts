import { expect, test, type Page } from "@playwright/test";

const command = {
  id: "cmd-42", summary: "승인 대시보드를 배포합니다", projectKey: "hq", status: "진행 중", riskLevel: "L3", createdAt: "2026-09-01T08:00:00Z", updatedAt: "2026-09-01T08:10:00Z",
  project: { key: "hq", displayName: "Orca HQ", path: "/redacted/hq" }, routing: { score: 92, selectedReason: "보호된 경로와 일치", candidates: ["primary: 92"] },
  contract: { base: "main", allowedScope: ["apps/web/**"], prohibitedEffects: ["외부 메시지 전송"], testCommands: ["pnpm --filter @orca-hq/web test"] },
  tasks: [
    { id: "task-ui", title: "모바일 화면", status: "진행 중", dependencies: [], workerFamily: "gpt-5", verifierFamily: "gpt-5", dispatchId: "dispatch-42", dispatchStatus: "running", canStop: true, canRetry: true },
    { id: "task-verify", title: "검증 실행", status: "대기", dependencies: ["task-ui"], workerFamily: "claude", verifierFamily: "gpt-5", dispatchId: "dispatch-99", dispatchStatus: "queued", canStop: true, canRetry: true }
  ],
  verification: { status: "passed", commands: ["pnpm test"] }, diff: { summary: "3 files changed" },
  approval: { id: "approval-42", level: "L3", digest: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z", operationPhrase: "APPROVE RELEASE", status: "pending", permitted: true },
  audit: { reference: "audit:cmd-42", summary: "승인 대기" },
  approvalHistory: [
    { id: "approval-42", level: "L3", digest: "a".repeat(64), expiresAt: "2099-01-01T00:00:00Z", approvedAt: "", operationPhrase: "APPROVE RELEASE", status: "pending" },
    { id: "approval-expired", level: "L2", digest: "b".repeat(64), expiresAt: "2026-09-01T08:15:00Z", approvedAt: "2026-09-01T08:00:00Z", status: "expired" }
  ],
  auditHistory: [
    { reference: "audit:denied", subjectId: "approval-42", summary: "approval.denied", occurredAt: "2026-09-01T08:12:00Z" },
    { reference: "audit:expired", subjectId: "approval-expired", summary: "approval.expired", occurredAt: "2026-09-01T08:10:00Z" }
  ],
  delivery: [{ channel: "Slack", status: "pending" }, { channel: "Telegram", status: "sent" }]
};

async function mockApi(page: Page) {
  await page.route("**/auth/session", async (route) => route.fulfill({ status: 204, headers: { "x-csrf-token": "test-csrf" } }));
  await page.route("**/api/commands", async (route) => route.fulfill({ json: { commands: [command] } }));
  await page.route("**/api/commands/cmd-42", async (route) => route.fulfill({ json: command }));
}

for (const viewport of [{ name: "모바일", width: 390, height: 844 }, { name: "데스크톱", width: 1280, height: 800 }]) {
  test(`${viewport.name}에서 목록과 상세 증거가 수평 overflow 없이 표시된다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockApi(page);
    await page.goto("/commands");
    await expect(page.getByRole("link", { name: command.summary })).toBeVisible();
    await page.getByRole("link", { name: command.summary }).click();
    for (const evidence of ["경로 선택 근거", "검증 완료", "승인 이력", "감사 이력", "approval.denied", "Slack 전송 대기"]) {
      await expect(page.getByText(evidence, { exact: true })).toBeVisible();
    }
    const approvalCard = page.getByRole("region", { name: "승인" });
    for (const evidence of ["APPROVE RELEASE", "apps/web/**", "외부 메시지 전송", "pnpm --filter @orca-hq/web test"]) {
      await expect(approvalCard.getByText(evidence, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Dispatch 중지: 검증 실행 (dispatch-99)" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("키보드로 핵심 제어에 도달하면 focus outline이 표시된다", async ({ page }) => {
  await mockApi(page);
  await page.goto("/commands");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe("none");
  await page.getByRole("link", { name: command.summary }).click();
  const phrase = page.getByLabel("승인 문구 입력");
  for (let index = 0; index < 12 && !await phrase.evaluate((node) => document.activeElement === node); index += 1) {
    await page.keyboard.press("Tab");
  }
  expect(await phrase.evaluate((node) => document.activeElement === node)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe("none");
  await page.keyboard.type("APPROVE RELEASE");
  await page.keyboard.press("Tab");
  expect(await page.getByRole("button", { name: "L3 승인" }).evaluate((node) => document.activeElement === node)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe("none");
});

test("정확한 L3 문구만 승인 요청에 digest와 phrase로 전달한다", async ({ page }) => {
  let body = "";
  await mockApi(page);
  await page.route("**/api/approvals/approval-42/confirm", async (route) => { body = route.request().postData() ?? ""; await route.fulfill({ status: 200, json: { status: "approved" } }); });
  await page.goto("/commands");
  await page.getByRole("link", { name: command.summary }).click();
  const approve = page.getByRole("button", { name: "L3 승인" });
  await expect(approve).toBeDisabled();
  await page.getByLabel("승인 문구 입력").fill("approve release");
  await expect(approve).toBeDisabled();
  await page.getByLabel("승인 문구 입력").fill("APPROVE RELEASE");
  await expect(approve).toBeEnabled();
  await approve.click();
  expect(JSON.parse(body)).toEqual({ digest: "a".repeat(64), phrase: "APPROVE RELEASE" });
});
