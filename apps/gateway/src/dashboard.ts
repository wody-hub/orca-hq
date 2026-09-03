import type { AuthenticatedPrincipal, ExecutionProposal } from "@orca-hq/core";
import { ExecutionProposalSchema } from "@orca-hq/core";
import { ControlStore, type JsonValue } from "@orca-hq/persistence";

import type { CommandDashboardPort, DashboardCommandDetailView, DashboardCommandSummaryView, ProjectDashboardPort, VerificationStatus } from "./http.js";

type RecordValue = Record<string, JsonValue | undefined>;
type DashboardRiskLevel = DashboardCommandSummaryView["riskLevel"];
const DASHBOARD_HISTORY_LIMIT = 20;

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
/**
 * The persisted approval deliberately omits its display phrase.  Rebuild it
 * from the immutable operation digest using the same canonical grammar as the
 * approval service; no user-supplied string is ever reflected here.
 */
function approvalPhrase(operation: string, digest: string): string {
  const normalizedOperation = operation.trim().replace(/[\s-]+/g, "_").toUpperCase();
  return `APPROVE ${normalizedOperation} ${digest.slice(0, 12).toUpperCase()}`;
}
function mayApprove(
  riskLevel: "L2" | "L3" | undefined,
  principal: AuthenticatedPrincipal
): boolean {
  if (riskLevel === "L3") return principal.roles.includes("owner");
  if (riskLevel === "L2") {
    return principal.roles.some((role) => role === "owner" || role === "operator");
  }
  return false;
}
function approvalHistoryItem(
  persisted: ReturnType<ControlStore["listApprovals"]>[number]
): DashboardCommandDetailView["approvalHistory"][number] {
  return {
    id: persisted.request.approvalId,
    level: persisted.request.riskLevel,
    digest: persisted.request.digest,
    ...(persisted.request.riskLevel === "L3"
      ? { operationPhrase: approvalPhrase(persisted.request.operation, persisted.request.digest) }
      : {}),
    status: persisted.state,
    approvedAt: persisted.approval?.approvedAt ?? "",
    expiresAt: persisted.approval?.expiresAt ?? ""
  };
}
function verificationDiffSummary(tasks: ReturnType<ControlStore["listTasks"]>, runId: string): string {
  const verifier = tasks.find((task) => task.runId === runId && task.role === "verify"
    && (task.state === "verified_success" || task.state === "verification_failed" || task.state === "intervention_required"));
  return verifier === undefined ? "pending" : text(record(record(verifier.payload).report).diffSummary, "pending");
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
    async getCommand({ commandId, principal }): Promise<DashboardCommandDetailView | undefined> {
      const command = store.listCommands().find((item) => item.commandId === commandId);
      if (command === undefined) return undefined;
      const base = summary(command);
      const run = latestRun(store, commandId);
      const runValue = record(run);
      const runId = text(runValue.id, "");
      const proposal = proposalFrom(run);
      const durableTasks = store.listTasks();
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
      const commandAudit = store.listAuditEvents().filter((event) => event.subjectId === commandId).at(-1);
      const persistedApprovals = proposal === undefined ? [] : store.listApprovals()
        .filter((item) => item.request.proposal.proposalId === proposal.proposalId);
      const persistedApproval = persistedApprovals.at(-1);
      const approvalHistory = persistedApprovals.slice(-DASHBOARD_HISTORY_LIMIT).reverse()
        .map(approvalHistoryItem);
      const auditSubjects = new Set([commandId, ...persistedApprovals.map((item) => item.request.approvalId)]);
      const auditHistory = store.listAuditEvents()
        .filter((event) => auditSubjects.has(event.subjectId))
        .slice(-DASHBOARD_HISTORY_LIMIT)
        .reverse()
        .map((event) => ({
          reference: event.id,
          subjectId: event.subjectId,
          summary: event.eventType,
          occurredAt: event.createdAt
        }));
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
        diff: { summary: verificationDiffSummary(durableTasks, runId) },
        approval: persistedApproval === undefined
          ? { id: "", level: "unknown", digest: "", expiresAt: "", status: "pending", permitted: false }
          : {
              id: persistedApproval.request.approvalId, level: persistedApproval.request.riskLevel,
              digest: persistedApproval.request.digest, expiresAt: approval?.expiresAt ?? "",
              ...(persistedApproval.request.riskLevel === "L3" ? {
                operationPhrase: approvalPhrase(persistedApproval.request.operation, persistedApproval.request.digest)
              } : {}),
              status: approvalState === "approved" || approvalState === "consumed" ? "approved"
                : approvalState === "expired" ? "expired" : approvalState === "invalidated" ? "denied" : "pending",
              permitted: approvalState === "pending"
                && mayApprove(persistedApproval.request.riskLevel, principal)
            },
        audit: { reference: commandAudit?.id ?? "", summary: commandAudit?.eventType ?? "pending" },
        approvalHistory,
        auditHistory,
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
