import type { GatewayConfig } from "./lifecycle.js";
import type { GatewayProductionDependencies } from "./production.js";

export type GatewayHostBootstrap = () => Promise<Readonly<{
  config: GatewayConfig;
  dependencies: GatewayProductionDependencies;
}>>;

/** Repository-owned host; only Keychain and external-I/O adapters stay deployment-provided. */
export async function createGatewayHost(): Promise<Readonly<{
  config: GatewayConfig;
  dependencies: GatewayProductionDependencies;
}>> {
  const moduleUrl = process.env.GATEWAY_EXTERNAL_ADAPTERS;
  if (moduleUrl === undefined || !moduleUrl.startsWith("file:")) {
    throw new Error("Gateway configuration or secret provider is unavailable");
  }
  const loaded = await import(moduleUrl) as unknown;
  if (typeof loaded !== "object" || loaded === null || !("createGatewayExternalAdapters" in loaded)
    || typeof loaded.createGatewayExternalAdapters !== "function") {
    throw new Error("Gateway configuration or secret provider is unavailable");
  }
  return await (loaded.createGatewayExternalAdapters as GatewayHostBootstrap)();
}
