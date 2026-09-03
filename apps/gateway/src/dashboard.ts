import type { AuthenticatedPrincipal, ExecutionProposal } from "@orca-hq/core";
import { ExecutionProposalSchema } from "@orca-hq/core";
import { ControlStore, type JsonValue } from "@orca-hq/persistence";

import type { CommandDashboardPort, DashboardCommandDetailView, DashboardCommandSummaryView, ProjectDashboardPort, VerificationStatus } from "./http.js";

type RecordValue = Record<string, JsonValue | undefined>;
type DashboardRiskLevel = DashboardCommandSummaryView["riskLevel"];

function record(value: JsonValue | undefined): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}
function text(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function strings(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function proposalFrom(run: JsonValue | undefined): ExecutionProposal | undefined {
  const recovery = record(record(run).recoveryContext);
  const parsed = ExecutionProposalSchema.safeParse(recovery.proposal);
  return parsed.success ? parsed.data : undefined;
}
function risk(proposal: ExecutionProposal | undefined): DashboardRiskLevel {
  return proposal?.riskLevel ?? "unknown";
}
function taskControls(state: string): Readonly<{ canStop: boolean; canRetry: boolean }> {
  switch (state) {
    case "launching": case "running": return { canStop: true, canRetry: false };
    case "launch_failed": case "intervention_required": return { canStop: false, canRetry: true };
    default: return { canStop: false, canRetry: false };
  }
}
function verification(state: string): VerificationStatus {
  if (state === "verified_success") return "passed";
  if (state === "verification_failed" || state === "intervention_required" || state.endsWith("_failed")) return "failed";
  return "pending";
}
function latestRun(store: ControlStore, commandId: string): JsonValue | undefined {
  return store.listRunRecords().filter((item) => record(item).commandId === commandId).at(-1);
}

/** Store-backed, redacted dashboard projection; unknown evidence never becomes a low-risk default. */
export function createCommandDashboard(store: ControlStore): CommandDashboardPort {
  const summary = (command: ReturnType<ControlStore["listCommands"]>[number]): DashboardCommandSummaryView => {
    const run = latestRun(store, command.commandId);
    const runValue = record(run);
    const proposal = proposalFrom(run);
    return {
      id: command.commandId, summary: command.text, status: text(runValue.state, "pending"),
      projectKey: proposal?.selectedProjectKey ?? "unknown", riskLevel: risk(proposal), updatedAt: command.receivedAt
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
      const run = latestRun(store, commandId);
      const runValue = record(run);
      const runId = text(runValue.id, "");
      const proposal = proposalFrom(run);
      const verifier = store.listTasks().find((item) => item.runId === runId && text(record(item.payload).role, "") === "verify");
      const verifierFamily = verifier === undefined ? "unknown" : text(record(verifier.payload).preferredAgent, "unknown");
      const tasks = store.listTasks().filter((item) => item.runId === runId).map((item) => {
        const payload = record(item.payload);
        const dispatch = store.loadDispatchesForTask(item.id).at(-1);
        const dispatchValue = record(dispatch);
        const dispatchState = text(dispatchValue.state, "planned");
        const role = text(payload.role, "unknown");
        return {
          id: item.id, title: item.title, status: item.state, dependencies: strings(payload.dependsOn),
          workerFamily: text(payload.preferredAgent, "unknown"), verifierFamily: role === "verify" ? text(payload.preferredAgent, "unknown") : verifierFamily,
          dispatchId: text(dispatchValue.id, ""), dispatchStatus: dispatchState, ...taskControls(dispatchState)
        };
      });
      const audit = store.listAuditEvents().filter((event) => event.subjectId === commandId).at(-1);
      const persistedApproval = proposal === undefined ? undefined : store.listApprovals()
        .filter((item) => item.request.proposal.proposalId === proposal.proposalId).at(-1);
      const approvalState = persistedApproval?.state;
      const approval = persistedApproval?.approval;
      return {
        ...base, createdAt: command.receivedAt,
        project: { key: base.projectKey, displayName: base.projectKey, path: "[redacted]" },
        routing: proposal === undefined
          ? { score: 0, selectedReason: "unknown", candidates: [] }
          : {
              score: proposal.routeCandidates.find((candidate) => candidate.projectKey === proposal.selectedProjectKey)?.score ?? 0,
              selectedReason: proposal.routeCandidates.find((candidate) => candidate.projectKey === proposal.selectedProjectKey)?.evidence.at(0) ?? "durable_route",
              candidates: proposal.routeCandidates.map((candidate) => candidate.projectKey)
            },
        contract: proposal === undefined
          ? { base: "unknown", allowedScope: [], prohibitedEffects: [], testCommands: [] }
          : { base: proposal.baseRef ?? "unknown", allowedScope: proposal.allowedScope, prohibitedEffects: proposal.prohibitedEffects, testCommands: proposal.acceptanceCommands },
        tasks,
        verification: { status: verification(base.status), commands: proposal?.acceptanceCommands ?? [] },
        diff: { summary: text(runValue.diffSummary, "pending") },
        approval: persistedApproval === undefined
          ? { id: "", level: "unknown", digest: "", expiresAt: "", status: "pending", permitted: false }
          : {
              id: persistedApproval.request.approvalId, level: persistedApproval.request.riskLevel,
              digest: persistedApproval.request.digest, expiresAt: approval?.expiresAt ?? "",
              status: approvalState === "approved" || approvalState === "consumed" ? "approved"
                : approvalState === "expired" ? "expired" : approvalState === "invalidated" ? "denied" : "pending",
              permitted: approvalState === "approved"
            },
        audit: { reference: audit?.id ?? "", summary: audit?.eventType ?? "pending" },
        delivery: store.listOutbox().filter((message) => message.commandId === commandId).map((message) => ({
          channel: message.channel, status: message.state === "delivered" ? "sent" : message.state === "failed" ? "failed" : "pending"
        }))
      };
    }
  };
}

/** Projects shown by production HTTP are derived from durable proposal/run evidence. */
export function createProjectDashboard(store: ControlStore): ProjectDashboardPort {
  return {
    async listProjects(_principal: AuthenticatedPrincipal) {
      const projects = new Map<string, string>();
      for (const run of store.listRunRecords()) {
        const proposal = proposalFrom(run);
        if (proposal !== undefined) projects.set(proposal.selectedProjectKey, text(record(run).state, "pending"));
      }
      return { projects: [...projects].map(([projectKey, status]) => ({ projectKey, status })) };
    }
  };
}
