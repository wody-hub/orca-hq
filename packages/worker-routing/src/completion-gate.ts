import { z } from "zod";

import type { VerificationReport } from "./verifier.js";

const VerificationCycleSchema = z.number().int().min(0).max(2);

export type CompletionDecision = Readonly<
  | { kind: "verified_success"; evidence: readonly string[] }
  | { kind: "create_fix_task"; findings: readonly string[]; nextCycle: number }
  | { kind: "intervention_required"; findings: readonly string[] }
>;

export function completionDecision(
  reportValue: VerificationReport,
  cycleValue: number
): CompletionDecision {
  const report = reportValue;
  const cycle = VerificationCycleSchema.parse(cycleValue);
  if (report.verdict === "pass") {
    return Object.freeze({
      kind: "verified_success" as const,
      evidence: Object.freeze([...report.evidence])
    });
  }
  if (cycle < 2) {
    return Object.freeze({
      kind: "create_fix_task" as const,
      findings: Object.freeze([...report.findings]),
      nextCycle: cycle + 1
    });
  }
  return Object.freeze({
    kind: "intervention_required" as const,
    findings: Object.freeze([...report.findings])
  });
}
