export type RiskLevel = "L0" | "L1" | "L2" | "L3" | "unknown";
export type DeliveryStatus = "pending" | "sent" | "failed";
export type VerificationStatus = "passed" | "pending" | "failed";

export interface CommandSummary {
  readonly id: string;
  readonly summary: string;
  readonly status: string;
  readonly projectKey: string;
  readonly riskLevel: RiskLevel;
  readonly updatedAt: string;
}

export interface CommandDetail extends CommandSummary {
  readonly createdAt: string;
  readonly project: Readonly<{ key: string; displayName: string; path: string }>;
  readonly routing: Readonly<{ score: number; selectedReason: string; candidates: readonly string[] }>;
  readonly contract: Readonly<{
    base: string;
    allowedScope: readonly string[];
    prohibitedEffects: readonly string[];
    testCommands: readonly string[];
  }>;
  readonly tasks: readonly Readonly<{
    id: string;
    title: string;
    status: string;
    dependencies: readonly string[];
    workerFamily: string;
    verifierFamily: string;
    dispatchId: string;
    dispatchStatus: string;
    canStop: boolean;
    canRetry: boolean;
  }>[];
  readonly verification: Readonly<{ status: VerificationStatus; commands: readonly string[] }>;
  readonly diff: Readonly<{ summary: string }>;
  readonly approval: Readonly<{
    id: string;
    level: "L2" | "L3" | "unknown";
    digest: string;
    expiresAt: string;
    operationPhrase?: string;
    status: "pending" | "approved" | "expired" | "denied";
    permitted: boolean;
  }>;
  readonly audit: Readonly<{ reference: string; summary: string }>;
  readonly delivery: readonly Readonly<{ channel: string; status: DeliveryStatus }>[];
}

export interface DashboardApi {
  bootstrap(): Promise<void>;
  listCommands(): Promise<Readonly<{ commands: readonly CommandSummary[] }>>;
  getCommand(id: string): Promise<CommandDetail>;
  confirmApproval(id: string, input: Readonly<{ digest: string; phrase?: string }>): Promise<void>;
  stopDispatch(dispatchId: string): Promise<void>;
  retryDispatch(dispatchId: string): Promise<void>;
}

export class DashboardApiError extends Error {
  constructor(readonly status?: number) { super("dashboard_api_error"); }
}

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function createDashboardApi(fetcher: typeof fetch = fetch): DashboardApi {
  let csrfToken: string | undefined;
  const bootstrap = async (): Promise<void> => {
    try {
      const response = await fetcher("/auth/session", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new DashboardApiError(response.status);
      csrfToken = response.headers.get("x-csrf-token") ?? undefined;
    } catch (error) {
      if (error instanceof DashboardApiError) throw error;
      throw new DashboardApiError();
    }
  };
  const request = async <T>(path: string, init: RequestInit | (() => RequestInit) = {}, canRecover = true): Promise<T> => {
    try {
      const requestInit = typeof init === "function" ? init() : init;
      const response = await fetcher(path, { credentials: "same-origin", ...requestInit });
      if (!response.ok) {
        if (response.status === 401 && canRecover) {
          await bootstrap();
          return request(path, init, false);
        }
        throw new DashboardApiError(response.status);
      }
      return response.status === 204 ? undefined as T : await response.json() as T;
    } catch (error) {
      if (error instanceof DashboardApiError) throw error;
      throw new DashboardApiError();
    }
  };
  const mutation = async (path: string, body: object): Promise<void> => {
    const key = idempotencyKey();
    await request(path, () => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken ?? "",
        "idempotency-key": key
      },
      body: JSON.stringify(body)
    }));
  };
  return {
    bootstrap,
    listCommands: () => request("/api/commands"),
    getCommand: (id) => request(`/api/commands/${encodeURIComponent(id)}`),
    confirmApproval: (id, input) => mutation(`/api/approvals/${encodeURIComponent(id)}/confirm`, input),
    stopDispatch: (dispatchId) => mutation("/api/actions/stop", { dispatchId }),
    retryDispatch: (dispatchId) => mutation("/api/actions/retry", { dispatchId })
  };
}
