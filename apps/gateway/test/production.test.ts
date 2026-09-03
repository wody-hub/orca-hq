import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProductionGateway, type GatewayProductionDependencies } from "../src/production.js";

function dependencies(events: string[], valid = true): GatewayProductionDependencies {
  const ingress = (name: string) => ({ async start() { events.push(`${name}.started`); }, async stopIngress() { events.push(`${name}.stopped`); } });
  return {
    config: { async validate() { events.push("config.valid"); if (!valid) throw new Error("secret provider rejected configuration"); } },
    orca: { async health() { events.push("orca.checked"); return {} as never; }, async execute() { throw new Error("not used"); } },
    execution: {} as never, hq: {} as never, slackAdapter: {} as never, telegramAdapter: {} as never,
    http: ingress("http"), slack: ingress("slack"), telegram: ingress("telegram"),
    transactions: { async drain() { events.push("transactions.drained"); } },
    async reconcile() { events.push("reconciled"); }, commandFlow: { async accept() { return { state: "pending" }; } },
    deliveries: { async deliver() {} }, outbox: { workerId: "test", providers: {} }
  };
}

describe("production gateway composition", () => {
  it("validates config before opening/migrating the database and then starts every ingress in order", async () => {
    // Break caught: production opens SQLite before config/Keychain validation or starts an ingress out of lifecycle order.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-"));
    const path = join(directory, "control.sqlite");
    const events: string[] = [];
    try {
      const composition = await createProductionGateway({ databasePath: path, shutdownDrainMs: 1_000 }, dependencies(events));
      await composition.gateway.start();
      await composition.gateway.stop();
      expect(events).toEqual([
        "config.valid", "orca.checked", "reconciled", "http.started", "slack.started", "telegram.started",
        "telegram.stopped", "slack.stopped", "http.stopped", "transactions.drained"
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed without creating a database when config or secret validation is rejected", async () => {
    // Break caught: a rejected secret/config leaves a SQLite file or starts an external ingress.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-invalid-"));
    const path = join(directory, "control.sqlite");
    const events: string[] = [];
    try {
      const composition = await createProductionGateway({ databasePath: path, shutdownDrainMs: 1_000 }, dependencies(events, false));
      await expect(composition.gateway.start()).rejects.toThrow("secret provider rejected configuration");
      await expect(access(path)).rejects.toThrow();
      expect(events).toEqual(["config.valid"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
