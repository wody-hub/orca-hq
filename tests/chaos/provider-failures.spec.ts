import { describe, expect, it } from "vitest";

import { runPilotAcceptance } from "../../packages/test-support/src/index.js";

describe("scripted provider and policy failures", () => {
  it("deduplicates provider delivery and rejects every Telegram privileged operation", async () => {
    // Break caught: replay creates another command/DAG, or Telegram gains privileged approval authority.
    const report = await runPilotAcceptance({ runs: 1, runIdPrefix: "chaos-provider" });
    const duplicate = report.scenarios.find(({ id }) => id === "duplicate_provider_delivery");
    const telegram = report.scenarios.find(({ id }) => id === "telegram_privileged_denials");

    expect(duplicate?.evidence).toEqual(expect.arrayContaining([
      "fake_slack_duplicate:commands=1:dags=1:executions=1",
      "fake_telegram_duplicate:commands=1:dags=1:executions=1"
    ]));
    expect(telegram?.evidence).toContain(
      "telegram_denied:commit,push,PR,merge,deploy,database,deletion,secret"
    );
    expect(report.approvalBypasses).toBe(0);
  });

  it("binds Slack and Tailscale approval to exact unexpired digests", async () => {
    // Break caught: a changed or expired digest is accepted on either privileged channel.
    const report = await runPilotAcceptance({ runs: 1, runIdPrefix: "chaos-approval" });
    const scenario = report.scenarios.find(({ id }) => id === "digest_bound_approvals");

    expect(scenario?.evidence).toEqual(expect.arrayContaining([
      "slack_approval:exact_digest:accepted",
      "slack_approval:changed_digest:rejected",
      "slack_approval:expired_digest:rejected",
      "tailscale_approval:exact_digest:accepted",
      "tailscale_approval:changed_digest:rejected",
      "tailscale_approval:expired_digest:rejected"
    ]));
  });

  it("blocks ambiguous or dirty dispatch and delivers recovered Outbox exactly once", async () => {
    // Break caught: unsafe project state dispatches automatically, or Outbox claim recovery double-delivers.
    const report = await runPilotAcceptance({ runs: 1, runIdPrefix: "chaos-safety" });
    const safety = report.scenarios.find(({ id }) => id === "pre_dispatch_safety");
    const outbox = report.scenarios.find(({ id }) => id === "outbox_recovery_exactly_once");

    expect(safety?.evidence).toEqual(expect.arrayContaining([
      "wrong_project_ambiguity:clarification_required",
      "dirty_checkout:review_required:dispatches=0"
    ]));
    expect(outbox?.evidence).toEqual(expect.arrayContaining([
      "pending_outbox:provider_recovered",
      "claim_restart:deliveries=1"
    ]));
  });
});
