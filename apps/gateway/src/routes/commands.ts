import { z } from "zod";

import type { AuthenticatedPrincipal } from "@orca-hq/core";
import type { FastifyInstance } from "fastify";

import type { GatewayRouteContext } from "../http.js";

const CommandIdParamsSchema = z.object({ id: z.string().trim().min(1) }).strict();

export type VerificationStatus = "passed" | "pending" | "failed";

/** A serializable, secret-free command summary with the dashboard's stable wire ID. */
export interface DashboardCommandSummaryView {
  readonly id: string;
  readonly summary: string;
  readonly status: string;
  readonly projectKey: string;
  readonly riskLevel: "L0" | "L1" | "L2" | "L3" | "unknown";
  readonly updatedAt: string;
}

/** Full redacted evidence view; its values are calculated by the durable query adapter. */
export interface DashboardCommandDetailView extends DashboardCommandSummaryView {
  readonly createdAt: string;
  readonly project: Readonly<{ key: string; displayName: string; path: string }>;
  readonly routing: Readonly<{ score: number; selectedReason: string; candidates: readonly string[] }>;
  readonly contract: Readonly<{
    base: string; allowedScope: readonly string[]; prohibitedEffects: readonly string[]; testCommands: readonly string[];
  }>;
  readonly tasks: readonly Readonly<{
    id: string; title: string; status: string; dependencies: readonly string[];
    workerFamily: string; verifierFamily: string; dispatchId: string; dispatchStatus: string;
    canStop: boolean; canRetry: boolean;
  }>[];
  readonly verification: Readonly<{ status: VerificationStatus; commands: readonly string[] }>;
  readonly diff: Readonly<{ summary: string }>;
  readonly approval: Readonly<{
    id: string; level: "L2" | "L3" | "unknown"; digest: string; expiresAt: string; operationPhrase?: string;
    status: "pending" | "approved" | "expired" | "denied"; permitted: boolean;
  }>;
  readonly audit: Readonly<{ reference: string; summary: string }>;
  readonly approvalHistory: readonly Readonly<{
    id: string; level: "L2" | "L3"; digest: string; operationPhrase?: string;
    status: "pending" | "approved" | "consumed" | "expired" | "invalidated";
    approvedAt: string; expiresAt: string;
  }>[];
  readonly auditHistory: readonly Readonly<{
    reference: string; subjectId: string; summary: string; occurredAt: string;
  }>[];
  readonly delivery: readonly Readonly<{ channel: string; status: "pending" | "sent" | "failed" }>[];
}

export interface CommandDashboardPort {
  listCommands(principal: AuthenticatedPrincipal): Promise<Readonly<{ commands: readonly DashboardCommandSummaryView[] }>>;
  getCommand(input: Readonly<{
    commandId: string;
    principal: AuthenticatedPrincipal;
  }>): Promise<DashboardCommandDetailView | undefined>;
}

export function registerCommandRoutes(
  app: FastifyInstance,
  context: GatewayRouteContext,
  commands: CommandDashboardPort | undefined,
  legacyOnCommands: ((principal: AuthenticatedPrincipal) => unknown | Promise<unknown>) | undefined
): void {
  app.get("/api/commands", async (request, reply) => {
    const principal = context.authenticate(request);
    if (principal === undefined) return context.unauthorized(reply);
    if (!context.canView(principal)) return context.forbidden(reply);
    if (commands !== undefined) return commands.listCommands(principal);
    return legacyOnCommands?.(principal) ?? { commands: [] };
  });

  app.get("/api/commands/:id", async (request, reply) => {
    const principal = context.authenticate(request);
    if (principal === undefined) return context.unauthorized(reply);
    if (!context.canView(principal)) return context.forbidden(reply);
    const { id } = CommandIdParamsSchema.parse(request.params);
    if (commands === undefined) return context.notFound(reply);
    const command = await commands.getCommand({ commandId: id, principal });
    return command === undefined ? context.notFound(reply) : command;
  });
}
