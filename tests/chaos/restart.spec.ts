import { describe, expect, it } from "vitest";

import * as pilotSupport from "../../packages/test-support/src/index.js";

const { runPilotAcceptance } = pilotSupport;

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
      "fake_tailscale_disconnect_reconnect:approval_preserved"
    ]));
    expect(scenario?.measurements).toEqual({
      durableSnapshotsMatched: 1,
      providerDispatchCallsBefore: 2,
      providerDispatchCallsAfter: 2,
      uncertainWorkerReleases: 0
    });
    expect(report.restartRecoveryRate).toBe(1);
    expect(report.duplicateExecutions).toBe(0);
  });

  it("compares reopened durable rows and derives duplicate dispatches from provider calls", async () => {
    // Break caught: restart safety can compare an untouched local literal and report duplicate_dispatches:0 without observing launches.
    const simulateDurableRestart = (pilotSupport as unknown as {
      simulateDurableRestart?: () => Promise<{
        before: unknown;
        after: unknown;
        reconcileStates: readonly string[];
        providerDispatchCallsBefore: number;
        providerDispatchCallsAfter: number;
        uncertainWorkerReleases: number;
      }>;
    }).simulateDurableRestart;
    expect(typeof simulateDurableRestart).toBe("function");
    if (simulateDurableRestart === undefined) return;

    const result = await simulateDurableRestart();
    expect(result.after).toEqual(result.before);
    expect(result.reconcileStates).toEqual(["resumable", "review_required"]);
    expect(result.providerDispatchCallsBefore).toBe(2);
    expect(result.providerDispatchCallsAfter).toBe(2);
    expect(result.uncertainWorkerReleases).toBe(0);
  });
});
