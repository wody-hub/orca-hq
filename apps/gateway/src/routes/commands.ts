import { z } from "zod";

import type { AuthenticatedPrincipal } from "@orca-hq/core";
import type { FastifyInstance } from "fastify";

import type { GatewayRouteContext } from "../http.js";

const CommandIdParamsSchema = z.object({ id: z.string().trim().min(1) }).strict();

/** A serializable, secret-free command summary for the private dashboard. */
export interface DashboardCommandView {
  readonly commandId: string;
  readonly status: string;
  readonly projectKey?: string;
  readonly riskLevel?: "L0" | "L1" | "L2" | "L3";
  readonly updatedAt?: string;
}

export interface CommandDashboardPort {
  listCommands(principal: AuthenticatedPrincipal): Promise<Readonly<{ commands: readonly DashboardCommandView[] }>>;
  getCommand(input: Readonly<{
    commandId: string;
    principal: AuthenticatedPrincipal;
  }>): Promise<DashboardCommandView | undefined>;
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
