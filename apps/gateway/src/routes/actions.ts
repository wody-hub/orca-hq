import { z } from "zod";

import type { AuthenticatedPrincipal } from "@orca-hq/core";
import type { FastifyInstance } from "fastify";

import type { GatewayRouteContext } from "../http.js";

const DispatchActionSchema = z.object({ dispatchId: z.string().trim().min(1) }).strict();

export interface DispatchActionPort {
  /** The port resolves stored dispatch state and atomically applies the action, idempotency record, and redacted audit. */
  stop(input: Readonly<{
    dispatchId: string;
    principal: AuthenticatedPrincipal;
    idempotencyKey: string;
  }>): Promise<Readonly<{ kind: "stopped" | "denied" }>>;
  retry(input: Readonly<{
    dispatchId: string;
    principal: AuthenticatedPrincipal;
    idempotencyKey: string;
  }>): Promise<Readonly<{ kind: "retried" | "denied" }>>;
}

export function registerActionRoutes(
  app: FastifyInstance,
  context: GatewayRouteContext,
  actions: DispatchActionPort | undefined
): void {
  for (const [path, method, status] of [
    ["/api/actions/stop", "stop", "stopped"],
    ["/api/actions/retry", "retry", "retried"]
  ] as const) {
    app.post(path, async (request, reply) => {
      const principal = context.authenticate(request);
      if (principal === undefined) return context.unauthorized(reply);
      if (!context.canMutate(principal)) return context.forbidden(reply);
      const security = context.requireMutationSecurity(request, principal);
      if (security.kind !== "allowed") {
        return security.kind === "bad_request" ? context.badRequest(reply) : context.forbidden(reply);
      }
      const body = DispatchActionSchema.parse(request.body);
      if (actions === undefined) return context.internalError(reply);
      const decision = await actions[method]({
        dispatchId: body.dispatchId,
        principal,
        idempotencyKey: security.idempotencyKey
      });
      if (decision.kind === "denied") return context.forbidden(reply);
      return reply.code(200).send({ status });
    });
  }
}
