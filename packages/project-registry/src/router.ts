import type { RouteCandidate } from "@orca-hq/core";

import { normalizeAlias } from "./registry.js";
import type { ProjectRegistryEntry } from "./schema.js";

export interface RouteInput {
  text: string;
}

export type RouteDecision =
  | { kind: "selected"; projectKey: string; score: number; evidence: string[] }
  | { kind: "clarification_required"; candidates: RouteCandidate[] };

function rankCandidates(candidates: readonly RouteCandidate[]): RouteCandidate[] {
  return [...candidates].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.projectKey < right.projectKey ? -1 : left.projectKey > right.projectKey ? 1 : 0;
  });
}

export function decideRankedRoute(candidates: readonly RouteCandidate[]): RouteDecision {
  const ranked = rankCandidates(candidates);
  const first = ranked[0];
  const second = ranked[1];

  const margin = first === undefined || second === undefined ? undefined : first.score - second.score;
  if (
    first === undefined
    || first.score < 0.85
    || (margin !== undefined && margin + Number.EPSILON < 0.15)
  ) {
    return { kind: "clarification_required", candidates: ranked.slice(0, 3) };
  }

  return {
    kind: "selected",
    projectKey: first.projectKey,
    score: first.score,
    evidence: first.evidence
  };
}

export function routeProject(
  input: RouteInput,
  entries: readonly ProjectRegistryEntry[]
): RouteDecision {
  const text = normalizeAlias(input.text);
  const candidates = entries.flatMap((entry): RouteCandidate[] => {
    const alias = entry.aliases.find((candidateAlias) => text.includes(normalizeAlias(candidateAlias)));
    return alias === undefined
      ? []
      : [{ projectKey: entry.projectKey, score: 1, evidence: [`alias:${alias}`] }];
  });

  return decideRankedRoute(candidates);
}
