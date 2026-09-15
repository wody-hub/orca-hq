import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
export class OperationsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const token = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class OperationsHttp {
  private origin = "";
  private claims = new Map<string, number>();
  private sessions = new Map<string, { csrf: string; expiresAt: number }>();
  private readonly now: () => number;
  constructor(
    private readonly options: {
      route(
        method: string,
        url: URL,
        body: unknown,
        key?: string,
      ): Promise<unknown>;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }
  setOrigin(origin: string) {
    const u = new URL(origin);
    if (
      u.protocol !== "http:" ||
      u.hostname !== "127.0.0.1" ||
      u.origin !== origin
    )
      throw Error("invalid_operations_origin");
    this.origin = origin;
  }
  isLocal(peer: string | undefined, host: string | undefined) {
    return (
      !!this.origin &&
      (peer === "127.0.0.1" || peer === "::ffff:127.0.0.1") &&
      host === new URL(this.origin).host
    );
  }
  private prune() {
    for (const [k, v] of this.claims)
      if (v <= this.now()) this.claims.delete(k);
    for (const [k, v] of this.sessions)
      if (v.expiresAt <= this.now()) this.sessions.delete(k);
  }
  issueClaim() {
    if (!this.origin) throw Error("operations_not_ready");
    this.prune();
    if (this.claims.size >= 100) throw Error("claim_limit");
    const claim = token(),
      expiresAt = this.now() + 60000;
    this.claims.set(claim, expiresAt);
    return {
      url: `${this.origin}/#claim=${claim}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (
      !req.url?.startsWith("/api/operations") &&
      !req.url?.startsWith("/auth/local/")
    )
      return false;
    const send = (status: number, value: unknown) => {
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > 2097152) {
        res.writeHead(502);
        res.end('{"error":"output_overflow"}');
        return;
      }
      res.writeHead(status);
      res.end(encoded);
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    try {
      if (
        !this.isLocal(req.socket.remoteAddress, req.headers.host) ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new OperationsError(403, "local_only");
      const url = new URL(req.url, this.origin);
      if (url.origin !== this.origin)
        throw new OperationsError(403, "local_only");
      if (
        req.headers.origin !== undefined &&
        req.headers.origin !== this.origin
      )
        throw new OperationsError(403, "origin_required");
      const mutation = req.method === "POST";
      if (req.method !== "GET" && !mutation)
        throw new OperationsError(405, "method_not_allowed");
      if (mutation && req.headers.origin !== this.origin)
        throw new OperationsError(403, "origin_required");
      this.prune();
      let body: unknown;
      if (mutation) {
        if (
          !/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")
        )
          throw new OperationsError(415, "json_required");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const b = Buffer.from(chunk);
          size += b.length;
          if (size > 16384) throw new OperationsError(413, "body_too_large");
          chunks.push(b);
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new OperationsError(400, "invalid_json");
        }
      }
      if (url.pathname === "/auth/local/claim" && mutation) {
        const { claim } = z
          .object({ claim: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
          .strict()
          .parse(body);
        const claimDeadline = this.claims.get(claim);
        // No await between checking the deadline and consuming this claim.
        if (!this.claims.delete(claim) || claimDeadline === undefined || claimDeadline <= this.now())
          throw new OperationsError(401, "claim_expired");
        if (this.sessions.size >= 100)
          throw new OperationsError(429, "session_limit");
        const session = token(),
          csrf = token(),
          expiresAt = this.now() + 1800000;
        this.sessions.set(session, { csrf, expiresAt });
        res.setHeader(
          "Set-Cookie",
          `hq_operations=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`,
        );
        send(200, { csrf, expiresAt: new Date(expiresAt).toISOString() });
        return true;
      }
      const cookies = (req.headers.cookie ?? "")
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("hq_operations="));
      const session =
        cookies.length === 1
          ? this.sessions.get(cookies[0]!.slice(14))
          : undefined;
      // Body consumption may have crossed the deadline since the initial prune.
      // Authentication through refresh/route invocation below is synchronous.
      if (!session || session.expiresAt <= this.now())
        throw new OperationsError(401, "session_required");
      if (
        mutation &&
        (typeof req.headers["x-csrf-token"] !== "string" ||
          !equal(req.headers["x-csrf-token"], session.csrf))
      )
        throw new OperationsError(403, "csrf_required");
      if (url.pathname === "/auth/local/refresh" && mutation) {
        z.object({}).strict().parse(body);
        session.csrf = token();
        send(200, {
          csrf: session.csrf,
          expiresAt: new Date(session.expiresAt).toISOString(),
        });
        return true;
      }
      const key = req.headers["idempotency-key"];
      if (
        mutation &&
        (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(key))
      )
        throw new OperationsError(400, "idempotency_key_required");
      const result = await this.options.route(
        req.method!,
        url,
        body,
        typeof key === "string" ? key : undefined,
      );
      const state = (result as { state?: string } | null)?.state;
      send(
        mutation
          ? state === "rejected"
            ? 409
            : state === "unknown"
              ? 502
              : 202
          : 200,
        result,
      );
    } catch (error) {
      if (res.writableEnded) return true;
      if (error instanceof OperationsError)
        send(error.status, { error: error.code });
      else if (error instanceof z.ZodError)
        send(400, { error: "invalid_input" });
      else if (
        error instanceof Error &&
        error.message === "idempotency_conflict"
      )
        send(409, { error: "idempotency_conflict" });
      else send(502, { error: "operations_unavailable" });
    }
    return true;
  }
  close() {
    this.claims.clear();
    this.sessions.clear();
  }
}
