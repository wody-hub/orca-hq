import { describe, expect, it } from "vitest";
import { createObservedJobListReader } from "../src/managed-runtime.js";
import type { CommandJob } from "../src/managed-commands.js";

const job = (
  input: Partial<CommandJob> & Pick<CommandJob, "id" | "state">,
): CommandJob => ({
  projectId: "gh",
  projectName: "GH",
  prompt: "work",
  createdAt: "2026-09-08T03:00:00.000Z",
  updatedAt: "2026-09-08T04:00:00.000Z",
  ...input,
});

describe("managed runtime global job observation", () => {
  it("lists every cached active job separately from recent terminal jobs and labels snapshot freshness", async () => {
    const readJobs = createObservedJobListReader({
      listActiveCached: () => [
        job({ id: "task_old_active", state: "running", prompt: "older" }),
        job({ id: "task_recovery", state: "recovery_required" }),
      ],
      listCached: () => [
        job({ id: "task_recent_done", state: "succeeded" }),
        job({ id: "task_old_active", state: "running", prompt: "duplicate" }),
      ],
    });

    const result = await readJobs("request-global-list");

    expect(result.text).toContain("현재 활성 작업 2개");
    expect(result.text).toContain("작업 task_old_active · GH · 실행 중");
    expect(result.text).toContain("작업 task_recovery · GH · 복구 확인 필요");
    expect(result.text.match(/작업 task_old_active/g)).toHaveLength(1);
    expect(result.text).toContain("최근 종료 작업 1개");
    expect(result.text).toContain("작업 task_recent_done · GH · 완료");
    expect(result.text).toContain(
      "최근 기록된 작업 업데이트: 2026-09-08T04:00:00.000Z",
    );
    expect(result.text).toContain("그 이후 상태가 변경되었을 수 있습니다");
    expect(result.text.indexOf("그 이후 상태가 변경되었을 수 있습니다")).toBeLessThan(
      result.text.indexOf("작업 task_old_active"),
    );
  });

  it("does not claim a live empty result when no cached jobs have been observed", async () => {
    const readJobs = createObservedJobListReader({
      listActiveCached: () => [],
      listCached: () => [],
    });

    const result = await readJobs("request-global-empty");

    expect(result.text).toContain("현재 활성 작업 0개 (마지막 관찰 스냅샷 기준)");
    expect(result.text).toContain("저장된 관찰 기록이 없습니다");
    expect(result.text).not.toContain("현재 실행 중인 작업이 없습니다");
  });
});
