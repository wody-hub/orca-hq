import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ApprovalService, IdentityResolver, type PrincipalBinding } from "@orca-hq/core";
import { ControlStore, openDatabase } from "@orca-hq/persistence";
import type { ProjectRegistryEntry } from "@orca-hq/project-registry";
import { createLocalSessionService } from "@orca-hq/tailscale-adapter";

import { createProductionGateway, type GatewayProductionDependencies } from "../src/production.js";

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw failure;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test port unavailable");
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

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
    dispatchControl: { async stop() { return false; }, async retry() { return false; } },
    completionDestinations: { slack: "C-HQ-COMPLETIONS", tailscaleWeb: "/commands/completed" }
  };
}

describe("production gateway composition", () => {
  it("requeues a stale Outbox claim on restart and lifecycle-delivers it", async () => {
    // Break caught: reconciliation reads stale claims without making them eligible for the lifecycle-owned driver.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-reconcile-outbox-"));
    const path = join(directory, "control.sqlite");
    const seededDatabase = openDatabase(path);
    const seededStore = new ControlStore(seededDatabase);
    seededStore.enqueueOutbox({
      id: "stale-message",
      channel: "tailscale-web",
      destination: "/commands/stale",
      template: "success",
      payload: { text: "recovered" },
      nextAttemptAt: "2026-09-03T00:00:00.000Z"
    });
    expect(seededStore.claimOutbox("2026-09-03T00:00:00.000Z", "crashed-worker"))
      .toMatchObject({ state: "claimed" });
    seededDatabase.close();
    const deliveries: string[] = [];
    const events: string[] = [];
    const recoveryDependencies: GatewayProductionDependencies = {
      ...dependencies(events),
      now: () => new Date("2026-09-03T00:02:00.000Z"),
      outbox: {
        workerId: "replacement-worker",
        providers: {
          "tailscale-web": {
            async deliver(message) {
              deliveries.push((message.payload as { text: string }).text);
              return { providerMessageId: "recovered-1" };
            }
          }
        }
      }
    };
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      composition = await createProductionGateway({
        databasePath: path,
        shutdownDrainMs: 1_000,
        outboxPollMs: 10,
        outboxClaimTtlMs: 60_000
      }, recoveryDependencies);
      await composition.gateway.start();
      await eventually(() => {
        expect(composition?.services.store.getOutbox("stale-message")?.state).toBe("delivered");
      });

      expect(deliveries).toEqual(["recovered"]);
      expect(composition.services.store.listAuditEvents()).toContainEqual(
        expect.objectContaining({ eventType: "outbox.claim_recovered" })
      );
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces nonterminal durable work as reconciliation_incomplete", async () => {
    // Break caught: startup reports reconciled after discarding nonterminal Run and Dispatch observations.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-reconcile-run-"));
    const path = join(directory, "control.sqlite");
    const database = openDatabase(path);
    const store = new ControlStore(database);
    store.insertCommand({
      commandId: "active-command",
      idempotencyKey: "active-command:key",
      channel: "slack",
      externalMessageId: "slack:active-command",
      principalId: "owner",
      receivedAt: "2026-09-03T00:00:00.000Z",
      text: "active work"
    });
    store.saveRun({
      id: "active-run",
      proposalId: "active-proposal",
      commandId: "active-command",
      objective: "active work",
      state: "active"
    });
    database.close();
    const events: string[] = [];
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      composition = await createProductionGateway(
        { databasePath: path, shutdownDrainMs: 1_000 },
        { ...dependencies(events), now: () => new Date("2026-09-03T00:02:00.000Z") }
      );
      await composition.gateway.start();

      expect(composition.gateway.diagnostics).toContainEqual({
        component: "reconciliation",
        code: "reconciliation_incomplete",
        activeRuns: 1,
        activeDispatches: 0
      });
      expect(composition.services.store.listAuditEvents()).toContainEqual(
        expect.objectContaining({
          eventType: "gateway.reconciliation_incomplete",
          data: { activeRuns: 1, activeDispatches: 0 }
        })
      );
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the configured HTTP port and reports a redacted Tailscale Serve upstream mismatch", async () => {
    // Break caught: production ignores the configured stable port and never runs Serve diagnostics after HTTP starts.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-http-port-"));
    const path = join(directory, "control.sqlite");
    const port = await availablePort();
    const mismatchedPort = port === 65_535 ? port - 1 : port + 1;
    const events: string[] = [];
    const owner: PrincipalBinding = {
      principalId: "owner", slackUserIds: [], telegramUserIds: [], telegramChatIds: [],
      tailscaleLoginNames: ["owner@example.test"], roles: ["owner"]
    };
    const { http: _http, ...baseDependencies } = dependencies(events);
    const fixedPortDependencies = {
      ...baseDependencies,
      httpOptions: {
        bindings: [owner], resolver: new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] }),
        sessions: createLocalSessionService({ signingKey: new Uint8Array(32).fill(1) }), peerAddress: () => "127.0.0.1",
        allowedOrigin: "https://hq.tailnet.example", csrfSigningKey: new Uint8Array(32).fill(2)
      },
      serveConfiguration: {
        funnelEnabled: false,
        publicExposure: false,
        gatewayBindAddress: "127.0.0.1",
        upstreamAddress: `127.0.0.1:${mismatchedPort}`,
        httpsEnabled: true,
        advertisedHost: "hq.example.ts.net",
        expectedTailnetDnsSuffix: "example.ts.net"
      }
    } satisfies GatewayProductionDependencies;
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      composition = await createProductionGateway({
        databasePath: path,
        shutdownDrainMs: 1_000,
        httpPort: port
      }, fixedPortDependencies);
      await composition.gateway.start();
      const address = composition.services.httpApp?.server.address();
      expect(address).toMatchObject({ address: "127.0.0.1", port });
      expect(composition.gateway.diagnostics).toContainEqual({
        component: "tailscale-serve",
        code: "serve_configuration_invalid",
        reasons: ["upstream_port_mismatch"]
      });
      expect(JSON.stringify(composition.gateway.diagnostics)).not.toContain(String(mismatchedPort));
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("absorbs Outbox driver failures with redacted diagnostics and bounded retry", async () => {
    // Break caught: a scheduled tick rejection becomes an unhandled process failure or leaks its raw cause.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-outbox-failure-"));
    const path = join(directory, "control.sqlite");
    const events: string[] = [];
    let clockReads = 0;
    const failingClock = () => {
      clockReads += 1;
      if (clockReads === 1) return new Date("2026-09-03T00:00:00.000Z");
      throw new Error("token=driver-secret-must-not-leak");
    };
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      composition = await createProductionGateway({
        databasePath: path,
        shutdownDrainMs: 1_000,
        outboxPollMs: 5,
        outboxMaxBackoffMs: 20
      }, { ...dependencies(events), now: failingClock });
      await composition.gateway.start();
      await eventually(() => {
        expect(composition?.gateway.diagnostics).toContainEqual({
          component: "outbox",
          code: "outbox_tick_failed"
        });
      });
      expect(composition.gateway.status.kind).toBe("running");
      expect(JSON.stringify(composition.services.store.listAuditEvents()))
        .not.toContain("driver-secret-must-not-leak");
      expect(clockReads).toBeLessThan(20);
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a typed audited failure when the accepted command is not durable", async () => {
    // Break caught: a command/store mismatch throws through the ingress adapter before any audit evidence is committed.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-command-missing-"));
    const path = join(directory, "control.sqlite");
    const events: string[] = [];
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      composition = await createProductionGateway(
        { databasePath: path, shutdownDrainMs: 1_000 },
        dependencies(events)
      );
      await composition.gateway.start();

      await expect(composition.gateway.acceptCommand({
        commandId: "missing-command",
        channel: "slack",
        text: "not durable"
      })).resolves.toEqual({ state: "failure" });
      expect(composition.services.store.listAuditEvents()).toContainEqual(
        expect.objectContaining({
          subjectId: "missing-command",
          eventType: "command.planning_failed",
          data: { reason: "durable_command_missing" }
        })
      );
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("collapses malformed HQ output into a redacted typed failure and audit event", async () => {
    // Break caught: malformed model output leaks its raw payload or parser exception through the command ingress.
    const directory = await mkdtemp(join(tmpdir(), "orca-production-hq-malformed-"));
    const path = join(directory, "control.sqlite");
    const events: string[] = [];
    const malformedDependencies = {
      ...dependencies(events),
      proposalModel: {
        async plan() {
          return { malformed: true, secret: "model-secret-must-not-leak" };
        }
      }
    } satisfies GatewayProductionDependencies;
    let composition: Awaited<ReturnType<typeof createProductionGateway>> | undefined;
    try {
      composition = await createProductionGateway(
        { databasePath: path, shutdownDrainMs: 1_000 },
        malformedDependencies
      );
      await composition.gateway.start();
      composition.services.store.insertCommand({
        commandId: "malformed-command",
        idempotencyKey: "malformed-command:key",
        channel: "slack",
        externalMessageId: "slack:malformed-command",
        principalId: "owner",
        receivedAt: "2026-09-03T00:00:00.000Z",
        text: "malformed model result"
      });

      await expect(composition.gateway.acceptCommand({
        commandId: "malformed-command",
        channel: "slack",
        text: "malformed model result"
      })).resolves.toEqual({ state: "failure" });
      const audit = composition.services.store.listAuditEvents();
      expect(audit).toContainEqual(expect.objectContaining({
        subjectId: "malformed-command",
        eventType: "command.planning_failed",
        data: { reason: "invalid_model_output" }
      }));
      expect(JSON.stringify(audit)).not.toContain("model-secret-must-not-leak");
    } finally {
      await composition?.gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it.each([
    ["Slack", { tailscaleWeb: "/commands/completed" }],
    ["tailscale-web", { slack: "C-HQ-COMPLETIONS" }]
  ] as const)(
    "rejects a missing %s completion destination before database or ingress use",
    async (_channel, completionDestinations) => {
      // Break caught: callers bypassing host validation can defer an incomplete delivery contract until verification commit.
      const directory = await mkdtemp(join(tmpdir(), "orca-production-destination-"));
      const path = join(directory, "control.sqlite");
      const events: string[] = [];
      const invalid = {
        ...dependencies(events),
        completionDestinations
      } as unknown as GatewayProductionDependencies;
      try {
        await expect(createProductionGateway(
          { databasePath: path, shutdownDrainMs: 1_000 },
          invalid
        )).rejects.toThrow("Gateway completion delivery configuration is unavailable");
        await expect(access(path)).rejects.toThrow();
        expect(events).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

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
      const composition = await createProductionGateway({
        databasePath: path,
        shutdownDrainMs: 1_000,
        httpPort: 0,
        allowEphemeralHttpPortForTests: true
      }, productionDependencies);
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

  it("does not turn standalone approval fixtures into production execution authority", async () => {
    // Break caught: confirming an orphaned approval returns success without revalidating its production proposal and project.
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
      const composition = await createProductionGateway({
        databasePath: path,
        shutdownDrainMs: 1_000,
        httpPort: 0,
        allowEphemeralHttpPortForTests: true
      }, productionDependencies);
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
      expect((await app.inject({ method: "POST", url: "/api/approvals/approval-L2/confirm", payload: { digest: l2.approval.digest }, headers })).statusCode).toBe(403);
      const l3 = (await app.inject({ method: "GET", url: "/api/commands/command-l3", headers: { "tailscale-user-login": "owner@example.test", cookie } })).json() as { approval: { digest: string; operationPhrase: string } };
      expect(l3.approval.operationPhrase).toBe(`APPROVE DEPLOY_PRODUCTION ${l3.approval.digest.slice(0, 12).toUpperCase()}`);
      expect((await app.inject({ method: "POST", url: "/api/approvals/approval-L3/confirm", payload: { digest: l3.approval.digest, phrase: "wrong" }, headers: { ...headers, "idempotency-key": "approval-wrong" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/approvals/approval-L3/confirm", payload: { digest: l3.approval.digest, phrase: l3.approval.operationPhrase }, headers: { ...headers, "idempotency-key": "approval-l3" } })).statusCode).toBe(403);
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
      const composition = await createProductionGateway({
        databasePath: path,
        shutdownDrainMs: 1_000,
        httpPort: 0,
        allowEphemeralHttpPortForTests: true
      }, productionDependencies);
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
