import { randomBytes } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";

import type { AuthenticatedPrincipal, IdentityResolver, PrincipalBinding } from "@orca-hq/core";
import {
  readLocalSessionCookie,
  resolveTailnetLogin,
  resolveTailnetPrincipal,
  type LocalSessionService
} from "@orca-hq/tailscale-adapter";
import { registerActionRoutes, type DispatchActionPort } from "./routes/actions.js";
import { registerApprovalRoutes, type ApprovalConfirmationPort } from "./routes/approvals.js";
import { registerCommandRoutes, type CommandDashboardPort } from "./routes/commands.js";
import { registerProjectRoutes, type ProjectDashboardPort } from "./routes/projects.js";

export type { DispatchActionPort } from "./routes/actions.js";
export type { ApprovalConfirmationPort } from "./routes/approvals.js";
export type { CommandDashboardPort } from "./routes/commands.js";
export type { ProjectDashboardPort } from "./routes/projects.js";

export interface GatewayHttpOptions {
  readonly bindings: readonly PrincipalBinding[];
  readonly resolver: IdentityResolver;
  readonly sessions: LocalSessionService;
  readonly peerAddress?: (request: FastifyRequest) => string;
  /** The one HTTPS dashboard origin allowed to submit state-changing requests. */
  readonly allowedOrigin?: string;
  /** Redacted dashboard queries; never pass persistence rows or channel credentials here. */
  readonly commands?: CommandDashboardPort;
  readonly projects?: ProjectDashboardPort;
  /** Adapter supplied by Task 5, which restores immutable server state before confirmation. */
  readonly approvals?: ApprovalConfirmationPort;
  /** Adapter supplied by Task 5, which owns durable idempotency and redacted audit writes. */
  readonly actions?: DispatchActionPort;
  /** @deprecated retained only for the Task 2 authentication route test. */
  readonly onCommands?: (principal: AuthenticatedPrincipal) => unknown | Promise<unknown>;
}

type ErrorReply = Pick<FastifyReply, "code">;

function unauthorized(reply: ErrorReply): unknown {
  return reply.code(401).send({ error: "unauthorized" });
}

function forbidden(reply: ErrorReply): unknown {
  return reply.code(403).send({ error: "forbidden" });
}

function badRequest(reply: ErrorReply): unknown {
  return reply.code(400).send({ error: "bad_request" });
}

function notFound(reply: ErrorReply): unknown {
  return reply.code(404).send({ error: "not_found" });
}

function internalError(reply: ErrorReply): unknown {
  return reply.code(500).send({ error: "internal_error" });
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes(",")) return undefined;
  return value;
}

function isConfiguredHttpsOrigin(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const origin = new URL(value);
    return origin.protocol === "https:" && origin.origin === value;
  } catch {
    return false;
  }
}

function recognizedRole(principal: AuthenticatedPrincipal): boolean {
  return principal.roles.length > 0 && principal.roles.every((role) =>
    role === "owner" || role === "operator" || role === "viewer");
}

export interface GatewayRouteContext {
  authenticate(request: FastifyRequest): AuthenticatedPrincipal | undefined;
  canView(principal: AuthenticatedPrincipal): boolean;
  canMutate(principal: AuthenticatedPrincipal): boolean;
  requireMutationSecurity(request: FastifyRequest, principal: AuthenticatedPrincipal):
    | Readonly<{ kind: "allowed"; idempotencyKey: string }>
    | Readonly<{ kind: "bad_request" | "forbidden" }>;
  unauthorized(reply: ErrorReply): unknown;
  forbidden(reply: ErrorReply): unknown;
  badRequest(reply: ErrorReply): unknown;
  notFound(reply: ErrorReply): unknown;
  internalError(reply: ErrorReply): unknown;
}

export function createHttpApp(options: GatewayHttpOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: false });
  app.setErrorHandler((error, _request, reply) => error instanceof ZodError ? badRequest(reply) : internalError(reply));
  app.setNotFoundHandler((_request, reply) => notFound(reply));
  const peerAddress = options.peerAddress ?? ((request: FastifyRequest) => request.raw.socket.remoteAddress ?? "");
  const inputFor = (request: FastifyRequest) => ({
    remoteAddress: peerAddress(request),
    headers: request.headers
  });
  const csrfSessions = new Map<string, Readonly<{ principalId: string; token: string }>>();

  const authenticate = (request: FastifyRequest): AuthenticatedPrincipal | undefined => {
    const sessionToken = readLocalSessionCookie(request.headers.cookie);
    const principal = resolveTailnetPrincipal({
      ...inputFor(request),
      session: sessionToken,
      bindings: options.bindings,
      resolver: options.resolver,
      sessions: options.sessions
    });
    return "kind" in principal ? undefined : principal;
  };

  const context: GatewayRouteContext = {
    authenticate,
    canView: (principal) => recognizedRole(principal),
    canMutate: (principal) => recognizedRole(principal) && principal.roles.some((role) =>
      role === "owner" || role === "operator"),
    requireMutationSecurity: (request, principal) => {
      const origin = singleHeader(request.headers.origin);
      if (!isConfiguredHttpsOrigin(options.allowedOrigin) || origin !== options.allowedOrigin) return { kind: "forbidden" };
      const sessionToken = readLocalSessionCookie(request.headers.cookie);
      const csrf = singleHeader(request.headers["x-csrf-token"]);
      const session = sessionToken === undefined ? undefined : csrfSessions.get(sessionToken);
      if (session === undefined || session.principalId !== principal.principalId || csrf !== session.token) {
        return { kind: "forbidden" };
      }
      const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
      return idempotencyKey === undefined ? { kind: "bad_request" } : { kind: "allowed", idempotencyKey };
    },
    unauthorized,
    forbidden,
    badRequest,
    notFound,
    internalError
  };

  app.post("/auth/session", async (request, reply) => {
    const login = resolveTailnetLogin(inputFor(request), options.bindings);
    if ("kind" in login) return unauthorized(reply);
    const issued = options.sessions.startLocalSession(login);
    const csrfToken = randomBytes(32).toString("base64url");
    csrfSessions.set(issued.token, { principalId: login.principalId, token: csrfToken });
    reply.header("set-cookie", issued.cookie);
    reply.header("x-csrf-token", csrfToken);
    return reply.code(204).send();
  });

  registerCommandRoutes(app, context, options.commands, options.onCommands);
  registerProjectRoutes(app, context, options.projects);
  registerApprovalRoutes(app, context, options.approvals);
  registerActionRoutes(app, context, options.actions);

  return app;
}
