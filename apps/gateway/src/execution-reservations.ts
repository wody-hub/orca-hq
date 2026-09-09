import { ResourceAccessSchema, type ResourceAccess } from "@orca-hq/core";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

import type {
  ExecutionReservation,
  ExecutionReservationResult,
  ProgressStore,
  ReserveContextExecution
} from "./progress-store.js";

/** Runtime-facing reservation boundary. It never schedules work. */
export interface ExecutionReservations {
  claim(input: Omit<ReserveContextExecution, "resources"> & {
    resources: readonly ResourceAccess[];
  }): ExecutionReservationResult;
  linkNativeDispatch(input: {
    reservationId: string;
    contextId: string;
    requestId: string;
    generation: number;
    nativeDispatchId: string;
  }): ExecutionReservation;
  heartbeat(input: {
    reservationId: string;
    contextId: string;
    generation: number;
  }): ExecutionReservation;
  retainForRecovery(input: {
    reservationId: string;
    contextId: string;
    requestId: string;
    generation: number;
  }): ExecutionReservation[];
  release(input: {
    reservationId: string;
    contextId: string;
    requestId: string;
    generation: number;
    nativeCompletion?: {
      dispatchId: string;
      state: "succeeded" | "failed" | "stopped";
    };
  }): ExecutionReservation[];
}

export function createExecutionReservations(store: ProgressStore): ExecutionReservations {
  return {
    claim(input) {
      return store.tryReserveExecution({
        ...input,
        resources: normalizeResourceAccesses(input.resources)
      });
    },
    linkNativeDispatch(input) {
      return store.linkReservationDispatch(input);
    },
    heartbeat(input) {
      return store.heartbeatExecutionReservation(input);
    },
    retainForRecovery(input) {
      return store.markReservationRecoveryRequired(input);
    },
    release(input) {
      return store.releaseExecutionReservation(input);
    }
  };
}

export function normalizeResourceAccesses(
  resources: readonly ResourceAccess[]
): readonly ResourceAccess[] {
  const normalized = new Map<string, ResourceAccess["mode"]>();
  for (const candidate of resources) {
    const resource = ResourceAccessSchema.parse(candidate);
    const rawKey = resource.resourceKey.trim();
    if (!rawKey) throw new TypeError("resourceKey is required");
    let key: string;
    if (rawKey.startsWith("checkout:")) {
      key = normalizeCheckoutKey(rawKey.slice("checkout:".length));
    } else if (isAbsolute(rawKey)) {
      key = normalizeCheckoutKey(rawKey);
    } else {
      key = rawKey;
    }
    const prior = normalized.get(key);
    normalized.set(key, prior === "write" || resource.mode === "write" ? "write" : "read");
  }
  return [...normalized]
    .map(([resourceKey, mode]) => ({ resourceKey, mode }))
    .sort((left, right) => left.resourceKey.localeCompare(right.resourceKey));
}

function normalizeCheckoutKey(path: string): string {
  if (!isAbsolute(path)) throw new TypeError("checkout resource paths must be absolute");
  const resolved = normalize(resolve(path));
  let ancestor = resolved;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  const canonicalAncestor = existsSync(ancestor) ? realpathSync.native(ancestor) : ancestor;
  const canonical = missing.length === 0 ? canonicalAncestor : join(canonicalAncestor, ...missing);
  const withoutTrailingSeparator = canonical.length > 1 && canonical.endsWith(sep)
    ? canonical.slice(0, -1)
    : canonical;
  return `checkout:${withoutTrailingSeparator}`;
}

/** Checkout ancestors overlap; named external resources are exact identities. */
export function resourcesOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  if (!left.startsWith("checkout:") || !right.startsWith("checkout:")) return false;
  const leftPath = left.slice("checkout:".length);
  const rightPath = right.slice("checkout:".length);
  return leftPath.startsWith(rightPath.endsWith("/") ? rightPath : `${rightPath}/`)
    || rightPath.startsWith(leftPath.endsWith("/") ? leftPath : `${leftPath}/`);
}
