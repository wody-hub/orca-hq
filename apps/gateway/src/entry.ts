import { createGatewayHost, type GatewayHostFactory } from "./host.js";
import { startProductionGateway } from "./production.js";

export type { GatewayHostFactory } from "./host.js";

/** Starts the repository-owned host; tests inject only external/secret boundaries. */
export async function run(bootstrap: GatewayHostFactory = createGatewayHost) {
  const host = await bootstrap();
  return startProductionGateway(host.config, host.dependencies);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void run();
}
