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

interface Decimal {
  coefficient: bigint;
  scale: number;
}

function decimal(value: number): Decimal {
  const text = value.toString();
  const exponentIndex = text.search(/e/i);
  const significand = exponentIndex === -1 ? text : text.slice(0, exponentIndex);
  const exponent = exponentIndex === -1 ? 0 : Number(text.slice(exponentIndex + 1));
  const decimalPoint = significand.indexOf(".");
  const fractionalDigits = decimalPoint === -1 ? 0 : significand.length - decimalPoint - 1;

  return {
    coefficient: BigInt(significand.replace(".", "")),
    scale: fractionalDigits - exponent
  };
}

function scaleDecimal(value: Decimal, scale: number): bigint {
  return value.coefficient * (10n ** BigInt(scale - value.scale));
}

function marginAtLeast(first: number, second: number, threshold: number): boolean {
  const firstValue = decimal(first);
  const secondValue = decimal(second);
  const thresholdValue = decimal(threshold);
  const scale = Math.max(firstValue.scale, secondValue.scale, thresholdValue.scale);

  return scaleDecimal(firstValue, scale) - scaleDecimal(secondValue, scale)
    >= scaleDecimal(thresholdValue, scale);
}

export function decideRankedRoute(candidates: readonly RouteCandidate[]): RouteDecision {
  const ranked = rankCandidates(candidates);
  const first = ranked[0];
  const second = ranked[1];

  if (
    first === undefined
    || first.score < 0.85
    || (second !== undefined && !marginAtLeast(first.score, second.score, 0.15))
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
