const defaultHealthUrl = "http://127.0.0.1:4310/health";

type HealthResponse = Readonly<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export interface GatewayReadinessProbe {
  waitForRunning(expectedPid: number): Promise<Readonly<{ ready: boolean }>>;
}

export interface HttpReadinessOptions {
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly request?: (url: string, init: Readonly<{ signal: AbortSignal }>) => Promise<HealthResponse>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function isExpectedHealth(value: unknown, expectedPid: number): boolean {
  if (value === null || typeof value !== "object") return false;
  const health = value as {
    service?: unknown;
    mode?: unknown;
    state?: unknown;
    pid?: unknown;
    channels?: { slack?: unknown; telegram?: unknown };
  };
  const processMatches = health.service === "orca-hq"
    && health.state === "running"
    && health.pid === expectedPid;
  if (!processMatches) return false;
  if (health.mode === "managed") return true;
  return health.mode === "text-only"
    && health.channels?.slack === true
    && health.channels.telegram === true;
}

/** Allows native recovery up to 60 seconds by default and verifies launchd PID ownership. */
export function createHttpReadinessProbe(options: HttpReadinessOptions = {}): GatewayReadinessProbe {
  const url = options.url ?? defaultHealthUrl;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (async (milliseconds) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const request = options.request ?? (async (target, init) => await fetch(target, init));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new TypeError("readiness timing is invalid");
  }
  return Object.freeze({
    async waitForRunning(expectedPid: number) {
      if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) return Object.freeze({ ready: false });
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        try {
          const remaining = Math.max(1, deadline - now());
          const response = await request(url, { signal: AbortSignal.timeout(remaining) });
          if (response.ok && isExpectedHealth(await response.json(), expectedPid)) {
            return Object.freeze({ ready: true });
          }
        } catch {
          // The gateway may still be starting. Retry only within the fixed deadline.
        }
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(pollIntervalMs, remaining));
      }
      return Object.freeze({ ready: false });
    }
  });
}
