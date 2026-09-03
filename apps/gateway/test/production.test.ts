import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ApprovalService, IdentityResolver, type PrincipalBinding } from "@orca-hq/core";
import type { ProjectRegistryEntry } from "@orca-hq/project-registry";
import { createLocalSessionService } from "@orca-hq/tailscale-adapter";

import { createProductionGateway, type GatewayProductionDependencies } from "../src/production.js";

const sandboxProject = {
  projectKey: "sandbox",
  orcaProjectId: "orca-sandbox",
  repoId: "repo-sandbox",
  absolutePath: "/srv/sandbox",
  aliases: ["sandbox"],
  component: "backend",
  defaultBaseRef: "main",
  instructionsFiles: [],
  setupPolicy: "run",
  allowedOperations: ["L0", "L1", "L2", "L3"],
  requiredChecks: ["pnpm test"],
  sensitivePaths: [],
  lockKey: "sandbox"
} satisfies ProjectRegistryEntry;

function dependencies(events: string[], valid = true): GatewayProductionDependencies {
  const ingress = (name: string) => ({ async start() { events.push(`${name}.started`); }, async stopIngress() { events.push(`${name}.stopped`); } });
  return {
    config: { async validate() { events.push("config.valid"); if (!valid) throw new Error("secret provider rejected configuration"); } },
    orca: { async health() { events.push("orca.checked"); return {} as never; }, async execute() { throw new Error("not used"); } },
    execution: {} as never,
    proposalModel: { async plan() { return { kind: "failure", reason: "invalid_command" }; } },
    projects: [],
    http: ingress("http"), slack: ingress("slack"), telegram: ingress("telegram"),
    transactions: { async drain() { events.push("transactions.drained"); } },
    outbox: { workerId: "test", providers: {} },
    dispatchControl: { async stop() { return false; }, async retry() { return false; } }
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
        "config.valid", "orca.checked", "http.started", "slack.started", "telegram.started",
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
    const { http: _http, ...baseDependencies } = dependencies(events);
    const productionDependencies: GatewayProductionDependencies = {
      ...baseDependencies,
      projects: [sandboxProject],
      httpOptions: {
        bindings: [owner], resolver: new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] }),
        sessions: createLocalSessionService({ signingKey: new Uint8Array(32).fill(1) }), peerAddress: () => "127.0.0.1",
        allowedOrigin: "https://hq.tailnet.example", csrfSigningKey: new Uint8Array(32).fill(2)
      }
    };
    try {
      const composition = await createProductionGateway({ databasePath: path, shutdownDrainMs: 1_000 }, productionDependencies);
      await composition.gateway.start();
      composition.services.store.insertCommand({ commandId: "command-1", idempotencyKey: "key-1", channel: "telegram", externalMessageId: "20:1", principalId: "owner", receivedAt: "2026-09-03T00:00:00.000Z", text: "수정" });
      const proposal = { proposalId: "proposal-1", commandId: "command-1", selectedProjectKey: "sandbox", routeCandidates: [{ projectKey: "sandbox", score: 1, evidence: ["alias"] }], allowedScope: ["src"], prohibitedEffects: [], acceptanceCommands: ["pnpm test"], riskLevel: "L1" as const, tasks: [{ localId: "implement", title: "수정", dependsOn: [], role: "implement" as const, preferredAgent: "codex" as const }] };
      composition.services.store.saveExecutionProposal(proposal);
      composition.services.store.saveRun({ id: "run-1", proposalId: "proposal-1", commandId: "command-1", state: "active", recoveryContext: { proposal } });
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

  it("confirms durable L2 digests and reconstructed L3 phrases through the production HTTP route", async () => {
    // Break caught: the production adapter re-parses PersistedApprovalRequest and rejects every valid approval.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-approval-"));
    const path = join(directory, "control.sqlite");
    const events: string[] = [];
    const owner: PrincipalBinding = {
      principalId: "owner", slackUserIds: [], telegramUserIds: [], telegramChatIds: [],
      tailscaleLoginNames: ["owner@example.test"], roles: ["owner"]
    };
    const { http: _http, ...baseDependencies } = dependencies(events);
    const productionDependencies: GatewayProductionDependencies = {
      ...baseDependencies,
      httpOptions: {
        bindings: [owner], resolver: new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] }),
        sessions: createLocalSessionService({ signingKey: new Uint8Array(32).fill(1) }), peerAddress: () => "127.0.0.1",
        allowedOrigin: "https://hq.tailnet.example", csrfSigningKey: new Uint8Array(32).fill(2)
      }
    };
    try {
      const composition = await createProductionGateway({ databasePath: path, shutdownDrainMs: 1_000 }, productionDependencies);
      await composition.gateway.start();
      const approvalService = new ApprovalService(composition.services.store);
      for (const [commandId, riskLevel, operation] of [
        ["command-l2", "L2", "commit_changes"],
        ["command-l3", "L3", "deploy_production"]
      ] as const) {
        composition.services.store.insertCommand({ commandId, idempotencyKey: `key-${commandId}`, channel: "tailscale-web", externalMessageId: commandId, principalId: "owner", receivedAt: "2026-09-03T00:00:00.000Z", text: operation });
        const proposal = {
          proposalId: `proposal-${riskLevel}`, commandId, selectedProjectKey: "sandbox",
          routeCandidates: [{ projectKey: "sandbox", score: 1, evidence: ["alias"] }], allowedScope: ["src"], prohibitedEffects: [], acceptanceCommands: ["pnpm test"], riskLevel,
          tasks: [{ localId: "implement", title: "수정", dependsOn: [], role: "implement" as const, preferredAgent: "codex" as const }]
        };
        composition.services.store.saveExecutionProposal(proposal);
        composition.services.store.saveRun({ id: `run-${riskLevel}`, proposalId: proposal.proposalId, commandId, state: "active", recoveryContext: { proposal } });
        approvalService.request({ approvalId: `approval-${riskLevel}`, proposal, operation, commandDigest: "a".repeat(64), channel: "tailscale-web", allowedChannels: ["tailscale-web"] });
      }
      const app = composition.services.httpApp;
      if (app === undefined) throw new Error("production http app missing");
      const login = await app.inject({ method: "POST", url: "/auth/session", headers: { "tailscale-user-login": "owner@example.test" } });
      const cookie = (login.headers["set-cookie"] as string).split(";")[0];
      const headers = { "tailscale-user-login": "owner@example.test", cookie, origin: "https://hq.tailnet.example", "x-csrf-token": login.headers["x-csrf-token"] as string, "idempotency-key": "approval-success" };
      const l2 = (await app.inject({ method: "GET", url: "/api/commands/command-l2", headers: { "tailscale-user-login": "owner@example.test", cookie } })).json() as { approval: { digest: string } };
      expect((await app.inject({ method: "POST", url: "/api/approvals/approval-L2/confirm", payload: { digest: l2.approval.digest }, headers })).statusCode).toBe(200);
      const l3 = (await app.inject({ method: "GET", url: "/api/commands/command-l3", headers: { "tailscale-user-login": "owner@example.test", cookie } })).json() as { approval: { digest: string; operationPhrase: string } };
      expect(l3.approval.operationPhrase).toBe(`APPROVE DEPLOY_PRODUCTION ${l3.approval.digest.slice(0, 12).toUpperCase()}`);
      expect((await app.inject({ method: "POST", url: "/api/approvals/approval-L3/confirm", payload: { digest: l3.approval.digest, phrase: "wrong" }, headers: { ...headers, "idempotency-key": "approval-wrong" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/approvals/approval-L3/confirm", payload: { digest: l3.approval.digest, phrase: l3.approval.operationPhrase }, headers: { ...headers, "idempotency-key": "approval-l3" } })).statusCode).toBe(200);
      await composition.gateway.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes each durable dispatch control once and writes its redacted audit through HTTP", async () => {
    // Break caught: a dashboard action silently denies a real durable dispatch, or a retry key repeats an external control call.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-actions-"));
    const path = join(directory, "control.sqlite");
    const events: string[] = [];
    const calls: string[] = [];
    const owner: PrincipalBinding = {
      principalId: "owner", slackUserIds: [], telegramUserIds: [], telegramChatIds: [],
      tailscaleLoginNames: ["owner@example.test"], roles: ["owner"]
    };
    const { http: _http, ...baseDependencies } = dependencies(events);
    const productionDependencies: GatewayProductionDependencies = {
      ...baseDependencies,
      dispatchControl: {
        async stop({ dispatchId }) { calls.push(`stop:${dispatchId}`); return true; },
        async retry({ dispatchId }) { calls.push(`retry:${dispatchId}`); return true; }
      },
      httpOptions: {
        bindings: [owner], resolver: new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] }),
        sessions: createLocalSessionService({ signingKey: new Uint8Array(32).fill(1) }), peerAddress: () => "127.0.0.1",
        allowedOrigin: "https://hq.tailnet.example", csrfSigningKey: new Uint8Array(32).fill(2)
      }
    };
    try {
      const composition = await createProductionGateway({ databasePath: path, shutdownDrainMs: 1_000 }, productionDependencies);
      await composition.gateway.start();
      composition.services.store.insertCommand({ commandId: "command-action", idempotencyKey: "key-action", channel: "tailscale-web", externalMessageId: "action", principalId: "owner", receivedAt: "2026-09-03T00:00:00.000Z", text: "수정" });
      composition.services.store.saveRun({ id: "run-action", proposalId: "proposal-action", commandId: "command-action", state: "active" });
      composition.services.store.saveTask({ id: "task-action", runId: "run-action", title: "수정", role: "implement", preferredAgent: "codex", dependsOn: [], state: "running" });
      composition.services.store.saveDispatch({ id: "dispatch-action", taskId: "task-action", state: "running" });
      const app = composition.services.httpApp;
      if (app === undefined) throw new Error("production http app missing");
      const login = await app.inject({ method: "POST", url: "/auth/session", headers: { "tailscale-user-login": "owner@example.test" } });
      const cookie = (login.headers["set-cookie"] as string).split(";")[0];
      const headers = { "tailscale-user-login": "owner@example.test", cookie, origin: "https://hq.tailnet.example", "x-csrf-token": login.headers["x-csrf-token"] as string, "idempotency-key": "stop-once" };
      expect((await app.inject({ method: "POST", url: "/api/actions/stop", payload: { dispatchId: "dispatch-action" }, headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/actions/stop", payload: { dispatchId: "dispatch-action" }, headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/actions/retry", payload: { dispatchId: "dispatch-action" }, headers: { ...headers, "idempotency-key": "retry-once" } })).statusCode).toBe(200);
      expect(calls).toEqual(["stop:dispatch-action", "retry:dispatch-action"]);
      expect(composition.services.store.listAuditEvents().filter((event) => event.subjectId === "dispatch-action").map((event) => event.eventType))
        .toEqual(["dispatch.stop_requested", "dispatch.retry_requested"]);
      await composition.gateway.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
