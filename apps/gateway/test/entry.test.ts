import { describe, expect, it } from "vitest";

import { run } from "../src/entry.js";
import type { GatewayProductionDependencies } from "../src/production.js";

describe("gateway production entry", () => {
  it("fails closed with a redacted configuration error when no external secret host is configured", async () => {
    // Break caught: the package start path exposes or depends on a missing in-repository host module.
    const previous = process.env.GATEWAY_EXTERNAL_ADAPTERS;
    delete process.env.GATEWAY_EXTERNAL_ADAPTERS;
    try {
      await expect(run()).rejects.toThrow("Gateway configuration or secret provider is unavailable");
    } finally {
      if (previous === undefined) delete process.env.GATEWAY_EXTERNAL_ADAPTERS;
      else process.env.GATEWAY_EXTERNAL_ADAPTERS = previous;
    }
  });

  it("uses the repository entry and production host path with injected external boundaries", async () => {
    // Break caught: package entry requires an out-of-repository bootstrap before production composition can start.
    const events: string[] = [];
    const ingress = (name: string) => ({ async start() { events.push(`${name}.started`); }, async stopIngress() {} });
    const dependencies: GatewayProductionDependencies = {
      config: { async validate() { events.push("config.valid"); } },
      orca: { async health() { events.push("orca.checked"); return {} as never; }, async execute() { throw new Error("not used"); } },
      execution: {} as never, hq: { async plan() { return { kind: "failure", reason: "invalid_command" } as never; } }, projects: [], slackAdapter: {} as never, telegramAdapter: {} as never,
      http: ingress("http"), slack: ingress("slack"), telegram: ingress("telegram"),
      transactions: { async drain() {} },
      outbox: { workerId: "entry-test", providers: {} },
      dispatchControl: { async stop() { return false; }, async retry() { return false; } }
    };
    await run(async () => ({ config: { databasePath: ":memory:", shutdownDrainMs: 1_000 }, dependencies }));
    expect(events).toEqual(["config.valid", "orca.checked", "http.started", "slack.started", "telegram.started"]);
  });
});
