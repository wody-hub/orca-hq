import { describe, expect, it } from "vitest";

import { runPilotAcceptance } from "../../packages/test-support/src/index.js";

describe("scripted restart chaos", () => {
  it("reconciles durable state without duplicate dispatch after every simulated restart", async () => {
    // Break caught: a restart loses durable state, duplicates execution, or treats uncertainty as success.
    const report = await runPilotAcceptance({ runs: 1, runIdPrefix: "chaos-restart" });
    const scenario = report.scenarios.find(({ id }) => id === "restart_reconciliation");

    expect(scenario).toMatchObject({ status: "pass" });
    expect(scenario?.evidence).toEqual(expect.arrayContaining([
      "simulated_gateway_process_loss:state_preserved",
      "simulated_orca_restart:resumable",
      "simulated_mac_launchd_restart:review_required",
      "fake_slack_disconnect_reconnect:cursor_preserved",
      "fake_telegram_disconnect_reconnect:cursor_preserved",
      "fake_tailscale_disconnect_reconnect:approval_preserved",
      "durable_state:command,approval,lock,cursor,Outbox",
      "duplicate_dispatches:0"
    ]));
    expect(report.restartRecoveryRate).toBe(1);
    expect(report.duplicateExecutions).toBe(0);
  });
});
