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
import { createCommandDashboard } from "./dashboard.js";
import { createHttpApp, type GatewayHttpOptions } from "./http.js";

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
  for (const key of ["database", "store", "orca", "locks", "execution", "hq", "outbox", "slackAdapter", "telegramAdapter"] as const) {
    Object.defineProperty(exposedServices, key, { enumerable: true, get: () => requireServices()[key] });
  }
  const gateway = await createGateway(config, {
    config: dependencies.config,
    database: {
      async migrate() {
        // openDatabase owns WAL, foreign keys, and idempotent migration.
        const database = openDatabase(config.databasePath);
        const store = new ControlStore(database);
        const locks = new WorktreeLockService(store);
        const lifecycle = new ExecutionLifecycle({ store });
        const execution = new ExecutionService({ ...dependencies.execution, orca, locks, lifecycle });
        const outbox = new OutboxDispatcher({ ...dependencies.outbox, store });
        services = Object.freeze({ database, store, orca, locks, execution, hq: dependencies.hq, outbox,
          slackAdapter: dependencies.slackAdapter, telegramAdapter: dependencies.telegramAdapter });
        if (dependencies.httpOptions !== undefined) {
          const app = createHttpApp({ ...dependencies.httpOptions, commands: createCommandDashboard(store) });
          http = {
            async start() { await app.listen({ host: "127.0.0.1", port: 0 }); },
            async stopIngress() { await app.close(); }
          };
        }
        if (http === undefined) throw new Error("production HTTP security configuration is required");
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
