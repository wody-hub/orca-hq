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

/**
 * The concrete process composition boundary. Network/Keychain handles remain
 * injected, while durable storage, Orca, locking, execution, and outbox use
 * their public concrete implementations exactly once.
 */
export interface GatewayProductionDependencies {
  readonly config: GatewayConfigPort;
  readonly orca: OrcaClientOptions;
  readonly execution: Omit<ConstructorParameters<typeof ExecutionService>[0], "orca" | "locks" | "lifecycle">;
  readonly hq: CodexHqSession;
  readonly slackAdapter: SlackAdapter;
  readonly telegramAdapter: TelegramAdapter;
  readonly http: GatewayIngressPort;
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
  readonly orca: OrcaClient;
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
  // openDatabase owns WAL, foreign keys, and idempotent migrations; no shadow DB layer is created.
  const database = openDatabase(config.databasePath);
  const store = new ControlStore(database);
  const orca = new OrcaClient(dependencies.orca);
  const locks = new WorktreeLockService(store);
  const lifecycle = new ExecutionLifecycle({ store });
  const execution = new ExecutionService({
    ...dependencies.execution,
    orca,
    locks,
    lifecycle
  });
  const outbox = new OutboxDispatcher({ ...dependencies.outbox, store });
  const services = Object.freeze({
    database, store, orca, locks, execution, hq: dependencies.hq, outbox,
    slackAdapter: dependencies.slackAdapter, telegramAdapter: dependencies.telegramAdapter
  });
  const gateway = await createGateway(config, {
    config: dependencies.config,
    database: {
      async migrate() {
        // openDatabase performed the idempotent migration before the store was constructed.
      },
      async checkpoint() {
        database.pragma("wal_checkpoint(TRUNCATE)");
      },
      async close() {
        if (database.open) database.close();
      }
    },
    orca: { async check() { await orca.health(); } },
    reconcile: () => dependencies.reconcile(services),
    http: dependencies.http,
    slack: dependencies.slack,
    telegram: dependencies.telegram,
    transactions: dependencies.transactions,
    commandFlow: dependencies.commandFlow,
    deliveries: dependencies.deliveries,
    audit: {
      append(input) {
        store.appendAudit({ ...input, data: {
          state: input.data.state,
          degradedChannels: [...input.data.degradedChannels]
        } });
      }
    }
  });
  return Object.freeze({ gateway, services });
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
