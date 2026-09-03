import type { AuthenticatedPrincipal } from "@orca-hq/core";
import type { FastifyInstance } from "fastify";

import type { GatewayRouteContext } from "../http.js";

/** A serializable, secret-free project summary for the private dashboard. */
export interface DashboardProjectView {
  readonly projectKey: string;
  readonly status: string;
  readonly displayName?: string;
  readonly updatedAt?: string;
}

export interface ProjectDashboardPort {
  listProjects(principal: AuthenticatedPrincipal): Promise<Readonly<{ projects: readonly DashboardProjectView[] }>>;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  context: GatewayRouteContext,
  projects: ProjectDashboardPort | undefined
): void {
  app.get("/api/projects", async (request, reply) => {
    const principal = context.authenticate(request);
    if (principal === undefined) return context.unauthorized(reply);
    if (!context.canView(principal)) return context.forbidden(reply);
    return projects?.listProjects(principal) ?? { projects: [] };
  });
}
