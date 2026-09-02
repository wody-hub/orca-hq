import { ExecutionProposalSchema } from "@orca-hq/core";
import { z } from "zod";

import { ClarificationSchema } from "./protocol.js";

export const SearchProjectsInputSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(20).optional()
}).strict();

export const InspectProjectInputSchema = z.object({
  projectKey: z.string().trim().min(1)
}).strict();

export const PreviewPolicyInputSchema = z.object({
  proposal: ExecutionProposalSchema
}).strict();

export type SearchProjectsInput = z.infer<typeof SearchProjectsInputSchema>;
export type InspectProjectInput = z.infer<typeof InspectProjectInputSchema>;
export type PreviewPolicyInput = z.infer<typeof PreviewPolicyInputSchema>;

/** The complete and immutable authority surface visible to the Codex HQ turn. */
export const hqTools = Object.freeze({
  searchProjects: SearchProjectsInputSchema,
  inspectProject: InspectProjectInputSchema,
  previewPolicy: PreviewPolicyInputSchema,
  submitProposal: ExecutionProposalSchema,
  askClarification: ClarificationSchema
} as const);
