import { createGatewayHost, type GatewayHostBootstrap } from "./host.js";
import { startProductionGateway } from "./production.js";

export type { GatewayHostBootstrap } from "./host.js";

/** Starts the repository-owned host; tests inject only external/secret boundaries. */
export async function run(bootstrap: GatewayHostBootstrap = createGatewayHost): Promise<void> {
  const host = await bootstrap();
  await startProductionGateway(host.config, host.dependencies);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void run();
}
