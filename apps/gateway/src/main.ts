import { createGateway, type Gateway, type GatewayConfig, type RuntimeAdapters } from "./lifecycle.js";

export interface AbortSignalSource {
  readonly signals: readonly NodeJS.Signals[];
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

const processSignals: AbortSignalSource = {
  signals: ["SIGINT", "SIGTERM"],
  once: (signal, listener) => process.once(signal, listener),
  removeListener: (signal, listener) => process.removeListener(signal, listener)
};

/** Installs process wiring only; lifecycle sequencing remains fully injectable and testable. */
export function wireAbortSignals(gateway: Gateway, source: AbortSignalSource = processSignals): () => void {
  let stopping: Promise<void> | undefined;
  const stop = (): void => {
    stopping ??= gateway.stop().catch(() => undefined);
  };
  for (const signal of source.signals) source.once(signal, stop);
  return () => {
    for (const signal of source.signals) source.removeListener(signal, stop);
  };
}

export async function startGateway(config: GatewayConfig, adapters: RuntimeAdapters): Promise<Gateway> {
  const gateway = await createGateway(config, adapters);
  const removeAbortWiring = wireAbortSignals(gateway);
  try {
    await gateway.start();
    return gateway;
  } catch (error) {
    removeAbortWiring();
    throw error;
  }
}
