import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { createGatewayHost, type GatewayHostFactory } from "./host.js";
import { startProductionGateway } from "./production.js";
import { startManagedRuntime } from "./managed-runtime.js";

export type { GatewayHostFactory } from "./host.js";

/** Starts the repository-owned host; tests inject only external/secret boundaries. */
export async function run(bootstrap: GatewayHostFactory = createGatewayHost) {
  const host = await bootstrap();
  return startProductionGateway(host.config, host.dependencies);
}

export async function runInstalledGateway(options: {
  local?: () => Promise<{ stop(): Promise<void> }>;
  external?: () => Promise<{ stop(): Promise<void> }>;
} = {}): Promise<{ stop(): Promise<void> }> {
  if (process.env.GATEWAY_EXTERNAL_ADAPTERS === undefined) {
    // Allow high-latency IPv4 handshakes before falling back to unavailable IPv6.
    setDefaultAutoSelectFamilyAttemptTimeout(Math.max(2000, getDefaultAutoSelectFamilyAttemptTimeout()));
    return await (options.local ?? startManagedRuntime)();
  }
  return await (options.external ?? (async () => {
    const runtime = await run();
    return { stop: async () => { await runtime.gateway.stop(); } };
  }))();
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void runInstalledGateway().then(runtime => {
    const stop = () => { void runtime.stop().then(() => process.exit(0), () => process.exit(1)); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdout.write("Orca HQ 운영 연결이 시작됐습니다.\n");
  }).catch(() => {
    process.stderr.write("Orca HQ 시작 실패: 설정·채널 인증정보·소유자 연결·프로젝트 등록 상태를 확인하세요.\n");
    process.exitCode = 1;
  });
}
