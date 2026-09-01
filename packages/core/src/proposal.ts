import { z } from "zod";

export const RiskLevelSchema = z.enum(["L0", "L1", "L2", "L3"]);

export const RouteCandidateSchema = z.object({
  projectKey: z.string().min(1),
  score: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1))
}).strict();

export const TaskRoleSchema = z.enum(["investigate", "implement", "verify", "summarize"]);
export const PreferredAgentSchema = z.enum(["codex", "claude"]);

export const ExecutionTaskSchema = z.object({
  localId: z.string().min(1),
  title: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),
  role: TaskRoleSchema,
  preferredAgent: PreferredAgentSchema
}).strict();

export const ExecutionProposalSchema = z.object({
  proposalId: z.string().min(1),
  commandId: z.string().min(1),
  selectedProjectKey: z.string().min(1),
  routeCandidates: z.array(RouteCandidateSchema),
  baseRef: z.string().min(1).optional(),
  allowedScope: z.array(z.string().min(1)),
  prohibitedEffects: z.array(z.string().min(1)),
  acceptanceCommands: z.array(z.string().min(1)),
  riskLevel: RiskLevelSchema,
  tasks: z.array(ExecutionTaskSchema)
}).strict();

export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type RouteCandidate = z.infer<typeof RouteCandidateSchema>;
export type TaskRole = z.infer<typeof TaskRoleSchema>;
export type PreferredAgent = z.infer<typeof PreferredAgentSchema>;
export type ExecutionTask = z.infer<typeof ExecutionTaskSchema>;
export type ExecutionProposal = z.infer<typeof ExecutionProposalSchema>;
