import type { GatewayConfig } from "./lifecycle.js";
import { startProductionGateway, type GatewayProductionDependencies } from "./production.js";

type GatewayHostBootstrap = () => Promise<Readonly<{
  config: GatewayConfig;
  dependencies: GatewayProductionDependencies;
}>>;

export async function run(): Promise<void> {
  const moduleUrl = process.env.GATEWAY_HOST_BOOTSTRAP;
  if (moduleUrl === undefined || !moduleUrl.startsWith("file:")) {
    // Deliberately redacted: a process without its injected secret/client host
    // fails closed as configuration, never as a missing repository module.
    throw new Error("Gateway configuration or secret provider is unavailable");
  }
  const loaded = await import(moduleUrl) as unknown;
  if (typeof loaded !== "object" || loaded === null || !("createGatewayHost" in loaded)
    || typeof loaded.createGatewayHost !== "function") {
    throw new Error("Gateway host bootstrap must export createGatewayHost");
  }
  const host = await (loaded.createGatewayHost as GatewayHostBootstrap)();
  await startProductionGateway(host.config, host.dependencies);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void run();
}
