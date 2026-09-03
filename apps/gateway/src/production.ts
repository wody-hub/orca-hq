import { ApprovalService, type AuthenticatedPrincipal, type PrincipalBinding } from "@orca-hq/core";
import type { CodexHqSession } from "@orca-hq/codex-hq";
import { OrcaClient, type OrcaClientOptions } from "@orca-hq/orca-adapter";
import { ControlStore, openDatabase, OutboxDispatcher, type OutboxDispatcherOptions } from "@orca-hq/persistence";
import { WorktreeLockService } from "@orca-hq/project-registry";
import type { SlackAdapter } from "@orca-hq/slack-adapter";
import type { TelegramAdapter } from "@orca-hq/telegram-adapter";
import { ExecutionLifecycle, ExecutionService } from "@orca-hq/worker-routing";

import {
  createGateway,
  type Gateway,
  type GatewayCommandFlowPort,
  type GatewayConfig,
  type GatewayConfigPort,
  type GatewayDeliveryPort,
  type GatewayIngressPort,
  type GatewayTransactionPort
} from "./lifecycle.js";
import { wireAbortSignals } from "./main.js";
import { createCommandDashboard, createProjectDashboard } from "./dashboard.js";
import { createHttpApp, type ApprovalConfirmationPort, type DispatchActionPort, type GatewayHttpOptions } from "./http.js";

export interface GatewayDispatchControlPort {
  stop(input: Readonly<{ dispatchId: string; idempotencyKey: string }>): Promise<boolean>;
  retry(input: Readonly<{ dispatchId: string; idempotencyKey: string }>): Promise<boolean>;
}

/**
 * The concrete process composition boundary. Network/Keychain handles remain
 * injected, while durable storage, Orca, locking, execution, and outbox use
 * their public concrete implementations exactly once.
 */
export interface GatewayProductionDependencies {
  readonly config: GatewayConfigPort;
  /** A real Orca client is external I/O and may be injected; options construct the default client. */
  readonly orca: OrcaClientOptions | Pick<OrcaClient, "health" | "execute">;
  readonly execution: Omit<ConstructorParameters<typeof ExecutionService>[0], "orca" | "locks" | "lifecycle">;
  readonly hq: CodexHqSession;
  readonly slackAdapter: SlackAdapter;
  readonly telegramAdapter: TelegramAdapter;
  /** Legacy externally-hosted ingress. New hosts should supply httpOptions so production owns createHttpApp. */
  readonly http?: GatewayIngressPort;
  /** Keychain/session/identity-backed external boundary; production creates the HTTP app and loopback listener itself. */
  readonly httpOptions?: Omit<GatewayHttpOptions, "commands" | "projects" | "approvals" | "actions">;
  readonly slack: GatewayIngressPort;
  readonly telegram: GatewayIngressPort;
  readonly transactions: GatewayTransactionPort;
  readonly reconcile: (services: GatewayProductionServices) => Promise<void>;
  readonly commandFlow: GatewayCommandFlowPort;
  readonly deliveries: GatewayDeliveryPort;
  readonly outbox: Omit<OutboxDispatcherOptions, "store">;
  /** Orca dispatch control is an injected external-I/O boundary; route adapters remain production-owned. */
  readonly dispatchControl?: GatewayDispatchControlPort;
  /** Injectable clock for approval expiry tests; production defaults to the system clock. */
  readonly now?: () => Date;
}

export interface GatewayProductionServices {
  readonly database: ReturnType<typeof openDatabase>;
  readonly store: ControlStore;
  readonly orca: Pick<OrcaClient, "health" | "execute">;
  readonly locks: WorktreeLockService;
  readonly execution: ExecutionService;
  readonly hq: CodexHqSession;
  readonly outbox: OutboxDispatcher;
  readonly slackAdapter: SlackAdapter;
  readonly telegramAdapter: TelegramAdapter;
  /** Present only when production owns the HTTP app from httpOptions. */
  readonly httpApp?: ReturnType<typeof createHttpApp>;
}

function approvalPrincipal(principal: AuthenticatedPrincipal): PrincipalBinding {
  return {
    principalId: principal.principalId, slackUserIds: [], telegramUserIds: [],
    telegramChatIds: [], tailscaleLoginNames: [`dashboard:${principal.principalId}`], roles: [...principal.roles]
  };
}

function approvalAdapter(store: ControlStore, now: () => Date): ApprovalConfirmationPort {
  const service = new ApprovalService(store);
  return {
    async confirmExisting(input) {
      const persisted = store.findApproval(input.approvalId);
      if (persisted === undefined) return { kind: "denied" };
      if (persisted.request.digest !== input.digest) return { kind: "changed" };
      const request = service.request(persisted.request);
      const decision = service.confirm(request, approvalPrincipal(input.principal), now(), input.phrase);
      if (decision.kind === "changed") return { kind: "changed" };
      if (decision.kind !== "approved") return { kind: "denied" };
      const confirmed = store.findApproval(input.approvalId)?.approval;
      return confirmed === undefined ? { kind: "denied" } : { kind: "approved", expiresAt: confirmed.expiresAt };
    }
  };
}

function actionAdapter(store: ControlStore, control: GatewayDispatchControlPort | undefined): DispatchActionPort {
  const exists = (dispatchId: string): boolean => store.listTasks()
    .some((task) => store.loadDispatchesForTask(task.id).some((dispatch) => record(dispatch).id === dispatchId));
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const action = async (kind: "stop" | "retry", input: Readonly<{ dispatchId: string; idempotencyKey: string }>) => {
    if (!exists(input.dispatchId) || control === undefined) return { kind: "denied" } as const;
    const accepted = await control[kind](input);
    if (!accepted) return { kind: "denied" } as const;
    store.appendAudit({ subjectId: input.dispatchId, eventType: `dispatch.${kind}_requested`, data: { idempotencyKey: input.idempotencyKey } });
    return { kind: kind === "stop" ? "stopped" : "retried" } as const;
  };
  return {
    async stop(input) {
      const result = await action("stop", input);
      return result.kind === "stopped" ? { kind: "stopped" as const } : { kind: "denied" as const };
    },
    async retry(input) {
      const result = await action("retry", input);
      return result.kind === "retried" ? { kind: "retried" as const } : { kind: "denied" as const };
    }
  };
}

export async function createProductionGateway(
  config: GatewayConfig,
  dependencies: GatewayProductionDependencies
): Promise<Readonly<{ gateway: Gateway; services: GatewayProductionServices }>> {
  // Database construction is deliberately deferred to database.migrate: config/secret
  // validation is the first lifecycle operation and a rejected config leaves no handle.
  let services: GatewayProductionServices | undefined;
  let http: GatewayIngressPort | undefined = dependencies.http;
  const requireServices = (): GatewayProductionServices => {
    if (services === undefined) throw new Error("production services are unavailable before configuration validation");
    return services;
  };
  const orca = "execute" in dependencies.orca
    ? dependencies.orca
    : new OrcaClient(dependencies.orca);
  const exposedServices = {} as GatewayProductionServices;
  for (const key of ["database", "store", "orca", "locks", "execution", "hq", "outbox", "slackAdapter", "telegramAdapter", "httpApp"] as const) {
    Object.defineProperty(exposedServices, key, { enumerable: true, get: () => requireServices()[key] });
  }
  const gateway = await createGateway(config, {
    config: dependencies.config,
    database: {
      async migrate() {
        // openDatabase owns WAL, foreign keys, and idempotent migration.
        let database: ReturnType<typeof openDatabase> | undefined;
        try {
          database = openDatabase(config.databasePath);
          const store = new ControlStore(database);
          const locks = new WorktreeLockService(store);
          const lifecycle = new ExecutionLifecycle({ store });
          const execution = new ExecutionService({ ...dependencies.execution, orca, locks, lifecycle });
          const outbox = new OutboxDispatcher({ ...dependencies.outbox, store });
          let httpApp: ReturnType<typeof createHttpApp> | undefined;
          if (dependencies.httpOptions !== undefined) {
            const app = createHttpApp({
              ...dependencies.httpOptions, commands: createCommandDashboard(store), projects: createProjectDashboard(store),
              approvals: approvalAdapter(store, dependencies.now ?? (() => new Date())), actions: actionAdapter(store, dependencies.dispatchControl)
            });
            httpApp = app;
            http = {
              async start() { await app.listen({ host: "127.0.0.1", port: 0 }); },
              async stopIngress() { await app.close(); }
            };
          }
          services = Object.freeze({ database, store, orca, locks, execution, hq: dependencies.hq, outbox,
            slackAdapter: dependencies.slackAdapter, telegramAdapter: dependencies.telegramAdapter,
            ...(httpApp === undefined ? {} : { httpApp }) });
          if (http === undefined) throw new Error("production HTTP security configuration is required");
        } catch (error) {
          if (database?.open) database.close();
          throw error;
        }
      },
      async checkpoint() {
        requireServices().database.pragma("wal_checkpoint(TRUNCATE)");
      },
      async close() {
        const database = requireServices().database;
        if (database.open) database.close();
      }
    },
    orca: { async check() { await orca.health(); } },
    reconcile: () => dependencies.reconcile(requireServices()),
    http: {
      async start() {
        if (http === undefined) throw new Error("production HTTP security configuration is required");
        await http.start();
      },
      async stopIngress() { await http?.stopIngress(); }
    },
    slack: dependencies.slack,
    telegram: dependencies.telegram,
    transactions: dependencies.transactions,
    commandFlow: dependencies.commandFlow,
    deliveries: dependencies.deliveries,
    audit: {
      append(input) {
        // The initial "starting" audit occurs before config validation; there is
        // intentionally no durable database to write on a rejected configuration.
        if (services === undefined || !services.database.open) return;
        services.store.appendAudit({ ...input, data: {
          state: input.data.state,
          degradedChannels: [...input.data.degradedChannels]
        } });
      }
    }
  });
  // Creating this adapter here ensures command/dashboard queries derive from the
  // actual ControlStore rather than host-provided fixtures once the process starts.
  return Object.freeze({ gateway, services: exposedServices });
}

/** Starts the concrete composition after the host supplied its external adapters and secret port. */
export async function startProductionGateway(
  config: GatewayConfig,
  dependencies: GatewayProductionDependencies
): Promise<Readonly<{ gateway: Gateway; services: GatewayProductionServices }>> {
  const composition = await createProductionGateway(config, dependencies);
  const removeAbortWiring = wireAbortSignals(composition.gateway);
  try {
    await composition.gateway.start();
  } catch (error) {
    removeAbortWiring();
    throw error;
  }
  return composition;
}
