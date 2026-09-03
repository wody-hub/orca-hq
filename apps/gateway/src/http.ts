import { createHmac, timingSafeEqual } from "node:crypto";

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
export type {
  CommandDashboardPort,
  DashboardCommandDetailView,
  DashboardCommandSummaryView,
  VerificationStatus
} from "./routes/commands.js";
export type { ProjectDashboardPort } from "./routes/projects.js";

export interface GatewayWebAssetsPort {
  /** Returns only a prebuilt public asset; request paths are never mapped directly to the filesystem. */
  asset(path: string): Promise<Readonly<{ contentType: string; body: string | Uint8Array }> | undefined>;
  /** The prebuilt SPA entry document used for client-side dashboard routes. */
  indexHtml(): Promise<string | Uint8Array>;
}

export interface GatewayHttpOptions {
  readonly bindings: readonly PrincipalBinding[];
  readonly resolver: IdentityResolver;
  readonly sessions: LocalSessionService;
  readonly peerAddress?: (request: FastifyRequest) => string;
  /** The one HTTPS dashboard origin allowed to submit state-changing requests. */
  readonly allowedOrigin?: string;
  /** At least 32 bytes of stable signing material for session-bound CSRF tokens. */
  readonly csrfSigningKey?: Uint8Array;
  /** Redacted dashboard queries; never pass persistence rows or channel credentials here. */
  readonly commands?: CommandDashboardPort;
  readonly projects?: ProjectDashboardPort;
  /** Adapter supplied by Task 5, which restores immutable server state before confirmation. */
  readonly approvals?: ApprovalConfirmationPort;
  /** Adapter supplied by Task 5, which owns durable idempotency and redacted audit writes. */
  readonly actions?: DispatchActionPort;
  /** Optional prebuilt dashboard asset source. API and authentication routes never use its SPA fallback. */
  readonly webAssets?: GatewayWebAssetsPort;
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

function isClientError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return false;
  return typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500;
}

function csrfSigningKey(value: Uint8Array | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  const key = Buffer.from(value);
  return key.length >= 32 ? key : undefined;
}

function csrfToken(key: Buffer, sessionToken: string, principalId: string): string {
  return createHmac("sha256", key)
    .update(sessionToken)
    .update("\u0000")
    .update(principalId)
    .digest("base64url");
}

function validCsrfToken(value: string | undefined, expected: string): boolean {
  if (value === undefined || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const received = Buffer.from(value, "base64url");
  if (received.length !== 32 || received.toString("base64url") !== value) return false;
  const expectedBytes = Buffer.from(expected, "base64url");
  return received.length === expectedBytes.length && timingSafeEqual(received, expectedBytes);
}

/**
 * Classifies a URL before SPA fallback. Decode once so encoded separators cannot
 * turn protected API/auth paths into client-side dashboard routes; malformed
 * escapes are treated as protected misses (fail closed).
 */
function isProtectedOrMalformedPath(rawUrl: string): boolean {
  const rawPath = rawUrl.split("?", 1)[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  const path = decoded.toLowerCase();
  return path === "/api" || path.startsWith("/api/") || path === "/auth" || path.startsWith("/auth/");
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
  app.setErrorHandler((error, _request, reply) =>
    error instanceof ZodError || isClientError(error)
      ? badRequest(reply)
      : internalError(reply));
  app.setNotFoundHandler((_request, reply) => notFound(reply));
  const peerAddress = options.peerAddress ?? ((request: FastifyRequest) => request.raw.socket.remoteAddress ?? "");
  const inputFor = (request: FastifyRequest) => ({
    remoteAddress: peerAddress(request),
    headers: request.headers
  });
  const csrfKey = csrfSigningKey(options.csrfSigningKey);

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
      if (csrfKey === undefined || sessionToken === undefined ||
        !validCsrfToken(csrf, csrfToken(csrfKey, sessionToken, principal.principalId))) {
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
    reply.header("set-cookie", issued.cookie);
    if (csrfKey !== undefined) reply.header("x-csrf-token", csrfToken(csrfKey, issued.token, login.principalId));
    return reply.code(204).send();
  });

  registerCommandRoutes(app, context, options.commands, options.onCommands);
  registerProjectRoutes(app, context, options.projects);
  registerApprovalRoutes(app, context, options.approvals);
  registerActionRoutes(app, context, options.actions);

  app.get("/*", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "/";
    if (isProtectedOrMalformedPath(request.url)) {
      return notFound(reply);
    }
    if (options.webAssets === undefined) return notFound(reply);
    const asset = await options.webAssets.asset(path);
    if (asset !== undefined) return reply.type(asset.contentType).send(asset.body);
    // Requests naming a missing file should remain 404; extension-less paths are dashboard routes.
    if (path.split("/").at(-1)?.includes(".") === true) return notFound(reply);
    return reply.type("text/html; charset=utf-8").send(await options.webAssets.indexHtml());
  });

  return app;
}
