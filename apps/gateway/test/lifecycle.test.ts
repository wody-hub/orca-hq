import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlStore, openDatabase } from "@orca-hq/persistence";
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

  it("cancels an in-flight startup before it can open ingress or revive running state", async () => {
    // Break caught: stop during a delayed migration closes the database, then startup opens ingress on it.
    const events: string[] = [];
    let releaseMigration: (() => void) | undefined;
    const migrationStarted = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const adapters = runtime(events);
    adapters.database.migrate = async () => {
      events.push("db.migrating");
      await migrationStarted;
      events.push("db.migrated");
    };
    const gateway = await createGateway(config, adapters);

    const starting = gateway.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const stopping = gateway.stop();
    releaseMigration?.();

    await expect(starting).rejects.toThrow("Gateway startup was stopped");
    await stopping;
    expect(events).toEqual(["config.valid", "db.migrating", "db.migrated", "db.closed"]);
    expect(gateway.status).toEqual({ kind: "stopped", degradedChannels: [] });
  });

  it("shares one shutdown latch across concurrent and post-failure stops", async () => {
    // Break caught: multiple callers checkpoint or close the same durable database more than once.
    const events: string[] = [];
    const adapters = runtime(events);
    adapters.orca.check = async () => {
      throw new Error("incompatible");
    };
    const gateway = await createGateway(config, adapters);

    await expect(gateway.start()).rejects.toThrow("incompatible");
    await Promise.all([gateway.stop(), gateway.stop(), gateway.stop()]);

    expect(events.filter((event) => event === "db.checkpointed")).toHaveLength(0);
    expect(events.filter((event) => event === "db.closed")).toHaveLength(1);
    expect(gateway.status).toEqual({ kind: "stopped", degradedChannels: [] });
  });

  it("persists redacted lifecycle audit evidence across a database recreation", async () => {
    // Break caught: lifecycle evidence exists only in process memory or stores provider secrets in durable audit rows.
    const directory = await mkdtemp(join(tmpdir(), "orca-gateway-audit-"));
    const path = join(directory, "control.sqlite");
    const database = openDatabase(path);
    const store = new ControlStore(database);
    const adapters: RuntimeAdapters = {
      ...runtime([]),
      audit: {
        append(event) {
          store.appendAudit({ ...event, data: {
            state: event.data.state,
            degradedChannels: [...event.data.degradedChannels]
          } });
        }
      }
    };
    try {
      const gateway = await createGateway(config, adapters);
      await gateway.start();
      await gateway.stop();
      database.close();

      const reopened = openDatabase(path);
      const events = new ControlStore(reopened).listAuditEvents();
      reopened.close();
      expect(events.map((event) => event.data)).toEqual(expect.arrayContaining([
        { state: "starting", degradedChannels: [] },
        { state: "running", degradedChannels: [] },
        { state: "stopped", degradedChannels: [] }
      ]));
      expect(JSON.stringify(events)).not.toContain("token");
    } finally {
      if (database.open) database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
