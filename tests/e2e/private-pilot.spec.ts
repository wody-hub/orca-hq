import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  PILOT_CRITERION_IDS,
  runPilotAcceptance
} from "../../packages/test-support/src/index.js";

const execFileAsync = promisify(execFile);

describe("deterministic private-pilot acceptance", () => {
  it("maps every scripted criterion exactly once without claiming live readiness", async () => {
    // Break caught: a criterion disappears, is duplicated, or simulated evidence is reported as live proof.
    const report = await runPilotAcceptance({ runs: 1, runIdPrefix: "e2e-criteria" });

    expect(report.evidenceMode).toBe("deterministic_simulation");
    expect(report.pilotReady).toBe(false);
    expect(report.criteria.map(({ id }) => id)).toEqual(PILOT_CRITERION_IDS);
    expect(new Set(report.criteria.map(({ id }) => id)).size).toBe(12);
    expect(report.criteria).toHaveLength(12);
    expect(report.criteria.every(({ status }) => status === "pass")).toBe(true);
    expect(report.criteria.every(({ evidence }) =>
      evidence.some((item) => item.includes("live_gate_required"))
    )).toBe(true);
  });

  it("drives Korean Telegram voice through the public boundaries to verified L1 evidence", async () => {
    // Break caught: transcript confirmation, routing, isolation, cross-model verification, or audit linkage is skipped.
    const report = await runPilotAcceptance({ runs: 1, runIdPrefix: "e2e-korean" });
    const scenario = report.scenarios.find(({ id }) => id === "korean_voice_verified_l1");

    expect(scenario).toMatchObject({ status: "pass" });
    expect(scenario?.evidence).toEqual(expect.arrayContaining([
      "telegram_fake_voice:confirmation_required",
      "transcript_approved:샌드박스 프런트엔드 테스트를 수정해줘",
      "route_selected:sandbox-web:alias:샌드박스 프런트엔드",
      "plan_preview:risk=L1:scope=src/**",
      "worktree:isolated",
      "worker_pair:codex->claude",
      "final_state:verified_success",
      "audit_linkage:route,policy,approval,Dispatch,worker,verifier,delivery"
    ]));
    expect(report.verifiedSuccessCoverage).toBe(1);
  });

  it("proves both model-family directions and blocks failed verification success", async () => {
    // Break caught: Claude cannot implement with Codex verification, or a failed verifier emits success.
    const report = await runPilotAcceptance({ runs: 1, runIdPrefix: "e2e-models" });
    const reverse = report.scenarios.find(({ id }) => id === "reverse_model_verification");
    const failures = report.scenarios.find(({ id }) => id === "agent_failure_safety");

    expect(reverse?.evidence).toContain("worker_pair:claude->codex");
    expect(reverse?.evidence).toContain("final_state:verified_success");
    expect(failures?.evidence).toEqual(expect.arrayContaining([
      "codex_auth_loss:queue_review:no_claude_hq_takeover",
      "worker_launch:safe_retry_count=1",
      "worker_launch:retry_exhausted:third_attempt_blocked:intervention_required",
      "verification_cycle_2:intervention_required:no_success_outbox"
    ]));
  });

  it("writes one bounded machine-readable report and rejects unsafe arguments", async () => {
    // Break caught: the runner accepts unbounded paths or writes a report that can be mistaken for live evidence.
    const output = `.artifacts/pilot-script-test-${process.pid}.json`;
    await rm(output, { force: true });
    try {
      await execFileAsync(process.execPath, [
        "scripts/run-pilot-acceptance.mjs",
        "--runs",
        "1",
        "--output",
        output
      ], { encoding: "utf8" });
      const report = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
      expect(report).toMatchObject({
        evidenceMode: "deterministic_simulation",
        pilotReady: false,
        restartRecoveryRate: 1,
        duplicateExecutions: 0,
        approvalBypasses: 0,
        verifiedSuccessCoverage: 1
      });

      await expect(execFileAsync(process.execPath, [
        "scripts/run-pilot-acceptance.mjs",
        "--runs",
        "0",
        "--output",
        "../pilot-report.json"
      ], { encoding: "utf8" })).rejects.toMatchObject({
        code: 2,
        stderr: "pilot_acceptance_invalid_arguments\n"
      });
    } finally {
      await rm(output, { force: true });
    }
  }, 20_000);
});
