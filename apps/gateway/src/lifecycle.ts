import { validateGatewayConfig, type GatewayConfig, type ValidatedGatewayConfig } from "./config.js";

export type { GatewayConfig } from "./config.js";

export type GatewayChannel = "slack" | "telegram";

export type GatewayStatus = Readonly<
  | { kind: "created"; degradedChannels: readonly GatewayChannel[] }
  | { kind: "starting"; degradedChannels: readonly GatewayChannel[] }
  | { kind: "running"; degradedChannels: readonly GatewayChannel[] }
  | { kind: "stopping"; degradedChannels: readonly GatewayChannel[] }
  | { kind: "stopped"; degradedChannels: readonly GatewayChannel[] }
  | { kind: "failed"; degradedChannels: readonly GatewayChannel[] }
>;

export type GatewayDiagnostic = Readonly<{
  channel: GatewayChannel;
  /** Stable, safe category only. Provider messages and credential details must not escape. */
  code: "channel_start_failed";
}>;

export interface GatewayConfigPort {
  /** Must include Keychain-backed secret access validation and reject on denial. */
  validate(config: ValidatedGatewayConfig): Promise<void>;
}

export interface GatewayDatabasePort {
  /** Runs the durable schema migration before any external ingress is started. */
  migrate(config: ValidatedGatewayConfig): Promise<void>;
  checkpoint(): Promise<void>;
  close(): Promise<void>;
}

export interface GatewayOrcaPort {
  /** Validates the existing Orca client version and capabilities. */
  check(): Promise<void>;
}

export interface GatewayIngressPort {
  start(): Promise<void>;
  stopIngress(): Promise<void>;
}

export interface GatewayTransactionPort {
  /** Stops only local claim processing; it must never stop or release an active Orca worker. */
  drain(input: Readonly<{ signal: AbortSignal; timeoutMs: number }>): Promise<void>;
}

export type GatewayCommand = Readonly<{
  commandId: string;
  channel: "slack" | "telegram" | "tailscale-web";
  text: string;
}>;

export type GatewayCommandResult = Readonly<{
  state: string;
  delivery?: string;
}>;

/**
 * This is the integration boundary where an already durable command/HQ/policy/
 * execution state machine is invoked. Gateway deliberately does not duplicate it.
 */
export interface GatewayCommandFlowPort {
  accept(command: GatewayCommand): Promise<GatewayCommandResult>;
}

export interface GatewayDeliveryPort {
  deliver(result: GatewayCommandResult): Promise<void>;
}

/** Durable, redacted lifecycle evidence. Implementations must reject secret-bearing data. */
export interface GatewayAuditPort {
  append(input: Readonly<{
    subjectId: string;
    eventType: "gateway.lifecycle";
    data: Readonly<{ state: GatewayStatus["kind"]; degradedChannels: readonly GatewayChannel[] }>;
  }>): Promise<void> | void;
}

export interface RuntimeAdapters {
  readonly config: GatewayConfigPort;
  readonly database: GatewayDatabasePort;
  readonly orca: GatewayOrcaPort;
  /** Reconciles durable queues, channel cursors, Outbox claims, and nonterminal Orca state. */
  readonly reconcile: () => Promise<void>;
  readonly http: GatewayIngressPort;
  readonly slack: GatewayIngressPort;
  readonly telegram: GatewayIngressPort;
  readonly transactions: GatewayTransactionPort;
  readonly commandFlow?: GatewayCommandFlowPort;
  readonly deliveries?: GatewayDeliveryPort;
  readonly audit?: GatewayAuditPort;
}

function snapshot(kind: GatewayStatus["kind"], channels: ReadonlySet<GatewayChannel>): GatewayStatus {
  return Object.freeze({ kind, degradedChannels: Object.freeze([...channels].sort()) }) as GatewayStatus;
}

function timeoutError(): Error {
  return Object.assign(new Error("gateway shutdown drain timed out"), { code: "gateway_drain_timeout" });
}

export class Gateway {
  readonly #config: ValidatedGatewayConfig;
  readonly #adapters: RuntimeAdapters;
  readonly #degraded = new Set<GatewayChannel>();
  readonly #startedChannels = new Set<GatewayChannel>();
  readonly #diagnostics: GatewayDiagnostic[] = [];
  #status: GatewayStatus = snapshot("created", this.#degraded);
  #databaseOpened = false;
  #httpStarted = false;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopRequested = false;

  constructor(config: ValidatedGatewayConfig, adapters: RuntimeAdapters) {
    this.#config = config;
    this.#adapters = adapters;
  }

  get status(): GatewayStatus {
    return this.#status;
  }

  get diagnostics(): readonly GatewayDiagnostic[] {
    return Object.freeze(this.#diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));
  }

  async start(): Promise<void> {
    if (this.#status.kind === "running") return;
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#status.kind !== "created") throw new Error(`Gateway cannot start from ${this.#status.kind}`);
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    this.#status = snapshot("starting", this.#degraded);
    await this.#audit();
    try {
      // No adapter capable of accepting external ingress appears before these durable checks.
      await this.#adapters.config.validate(this.#config);
      this.#throwIfStopRequested();
      await this.#adapters.database.migrate(this.#config);
      this.#databaseOpened = true;
      this.#throwIfStopRequested();
      await this.#adapters.orca.check();
      this.#throwIfStopRequested();
      await this.#adapters.reconcile();
      this.#throwIfStopRequested();
      await this.#adapters.http.start();
      this.#httpStarted = true;
      this.#throwIfStopRequested();
    } catch (error) {
      if (this.#databaseOpened) {
        try {
          await this.#adapters.database.close();
        } catch {
          // The original startup failure is the safe, actionable failure to surface.
        }
        this.#databaseOpened = false;
      }
      if (!this.#stopRequested) {
        this.#status = snapshot("failed", this.#degraded);
        await this.#audit();
      }
      throw error;
    }

    this.#throwIfStopRequested();
    await this.#startChannel("slack", this.#adapters.slack);
    this.#throwIfStopRequested();
    await this.#startChannel("telegram", this.#adapters.telegram);
    this.#throwIfStopRequested();
    this.#status = snapshot("running", this.#degraded);
    await this.#audit();
  }

  async acceptCommand(command: GatewayCommand): Promise<GatewayCommandResult> {
    if (this.#status.kind !== "running") throw new Error("Gateway is not accepting commands");
    if (this.#adapters.commandFlow === undefined) throw new Error("Gateway command flow is not configured");
    const result = await this.#adapters.commandFlow.accept(command);
    if (result.delivery !== undefined && this.#adapters.deliveries !== undefined) {
      await this.#adapters.deliveries.deliver(result);
    }
    return result;
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopRequested = true;
    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    if (this.#status.kind === "stopped") return;
    if (this.#status.kind === "created") {
      this.#status = snapshot("stopped", this.#degraded);
      await this.#audit();
      return;
    }
    this.#status = snapshot("stopping", this.#degraded);
    await this.#audit();
    if (this.#startPromise !== undefined) {
      try {
        await this.#startPromise;
      } catch {
        // Startup failure cleanup owns the opened database. Shutdown still finalizes its state below.
      }
    }
    let failure: unknown;
    if (this.#httpStarted || this.#startedChannels.size > 0) {
      try {
        await this.#stopIngress();
        await this.#drainTransactions();
      } catch (error) {
        failure = error;
      }
    }
    if (this.#databaseOpened) {
      try {
        await this.#adapters.database.checkpoint();
      } catch (error) {
        failure ??= error;
      }
      try {
        await this.#adapters.database.close();
        this.#databaseOpened = false;
      } catch (error) {
        failure ??= error;
      }
    }
    this.#status = snapshot("stopped", this.#degraded);
    await this.#audit();
    if (failure !== undefined) throw failure;
  }

  async #startChannel(channel: GatewayChannel, adapter: GatewayIngressPort): Promise<void> {
    try {
      await adapter.start();
      this.#startedChannels.add(channel);
    } catch {
      this.#degraded.add(channel);
      this.#diagnostics.push(Object.freeze({ channel, code: "channel_start_failed" }));
      await this.#audit();
    }
  }

  async #stopIngress(): Promise<void> {
    if (this.#startedChannels.has("telegram")) await this.#adapters.telegram.stopIngress();
    if (this.#startedChannels.has("slack")) await this.#adapters.slack.stopIngress();
    if (this.#httpStarted) await this.#adapters.http.stopIngress();
  }

  async #drainTransactions(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#config.shutdownDrainMs);
    const expiration = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(timeoutError()), { once: true });
    });
    try {
      await Promise.race([
        this.#adapters.transactions.drain({ signal: controller.signal, timeoutMs: this.#config.shutdownDrainMs }),
        expiration
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  #throwIfStopRequested(): void {
    if (this.#stopRequested) throw new Error("Gateway startup was stopped");
  }

  async #audit(): Promise<void> {
    await this.#adapters.audit?.append({
      subjectId: "gateway",
      eventType: "gateway.lifecycle",
      data: { state: this.#status.kind, degradedChannels: this.#status.degradedChannels }
    });
  }
}

/** Creates the process composition root while leaving credentials and external clients injected. */
export async function createGateway(config: GatewayConfig, adapters: RuntimeAdapters): Promise<Gateway> {
  return new Gateway(validateGatewayConfig(config), adapters);
}
