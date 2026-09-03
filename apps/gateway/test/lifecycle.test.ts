import { describe, expect, it } from "vitest";

import { createGateway, type GatewayConfig, type RuntimeAdapters } from "../src/lifecycle.js";

const config: GatewayConfig = {
  databasePath: ":memory:",
  shutdownDrainMs: 1_000
};

function runtime(events: string[], options: { slackFails?: boolean } = {}): RuntimeAdapters {
  return {
    config: {
      async validate() {
        events.push("config.valid");
      }
    },
    database: {
      async migrate() {
        events.push("db.migrated");
      },
      async checkpoint() {
        events.push("db.checkpointed");
      },
      async close() {
        events.push("db.closed");
      }
    },
    orca: {
      async check() {
        events.push("orca.checked");
      }
    },
    reconcile: async () => {
      events.push("reconciled");
    },
    http: {
      async start() {
        events.push("http.started");
      },
      async stopIngress() {
        events.push("http.stopped");
      }
    },
    slack: {
      async start() {
        events.push("slack.started");
        if (options.slackFails) throw new Error("token=must-not-leak");
      },
      async stopIngress() {
        events.push("slack.stopped");
      }
    },
    telegram: {
      async start() {
        events.push("telegram.started");
      },
      async stopIngress() {
        events.push("telegram.stopped");
      }
    },
    transactions: {
      async drain() {
        events.push("transactions.drained");
      }
    }
  };
}

describe("Gateway lifecycle", () => {
  it("starts durable services before external adapters", async () => {
    // Break caught: an ingress adapter starts before config, migrations, Orca health, or reconciliation finish.
    const events: string[] = [];
    const gateway = await createGateway(config, runtime(events));

    await gateway.start();

    expect(events).toEqual([
      "config.valid",
      "db.migrated",
      "orca.checked",
      "reconciled",
      "http.started",
      "slack.started",
      "telegram.started"
    ]);
  });

  it("continues in degraded mode when one channel fails after durable recovery", async () => {
    // Break caught: one external channel outage either prevents safe ingress from other channels or leaks provider details.
    const events: string[] = [];
    const gateway = await createGateway(config, runtime(events, { slackFails: true }));

    await gateway.start();

    expect(gateway.status).toEqual({ kind: "running", degradedChannels: ["slack"] });
    expect(events).toEqual(expect.arrayContaining(["http.started", "telegram.started"]));
    expect(gateway.diagnostics).toEqual([{ channel: "slack", code: "channel_start_failed" }]);
  });

  it("fails closed before ingress and closes durable state when Orca is incompatible", async () => {
    // Break caught: an incompatible Orca reaches an external channel or leaves an opened durable database behind.
    const events: string[] = [];
    const adapters = runtime(events);
    adapters.orca.check = async () => {
      events.push("orca.checked");
      throw new Error("incompatible");
    };
    const gateway = await createGateway(config, adapters);

    await expect(gateway.start()).rejects.toThrow("incompatible");

    expect(events).toEqual(["config.valid", "db.migrated", "orca.checked", "db.closed"]);
    expect(gateway.status).toEqual({ kind: "failed", degradedChannels: [] });
  });

  it("stops ingress before bounded drain and database checkpoint without touching Orca", async () => {
    // Break caught: shutdown checkpoints durable state while new ingress or transaction claims are still active.
    const events: string[] = [];
    const gateway = await createGateway(config, runtime(events));
    await gateway.start();

    await gateway.stop();

    expect(events.slice(-6)).toEqual([
      "telegram.stopped",
      "slack.stopped",
      "http.stopped",
      "transactions.drained",
      "db.checkpointed",
      "db.closed"
    ]);
    expect(events).not.toContain("orca.stopped");
    expect(gateway.status).toEqual({ kind: "stopped", degradedChannels: [] });
  });
});
