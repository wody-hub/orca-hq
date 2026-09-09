import {
  LaunchProfileSchema,
  NativeWorkPlanSchema,
  ResourceAccessSchema,
  type LaunchProfile,
  type NativeWorkItem,
  type ResourceAccess
} from "@orca-hq/core";
import { z } from "zod";

import { normalizeResourceAccesses } from "./execution-reservations.js";

const id = z.string().trim().min(1).max(512);

const TrustedContextSchema = z.object({
  requestId: id,
  contextId: id,
  generation: z.number().int().positive()
}).strict();

const TrustedAttemptSchema = z.object({
  attemptId: id,
  projectId: id,
  resumeTerminalHandle: id.optional()
}).strict();

const TrustedProjectSchema = z.object({
  projectId: id,
  worktreeId: id,
  checkoutResourceKey: z.string().trim().min(1).max(4 * 1024),
  resources: z.array(ResourceAccessSchema).min(1).max(128)
}).strict();

const ProposedItemSchema = z.object({
  attemptId: id,
  objective: z.string().trim().min(1).max(64 * 1024),
  access: z.enum(["read", "write"]),
  resources: z.array(ResourceAccessSchema).min(1).max(128),
  dependsOn: z.array(id).max(128),
  profileKey: id
}).strict();

const PlannerInputSchema = z.object({
  context: TrustedContextSchema,
  attempts: z.array(TrustedAttemptSchema).min(1).max(128),
  projects: z.array(TrustedProjectSchema).min(1).max(64),
  proposedItems: z.array(ProposedItemSchema).min(1).max(128)
}).strict();

export interface TrustedNativeWorkContext {
  requestId: string;
  contextId: string;
  generation: number;
}

export interface TrustedNativeAttempt {
  attemptId: string;
  projectId: string;
  resumeTerminalHandle?: string;
}

export interface TrustedNativeProject {
  projectId: string;
  worktreeId: string;
  checkoutResourceKey: string;
  resources: readonly ResourceAccess[];
}

export interface ProposedNativeWorkItem {
  attemptId: string;
  objective: string;
  access: "read" | "write";
  resources: readonly ResourceAccess[];
  dependsOn: readonly string[];
  profileKey: string;
}

export interface NativeWorkPlannerInput {
  context: TrustedNativeWorkContext;
  attempts: readonly TrustedNativeAttempt[];
  projects: readonly TrustedNativeProject[];
  proposedItems: readonly ProposedNativeWorkItem[];
}

export function createNativeWorkPlanner(options: {
  profiles: Readonly<Record<string, LaunchProfile>>;
}) {
  const profiles = new Map<string, LaunchProfile>();
  for (const [key, candidate] of Object.entries(options.profiles)) {
    const profileKey = id.parse(key);
    profiles.set(profileKey, LaunchProfileSchema.parse(candidate));
  }
  if (profiles.size === 0) throw new Error("profile_allowlist_empty");

  return {
    plan(input: NativeWorkPlannerInput): NativeWorkItem[] {
      const parsed = PlannerInputSchema.parse(input);
      const attempts = uniqueBy(
        parsed.attempts,
        (attempt) => attempt.attemptId,
        "duplicate_trusted_attempt"
      );
      const projects = uniqueBy(
        parsed.projects,
        (project) => project.projectId,
        "duplicate_trusted_project"
      );

      const items = parsed.proposedItems.map((proposal): NativeWorkItem => {
        const attempt = attempts.get(proposal.attemptId);
        if (!attempt) throw new Error("attempt_not_allowed");
        const project = projects.get(attempt.projectId);
        if (!project) throw new Error("project_not_allowed");
        const profile = profiles.get(proposal.profileKey);
        if (!profile) throw new Error("profile_not_allowed");

        const normalizedAllowed = normalizeResourceAccesses(project.resources);
        const [normalizedPrimaryCheckout] = normalizeResourceAccesses([{
          resourceKey: project.checkoutResourceKey,
          mode: "read"
        }]);
        if (!normalizedPrimaryCheckout?.resourceKey.startsWith("checkout:")) {
          throw new Error("project_checkout_invalid");
        }
        const allowedResources = new Map(
          normalizedAllowed.map((resource) => [resource.resourceKey, resource])
        );
        const checkout = allowedResources.get(normalizedPrimaryCheckout.resourceKey);
        if (!checkout) throw new Error("project_checkout_not_allowed");
        const resources = normalizeResourceAccesses([
          ...proposal.resources,
          { resourceKey: checkout.resourceKey, mode: proposal.access }
        ]);
        for (const requested of resources) {
          const allowed = allowedResources.get(requested.resourceKey);
          if (!allowed) throw new Error("resource_not_allowed");
          if (requested.mode === "write" && allowed.mode !== "write") {
            throw new Error("resource_mode_not_allowed");
          }
        }
        const effectiveAccess = resources.some(
          (resource) => resource.mode === "write"
        ) ? "write" : "read";
        if (proposal.access !== effectiveAccess) {
          throw new Error("resource_access_mismatch");
        }

        return {
          attemptId: attempt.attemptId,
          requestId: parsed.context.requestId,
          contextId: parsed.context.contextId,
          generation: parsed.context.generation,
          projectId: project.projectId,
          worktreeId: project.worktreeId,
          objective: proposal.objective,
          access: proposal.access,
          resources: [...resources],
          dependsOn: proposal.dependsOn,
          profile,
          ...(attempt.resumeTerminalHandle
            ? { resumeTerminalHandle: attempt.resumeTerminalHandle }
            : {})
        };
      });

      return NativeWorkPlanSchema.parse(items);
    }
  };
}

function uniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  error: string
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) throw new Error(error);
    result.set(key, value);
  }
  return result;
}
