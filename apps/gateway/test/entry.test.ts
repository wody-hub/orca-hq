import { access, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdentityResolver, type PrincipalBinding } from "@orca-hq/core";
import { OutboxDispatcher } from "@orca-hq/persistence";
import { createLocalSessionService } from "@orca-hq/tailscale-adapter";
import { ExecutionService } from "@orca-hq/worker-routing";
import { describe, expect, it } from "vitest";

import { run } from "../src/entry.js";
import {
  createGatewayHost,
  type GatewayExternalBoundaries
} from "../src/host.js";

const owner: PrincipalBinding = {
  principalId: "owner",
  slackUserIds: [],
  telegramUserIds: ["10"],
  telegramChatIds: ["20"],
  tailscaleLoginNames: ["owner@example.test"],
  roles: ["owner"]
};

function externalBoundaries(directory: string, events: string[]): GatewayExternalBoundaries {
  const project = {
    projectKey: "sandbox", orcaProjectId: "orca-sandbox", repoId: "repo-sandbox",
    absolutePath: directory, aliases: ["sandbox"], component: "backend", defaultBaseRef: "main",
    instructionsFiles: [], setupPolicy: "run", allowedOperations: ["L0", "L1"],
    requiredChecks: ["pnpm test"], sensitivePaths: [], lockKey: "sandbox"
  } as const;
  const projectRegistryPath = join(directory, "projects.yaml");
  writeFileSync(
    projectRegistryPath,
    `projects:\n${JSON.stringify([project], null, 2).replace(/^/gm, "  ")}`,
    "utf8"
  );
  const ingress = (name: string) => ({
    async start() { events.push(`${name}.started`); },
    async stopIngress() { events.push(`${name}.stopped`); }
  });
  return {
    settings: {
      pilotConfig: {
        schema: "orca-hq.private-pilot.v1",
        databasePath: join(directory, "control.sqlite"),
        projectRegistryPath,
        credentialAccounts: []
      },
      gateway: {
        databasePath: join(directory, "control.sqlite"),
        shutdownDrainMs: 1_000,
        httpPort: 0,
        allowEphemeralHttpPortForTests: true
      },
      projectRegistryPath,
      discoveredProjects: [{ orcaProjectId: "orca-sandbox", absolutePath: directory, approved: true }],
      assignmentArtifactRootDirectory: join(directory, "assignments"),
      outboxWorkerId: "entry-test",
      completionDestinations: {
        slack: "C-HQ-COMPLETIONS",
        tailscaleWeb: "/commands/completed"
      },
      serveConfiguration: {
        funnelEnabled: false,
        publicExposure: false,
        gatewayBindAddress: "127.0.0.1",
        upstreamAddress: "127.0.0.1:0",
        httpsEnabled: true,
        advertisedHost: "hq.example.ts.net",
        expectedTailnetDnsSuffix: "example.ts.net"
      }
    },
    secrets: { async validate() { events.push("config.valid"); } },
    orca: {
      async health() { events.push("orca.checked"); return {} as never; },
      async execute() { throw new Error("not used"); }
    },
    proposalModel: { async plan() { return { kind: "failure", reason: "invalid_command" }; } },
    channelRecovery: { async resumeCursors() { events.push("channels.resumed"); } },
    git: {
      async repositoryStatus() { return { dirty: false, head: "a".repeat(40), branch: "main" }; },
      async resolveRevision() { return "a".repeat(40); },
      async branchOccupancy() { return []; },
      async pathExists() { return false; },
      async createWorktree() {}
    },
    verificationEvidence: {
      collectImplementation() { throw new Error("not used"); },
      collectVerifierCommands() { throw new Error("not used"); },
      captureRepositorySnapshot() { throw new Error("not used"); }
    },
    httpOptions: {
      bindings: [owner],
      resolver: new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] }),
      sessions: createLocalSessionService({ signingKey: new Uint8Array(32).fill(1) }),
      peerAddress: () => "127.0.0.1",
      allowedOrigin: "https://hq.tailnet.example",
      csrfSigningKey: new Uint8Array(32).fill(2)
    },
    slack: ingress("slack"),
    telegram: ingress("telegram"),
    transactions: { async drain() { events.push("transactions.drained"); } },
    outboundProviders: {},
    dispatchControl: { async stop() { return false; }, async retry() { return false; } }
  };
}

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

  it("runs host, entry and production with only external I/O boundaries", async () => {
    // Break caught: host.ts accepts a prebuilt GatewayProductionDependencies object instead of assembling repository services.
    const directory = await mkdtemp(join(tmpdir(), "orca-entry-host-"));
    const events: string[] = [];
    try {
      const composition = await run(() => createGatewayHost(async () => externalBoundaries(directory, events)));
      expect(composition.gateway.status.kind).toBe("running");
      expect(composition.services.execution).toBeInstanceOf(ExecutionService);
      expect(composition.services.outbox).toBeInstanceOf(OutboxDispatcher);
      expect(events).toEqual(["config.valid", "orca.checked", "channels.resumed", "slack.started", "telegram.started"]);
      await composition.gateway.stop();
      expect(events.slice(-3)).toEqual(["telegram.stopped", "slack.stopped", "transactions.drained"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an external module that returns prebuilt production dependencies", async () => {
    // Break caught: the default host loader silently trusts the old { config, dependencies } bootstrap contract.
    await expect(createGatewayHost(async () => ({
      config: { databasePath: ":memory:", shutdownDrainMs: 1_000 },
      dependencies: {}
    }))).rejects.toThrow("Gateway configuration or secret provider is unavailable");
  });

  it("rejects a gateway database path that differs from the canonical pilot config", async () => {
    // Break caught: gateway and lifecycle can inspect different SQLite files while each configuration is individually valid.
    const directory = await mkdtemp(join(tmpdir(), "orca-entry-config-mismatch-"));
    const events: string[] = [];
    try {
      const complete = externalBoundaries(directory, events);
      await expect(createGatewayHost(async () => ({
        ...complete,
        settings: {
          ...complete.settings,
          gateway: { ...complete.settings.gateway, databasePath: join(directory, "other.sqlite") }
        }
      }))).rejects.toThrow("Gateway configuration or secret provider is unavailable");
      expect(events).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["Slack", "slack"],
    ["tailscale-web", "tailscaleWeb"]
  ] as const)(
    "rejects a missing %s completion destination before database or ingress use",
    async (_channel, omittedDestination) => {
      // Break caught: an optional completion destination can fail after successful verification but before its durable commit.
      const directory = await mkdtemp(join(tmpdir(), "orca-entry-destination-"));
      const events: string[] = [];
      const databasePath = join(directory, "control.sqlite");
      try {
        const complete = externalBoundaries(directory, events);
        const invalid = {
          ...complete,
          settings: {
            ...complete.settings,
            completionDestinations: omittedDestination === "slack"
              ? { tailscaleWeb: complete.settings.completionDestinations?.tailscaleWeb }
              : { slack: complete.settings.completionDestinations?.slack }
          }
        };

        await expect(createGatewayHost(async () => invalid)).rejects.toThrow(
          "Gateway configuration or secret provider is unavailable"
        );
        await expect(access(databasePath)).rejects.toThrow();
        expect(events).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
