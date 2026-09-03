import { describe, expect, it, vi } from "vitest";

import { createDashboardApi, DashboardApiError } from "./api.js";

function response(status: number, body?: unknown, headers?: HeadersInit): Response {
  const init: ResponseInit = { status };
  if (headers !== undefined) init.headers = headers;
  return new Response(body === undefined ? null : JSON.stringify(body), init);
}

describe("dashboard API session recovery", () => {
  it("reestablishes a session once before retrying a query that receives 401", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(204, undefined, { "x-csrf-token": "fresh-csrf" }))
      .mockResolvedValueOnce(response(200, { commands: [] }));
    const api = createDashboardApi(fetcher);

    await expect(api.listCommands()).resolves.toEqual({ commands: [] });

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/commands", "/auth/session", "/api/commands"]);
  });

  it("reuses a mutation idempotency key while retrying with a fresh CSRF token", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(204, undefined, { "x-csrf-token": "stale-csrf" }))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(204, undefined, { "x-csrf-token": "fresh-csrf" }))
      .mockResolvedValueOnce(response(204));
    const api = createDashboardApi(fetcher);
    await api.bootstrap();

    await expect(api.stopDispatch("dispatch-42")).resolves.toBeUndefined();

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/auth/session", "/api/actions/stop", "/auth/session", "/api/actions/stop"]);
    const firstAttempt = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    const retryAttempt = new Headers(fetcher.mock.calls[3]?.[1]?.headers);
    expect(firstAttempt.get("x-csrf-token")).toBe("stale-csrf");
    expect(retryAttempt.get("x-csrf-token")).toBe("fresh-csrf");
    expect(retryAttempt.get("idempotency-key")).toBe(firstAttempt.get("idempotency-key"));
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ dispatchId: "dispatch-42" }));
    expect(fetcher.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({ dispatchId: "dispatch-42" }));
  });

  it("stops after one recovery attempt when a query remains unauthorized", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(204, undefined, { "x-csrf-token": "fresh-csrf" }))
      .mockResolvedValueOnce(response(401));
    const api = createDashboardApi(fetcher);

    await expect(api.listCommands()).rejects.toEqual(expect.objectContaining<Partial<DashboardApiError>>({ status: 401 }));

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/commands", "/auth/session", "/api/commands"]);
  });

  it("does not retry when session recovery itself fails", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(503));
    const api = createDashboardApi(fetcher);

    await expect(api.listCommands()).rejects.toEqual(expect.objectContaining<Partial<DashboardApiError>>({ status: 503 }));

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/commands", "/auth/session"]);
  });

  it("does not retry a failed session bootstrap request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(401));
    const api = createDashboardApi(fetcher);

    await expect(api.bootstrap()).rejects.toEqual(expect.objectContaining<Partial<DashboardApiError>>({ status: 401 }));

    expect(fetcher).toHaveBeenCalledOnce();
  });
});
