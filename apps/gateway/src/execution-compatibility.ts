import type { ResourceAccess } from "@orca-hq/core";
import { normalizeResourceAccesses, resourcesOverlap } from "./execution-reservations.js";
import type { ProgressStore } from "./progress-store.js";
import type { CommandJob } from "./managed-commands.js";
import type { RelayProject } from "./orca-relay.js";
/** Existing channel sessions keep their threads while sharing checkout ownership. */
export function createExecutionCompatibility(options: {
  store: ProgressStore;
  legacyJobs(): CommandJob[];
  pollMs?: number;
}) {
  return {
    hasLegacyConflict(resources: readonly ResourceAccess[]): boolean {
      const requested = normalizeResourceAccesses(resources);
      return options
        .legacyJobs()
        .filter(
          (job) =>
            !job.execution &&
            !["succeeded", "failed", "stopped"].includes(job.state),
        )
        .some((job) => {
          const path = job.worktreePath ?? job.project?.absolutePath;
          if (!path) return true; // Unknown legacy placement is not proof of independence.
          const key = normalizeResourceAccesses([
            { resourceKey: path, mode: "write" },
          ])[0]!.resourceKey;
          return requested.some(
            (resource) =>
              resource.resourceKey.startsWith("external:") ||
              resourcesOverlap(resource.resourceKey, key),
          );
        });
    },
    async authorizeLegacy(
      project: RelayProject,
      worktreeId?: string,
      signal?: AbortSignal,
    ): Promise<void> {
      const separator = worktreeId?.indexOf("::") ?? -1;
      const path =
        worktreeId && separator >= 0
          ? worktreeId.slice(separator + 2)
          : project.absolutePath;
      const key = normalizeResourceAccesses([
        { resourceKey: path, mode: "write" },
      ])[0]!.resourceKey;
      for (;;) {
        if (signal?.aborted) throw new Error("legacy_dispatch_wait_cancelled");
        const conflict = options.store
          .listExecutionReservations()
          .some(
            (r) =>
              r.state !== "released" &&
              (r.resourceKey.startsWith("external:") ||
                resourcesOverlap(r.resourceKey, key)),
          );
        if (!conflict) return;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, options.pollMs ?? 100),
        );
      }
    },
  };
}
