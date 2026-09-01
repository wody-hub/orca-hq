import { isAbsolute } from "node:path";

import { RiskLevelSchema } from "@orca-hq/core";
import { z } from "zod";

const NonBlankStringSchema = z.string().trim().min(1);
const AbsolutePathSchema = NonBlankStringSchema.refine(isAbsolute, {
  message: "must be an absolute path"
});

export const ProjectRegistryEntrySchema = z.object({
  projectKey: NonBlankStringSchema,
  orcaProjectId: NonBlankStringSchema,
  repoId: NonBlankStringSchema.optional(),
  absolutePath: AbsolutePathSchema,
  canonicalRemote: NonBlankStringSchema.optional(),
  aliases: z.array(NonBlankStringSchema).min(1),
  customer: NonBlankStringSchema.optional(),
  product: NonBlankStringSchema.optional(),
  component: z.enum(["frontend", "backend", "batch", "mobile", "docs", "mixed"]),
  defaultBaseRef: NonBlankStringSchema.optional(),
  instructionsFiles: z.array(NonBlankStringSchema),
  setupPolicy: z.enum(["run", "skip", "inherit"]),
  allowedOperations: z.array(RiskLevelSchema).min(1),
  requiredChecks: z.array(NonBlankStringSchema).min(1),
  sensitivePaths: z.array(NonBlankStringSchema),
  lockKey: NonBlankStringSchema
}).strict();

export const ProjectRegistryDocumentSchema = z.object({
  projects: z.array(ProjectRegistryEntrySchema).min(1)
}).strict();

export const DiscoveredProjectSchema = z.object({
  orcaProjectId: NonBlankStringSchema,
  absolutePath: AbsolutePathSchema,
  approved: z.boolean()
}).passthrough();

export type ProjectRegistryEntry = z.infer<typeof ProjectRegistryEntrySchema>;
export type DiscoveredProject = z.infer<typeof DiscoveredProjectSchema>;
