import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { IdentityResolver, type PrincipalBinding } from "@orca-hq/core";
import { createLocalSessionService } from "@orca-hq/tailscale-adapter";

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

  it("closes the opened database when HTTP composition fails before lifecycle ownership", async () => {
    // Break caught: an http/httpOptions composition failure leaves the SQLite handle open after stop.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-cleanup-"));
    const path = join(directory, "control.sqlite");
    const events: string[] = [];
    const { http: _http, ...incomplete } = dependencies(events);
    try {
      const composition = await createProductionGateway({ databasePath: path, shutdownDrainMs: 1_000 }, incomplete);
      await expect(composition.gateway.start()).rejects.toThrow("production HTTP security configuration is required");
      await composition.gateway.stop();
      expect(composition.services.database.open).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("wires durable projects and non-undefined approval/action adapters into production HTTP", async () => {
    // Break caught: httpOptions production composition leaves projects empty or mutation routes at undefined-port 500.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-http-"));
    const path = join(directory, "control.sqlite");
    const events: string[] = [];
    const owner: PrincipalBinding = {
      principalId: "owner", slackUserIds: [], telegramUserIds: [], telegramChatIds: [],
      tailscaleLoginNames: ["owner@example.test"], roles: ["owner"]
    };
    const { http: _http, reconcile: _reconcile, ...baseDependencies } = dependencies(events);
    const productionDependencies: GatewayProductionDependencies = {
      ...baseDependencies,
      httpOptions: {
        bindings: [owner], resolver: new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] }),
        sessions: createLocalSessionService({ signingKey: new Uint8Array(32).fill(1) }), peerAddress: () => "127.0.0.1",
        allowedOrigin: "https://hq.tailnet.example", csrfSigningKey: new Uint8Array(32).fill(2)
      },
      reconcile: async (services) => {
      services.store.insertCommand({ commandId: "command-1", idempotencyKey: "key-1", channel: "telegram", externalMessageId: "20:1", principalId: "owner", receivedAt: "2026-09-03T00:00:00.000Z", text: "수정" });
      const proposal = { proposalId: "proposal-1", commandId: "command-1", selectedProjectKey: "sandbox", routeCandidates: [{ projectKey: "sandbox", score: 1, evidence: ["alias"] }], allowedScope: ["src"], prohibitedEffects: [], acceptanceCommands: ["pnpm test"], riskLevel: "L1" as const, tasks: [{ localId: "implement", title: "수정", dependsOn: [], role: "implement" as const, preferredAgent: "codex" as const }] };
      services.store.saveExecutionProposal(proposal);
      services.store.saveRun({ id: "run-1", proposalId: "proposal-1", commandId: "command-1", state: "active", recoveryContext: { proposal } });
      }
    };
    try {
      const composition = await createProductionGateway({ databasePath: path, shutdownDrainMs: 1_000 }, productionDependencies);
      await composition.gateway.start();
      const app = composition.services.httpApp;
      if (app === undefined) throw new Error("production http app missing");
      const login = await app.inject({ method: "POST", url: "/auth/session", headers: { "tailscale-user-login": "owner@example.test" } });
      const cookie = (login.headers["set-cookie"] as string).split(";")[0];
      const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { "tailscale-user-login": "owner@example.test", cookie } });
      expect(projects.json()).toEqual({ projects: [{ projectKey: "sandbox", status: "active" }] });
      const mutationHeaders = { "tailscale-user-login": "owner@example.test", cookie, origin: "https://hq.tailnet.example", "x-csrf-token": login.headers["x-csrf-token"] as string, "idempotency-key": "one" };
      expect((await app.inject({ method: "POST", url: "/api/actions/stop", payload: { dispatchId: "missing" }, headers: mutationHeaders })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/approvals/missing/confirm", payload: { digest: "a".repeat(64) }, headers: mutationHeaders })).statusCode).toBe(403);
      await composition.gateway.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
