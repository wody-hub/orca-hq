import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { it, expect } from "vitest";
import { OperationsHttp } from "../src/operations-http.js";

it.each(["claim", "mutation", "refresh"] as const)("rejects %s expiry during asynchronous body delivery", async (action) => {
  let now = 1000, effects = 0;
  const origin = "http://127.0.0.1:4310";
  const http = new OperationsHttp({ now: () => now, route: async () => { effects++; return { state: "accepted" }; } });
  http.setOrigin(origin);
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}, advance = 0) => {
    const result = { status: 0, body: "", headers: {} as Record<string, string> };
    const req = {
      url: path, method: "POST", socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:4310", origin, "content-type": "application/json", ...headers },
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        now += advance;
        yield Buffer.from(JSON.stringify(body));
      },
    } as unknown as IncomingMessage;
    const res = {
      writableEnded: false,
      setHeader(name: string, value: string) { result.headers[name] = value; },
      writeHead(status: number) { result.status = status; },
      end(this: { writableEnded: boolean }, body: string) { result.body = body; this.writableEnded = true; },
    } as unknown as ServerResponse;
    await http.handle(req, res);
    return result;
  };
  try {
    const claim = new URL(http.issueClaim().url).hash.slice(7);
    if (action === "claim") {
      const expired = await call("/auth/local/claim", { claim }, {}, 60000);
      expect(expired.status).toBe(401);
      expect(JSON.parse(expired.body)).toEqual({ error: "claim_expired" });
      expect(expired.headers["Set-Cookie"]).toBeUndefined();
      expect((await call("/auth/local/claim", { claim })).status).toBe(401);
    } else {
      const session = await call("/auth/local/claim", { claim });
      expect(session.status).toBe(200);
      const headers = { cookie: session.headers["Set-Cookie"]!, "x-csrf-token": JSON.parse(session.body).csrf as string, "idempotency-key": "request" };
      const expired = await call(action === "refresh" ? "/auth/local/refresh" : "/api/operations/hq/requests", {}, headers, 1800000);
      expect(expired.status).toBe(401);
      expect(JSON.parse(expired.body)).toEqual({ error: "session_required" });
      expect(expired.headers["Set-Cookie"]).toBeUndefined();
    }
    expect(effects).toBe(0);
  } finally { http.close(); }
});
it("fences peer, host, origin, single-use claim, session/CSRF and body size", async () => {
  let now = 1000,
    effects = 0;
  const http = new OperationsHttp({
    now: () => now,
    route: async () => {
      effects++;
      return { ok: true };
    },
  });
  const server = createServer((req, res) => {
    void http.handle(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  http.setOrigin(origin);
  const call = async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    expect(http.isLocal("10.0.0.1", `127.0.0.1:${port}`)).toBe(false);
    expect((await call("/api/operations/status")).status).toBe(401);
    expect(
      await new Promise<number>((resolve) => {
        const req = request(
          origin + "/auth/local/claim",
          { method: "POST", headers: { host: "evil", origin } },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.end("{}");
      }),
    ).toBe(403);
    const claim = http.issueClaim();
    const token = new URL(claim.url).hash.slice(7);
    expect(
      (
        await call(
          "/auth/local/claim",
          { claim: token },
          { origin: "http://evil" },
        )
      ).status,
    ).toBe(403);
    const result = await call("/auth/local/claim", { claim: token });
    expect(result.status).toBe(200);
    const cookie = result.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const { csrf } = (await result.json()) as { csrf: string };
    expect((await call("/auth/local/claim", { claim: token })).status).toBe(
      401,
    );
    expect(
      (await call("/api/operations/status", undefined, { cookie })).status,
    ).toBe(200);
    expect(
      (
        await call(
          "/api/operations/hq/requests",
          {},
          { cookie, "idempotency-key": "req" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "/api/operations/hq/requests",
          {},
          { cookie, "x-csrf-token": csrf, "idempotency-key": "req" },
        )
      ).status,
    ).toBe(202);
    expect(effects).toBe(2);
    expect(
      (
        await call(
          "/api/operations/hq/requests",
          { text: "x".repeat(17000) },
          { cookie, "x-csrf-token": csrf, "idempotency-key": "large" },
        )
      ).status,
    ).toBe(413);
    expect(
      (await call("/auth/local/refresh", {}, { cookie, "x-csrf-token": csrf }))
        .status,
    ).toBe(200);
    now += 1800001;
    expect(
      (await call("/api/operations/status", undefined, { cookie })).status,
    ).toBe(401);
    const expired = http.issueClaim();
    now += 60001;
    expect(
      (
        await call("/auth/local/claim", {
          claim: new URL(expired.url).hash.slice(7),
        })
      ).status,
    ).toBe(401);
  } finally {
    http.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
