import type { AuthenticatedPrincipal } from "@orca-hq/core";
import { ControlStore, type JsonValue } from "@orca-hq/persistence";

import type { CommandDashboardPort, DashboardCommandDetailView, DashboardCommandSummaryView, VerificationStatus } from "./http.js";

type RecordValue = Record<string, JsonValue | undefined>;

function record(value: JsonValue | undefined): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}
function text(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function risk(value: JsonValue | undefined): "L0" | "L1" | "L2" | "L3" {
  return value === "L0" || value === "L1" || value === "L2" || value === "L3" ? value : "L0";
}
function taskControls(state: string): Readonly<{ canStop: boolean; canRetry: boolean }> {
  switch (state) {
    case "launching": case "running": return { canStop: true, canRetry: false };
    case "launch_failed": case "intervention_required": return { canStop: false, canRetry: true };
    default: return { canStop: false, canRetry: false };
  }
}
function verification(state: string): VerificationStatus {
  return state === "verified_success" ? "passed" : state === "intervention_required" ? "failed" : "pending";
}

/** Store-backed, redacted dashboard projection; no test fixture supplies view values. */
export function createCommandDashboard(store: ControlStore): CommandDashboardPort {
  const summary = (command: ReturnType<ControlStore["listCommands"]>[number]): DashboardCommandSummaryView => {
    const run = store.listRunRecords().filter((item) => record(item).commandId === command.commandId).at(-1);
    const runValue = record(run);
    return {
      id: command.commandId, summary: command.text, status: text(runValue.state, "pending"),
      projectKey: text(runValue.selectedProjectKey, "unrouted"), riskLevel: risk(runValue.riskLevel), updatedAt: command.receivedAt
    };
  };
  return {
    async listCommands(_principal: AuthenticatedPrincipal) {
      return { commands: store.listCommands().map(summary) };
    },
    async getCommand({ commandId, principal: _principal }): Promise<DashboardCommandDetailView | undefined> {
      const command = store.listCommands().find((item) => item.commandId === commandId);
      if (command === undefined) return undefined;
      const base = summary(command);
      const run = store.listRunRecords().filter((item) => record(item).commandId === commandId).at(-1);
      const runValue = record(run);
      const runId = text(runValue.id, "");
      const tasks = store.listTasks().filter((item) => item.runId === runId).map((item) => {
        const dispatch = store.loadDispatchesForTask(item.id).at(-1);
        const dispatchValue = record(dispatch);
        const dispatchState = text(dispatchValue.state, "planned");
        return {
          id: item.id, title: item.title, status: item.state, dependencies: [], workerFamily: text(record(item.payload).preferredAgent, "unknown"),
          verifierFamily: "unknown", dispatchId: text(dispatchValue.id, ""), dispatchStatus: dispatchState, ...taskControls(dispatchState)
        };
      });
      const audit = store.listAuditEvents().filter((event) => event.subjectId === commandId).at(-1);
      return {
        ...base, createdAt: command.receivedAt,
        project: { key: base.projectKey, displayName: base.projectKey, path: "[redacted]" },
        routing: { score: base.projectKey === "unrouted" ? 0 : 1, selectedReason: base.projectKey === "unrouted" ? "pending" : "durable_route", candidates: base.projectKey === "unrouted" ? [] : [base.projectKey] },
        contract: { base: "pending", allowedScope: [], prohibitedEffects: [], testCommands: [] }, tasks,
        verification: { status: verification(base.status), commands: [] }, diff: { summary: "pending" },
        approval: { id: "pending", level: "L2", digest: "", expiresAt: "", status: "pending", permitted: false },
        audit: { reference: audit?.id ?? "pending", summary: audit?.eventType ?? "pending" },
        delivery: store.listOutbox().filter((message) => message.commandId === commandId).map((message) => ({ channel: message.channel, status: message.state === "delivered" ? "sent" : message.state === "failed" ? "failed" : "pending" }))
      };
    }
  };
}
