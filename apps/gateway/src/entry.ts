import type { GatewayConfig } from "./lifecycle.js";
import { startProductionGateway, type GatewayProductionDependencies } from "./production.js";

type GatewayHostBootstrap = () => Promise<Readonly<{
  config: GatewayConfig;
  dependencies: GatewayProductionDependencies;
}>>;

async function run(): Promise<void> {
  const moduleUrl = process.env.GATEWAY_HOST_BOOTSTRAP;
  if (moduleUrl === undefined || !moduleUrl.startsWith("file:")) {
    throw new Error("GATEWAY_HOST_BOOTSTRAP must name a local typed host bootstrap module");
  }
  const loaded = await import(moduleUrl) as unknown;
  if (typeof loaded !== "object" || loaded === null || !("createGatewayHost" in loaded)
    || typeof loaded.createGatewayHost !== "function") {
    throw new Error("Gateway host bootstrap must export createGatewayHost");
  }
  const host = await (loaded.createGatewayHost as GatewayHostBootstrap)();
  await startProductionGateway(host.config, host.dependencies);
}

void run();
