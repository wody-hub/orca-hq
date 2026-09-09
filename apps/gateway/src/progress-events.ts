import { redactRelayText } from "./orca-relay.js";
import type { CommandJob } from "./managed-commands.js";
export function publicProgressText(text: string): string {
  return redactRelayText(text)
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gu,
      "[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "")
    .slice(0, 14000);
}
export function nativeContextState(
  jobs: CommandJob[],
  agentRunning = false,
): string {
  if (jobs.some((j) => j.state === "recovery_required"))
    return "recovery_required";
  if (jobs.some((j) => !["succeeded", "failed", "stopped"].includes(j.state)))
    return "worker_running";
  if (agentRunning) return "running";
  if (jobs.some((j) => j.state === "failed")) return "failed";
  if (jobs.length && jobs.every((j) => j.state === "stopped")) return "stopped";
  return "completed";
}
export function nativeProgress(job: CommandJob) {
  return {
    eventKey: JSON.stringify([
      "orca",
      job.id,
      job.state,
      job.nativeStatus ?? "",
      job.updatedAt,
      job.dispatchId ?? "",
      String(job.execution?.generation ?? ""),
    ]),
    kind: "job.state" as const,
    source: "orca" as const,
    occurredAt: job.updatedAt,
    payload: {
      jobId: job.id,
      state: job.state,
      nativeStatus: job.nativeStatus ?? "",
      text: publicProgressText(
        `${job.projectName} · ${job.state}${job.relayWarning ? " · " + job.relayWarning : ""}`,
      ),
      lastObservedAt: job.updatedAt,
    },
  };
}
export function toolProgress(
  name: string,
  phase: "started" | "completed" | "failed",
  callId: string,
) {
  return {
    kind: `tool.${phase}` as const,
    source: "tool" as const,
    payload: { tool: name, callId, text: `${name} · ${phase}` },
  };
}
