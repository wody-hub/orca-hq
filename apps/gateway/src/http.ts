import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { AuthenticatedPrincipal, IdentityResolver, PrincipalBinding } from "@orca-hq/core";
import {
  readLocalSessionCookie,
  resolveTailnetLogin,
  resolveTailnetPrincipal,
  type LocalSessionService
} from "@orca-hq/tailscale-adapter";

export interface GatewayHttpOptions {
  readonly bindings: readonly PrincipalBinding[];
  readonly resolver: IdentityResolver;
  readonly sessions: LocalSessionService;
  readonly peerAddress?: (request: FastifyRequest) => string;
  readonly onCommands?: (principal: AuthenticatedPrincipal) => unknown | Promise<unknown>;
}

function unauthorized(reply: { code(statusCode: number): { send(body: { error: string }): unknown } }): unknown {
  return reply.code(401).send({ error: "unauthorized" });
}

export function createHttpApp(options: GatewayHttpOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: false });
  const peerAddress = options.peerAddress ?? ((request: FastifyRequest) => request.raw.socket.remoteAddress ?? "");
  const inputFor = (request: FastifyRequest) => ({
    remoteAddress: peerAddress(request),
    headers: request.headers
  });

  app.post("/auth/session", async (request, reply) => {
    const login = resolveTailnetLogin(inputFor(request), options.bindings);
    if ("kind" in login) return unauthorized(reply);
    const issued = options.sessions.startLocalSession(login);
    reply.header("set-cookie", issued.cookie);
    return reply.code(204).send();
  });

  app.get("/api/commands", async (request, reply) => {
    const principal = resolveTailnetPrincipal({
      ...inputFor(request),
      session: readLocalSessionCookie(request.headers.cookie),
      bindings: options.bindings,
      resolver: options.resolver,
      sessions: options.sessions
    });
    if ("kind" in principal) return unauthorized(reply);
    try {
      return await (options.onCommands?.(principal) ?? { commands: [] });
    } catch {
      return reply.code(500).send({ error: "internal_error" });
    }
  });

  return app;
}
