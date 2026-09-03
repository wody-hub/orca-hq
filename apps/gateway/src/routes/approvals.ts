import { z } from "zod";

import type { AuthenticatedPrincipal } from "@orca-hq/core";
import type { FastifyInstance } from "fastify";

import type { GatewayRouteContext } from "../http.js";

const ApprovalParamsSchema = z.object({ id: z.string().trim().min(1) }).strict();
const ApprovalConfirmationSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  phrase: z.string().min(1).optional()
}).strict();

export interface ApprovalConfirmationPort {
  /** Restores the stored approval and current proposal before deciding atomically with its audit event. */
  confirmExisting(input: Readonly<{
    approvalId: string;
    principal: AuthenticatedPrincipal;
    channel: "tailscale-web";
    digest: string;
    phrase?: string;
    idempotencyKey: string;
  }>): Promise<
    | Readonly<{ kind: "approved"; expiresAt: string }>
    | Readonly<{ kind: "changed" }>
    | Readonly<{ kind: "denied" }>
  >;
}

export function registerApprovalRoutes(
  app: FastifyInstance,
  context: GatewayRouteContext,
  approvals: ApprovalConfirmationPort | undefined
): void {
  app.post("/api/approvals/:id/confirm", async (request, reply) => {
    const principal = context.authenticate(request);
    if (principal === undefined) return context.unauthorized(reply);
    if (!context.canMutate(principal)) return context.forbidden(reply);
    const security = context.requireMutationSecurity(request, principal);
    if (security.kind !== "allowed") {
      return security.kind === "bad_request" ? context.badRequest(reply) : context.forbidden(reply);
    }
    const { id } = ApprovalParamsSchema.parse(request.params);
    const body = ApprovalConfirmationSchema.parse(request.body);
    if (approvals === undefined) return context.internalError(reply);
    const decision = await approvals.confirmExisting({
      approvalId: id,
      principal,
      channel: "tailscale-web",
      digest: body.digest,
      ...(body.phrase === undefined ? {} : { phrase: body.phrase }),
      idempotencyKey: security.idempotencyKey
    });
    if (decision.kind === "changed") return reply.code(409).send({ error: "proposal_changed" });
    if (decision.kind !== "approved") return context.forbidden(reply);
    return reply.code(200).send({ status: "approved", expiresAt: decision.expiresAt });
  });
}
