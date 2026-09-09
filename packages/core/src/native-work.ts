import { z } from "zod";

import { ResourceAccessSchema } from "./progress.js";

const NativeIdSchema = z.string().trim().min(1).max(512);
const NativeTextSchema = z.string().trim().min(1).max(64 * 1024);

export const LaunchProfileSchema = z.object({
  agent: z.enum(["codex", "claude"]),
  model: z.string().trim().min(1).max(256),
  effort: z.string().trim().min(1).max(64).optional(),
  reason: z.string().trim().min(1).max(2 * 1024)
}).strict();

export const NativeWorkItemSchema = z.object({
  attemptId: NativeIdSchema,
  requestId: NativeIdSchema,
  contextId: NativeIdSchema,
  generation: z.number().int().positive(),
  projectId: NativeIdSchema,
  worktreeId: NativeIdSchema,
  objective: NativeTextSchema,
  access: z.enum(["read", "write"]),
  resources: z.array(ResourceAccessSchema).min(1).max(128),
  dependsOn: z.array(NativeIdSchema).max(128),
  profile: LaunchProfileSchema,
  resumeTerminalHandle: NativeIdSchema.optional()
}).strict();

export const NativeWorkPlanSchema = z.array(NativeWorkItemSchema)
  .min(1)
  .max(128)
  .superRefine((items, ctx) => {
    const byAttempt = new Map<string, (typeof items)[number]>();
    for (const [index, item] of items.entries()) {
      if (byAttempt.has(item.attemptId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "duplicate_attempt_identity",
          path: [index, "attemptId"]
        });
      } else {
        byAttempt.set(item.attemptId, item);
      }
      const dependencies = new Set<string>();
      for (const [dependencyIndex, dependency] of item.dependsOn.entries()) {
        if (dependencies.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "duplicate_dependency",
            path: [index, "dependsOn", dependencyIndex]
          });
        }
        dependencies.add(dependency);
        if (dependency === item.attemptId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "self_dependency",
            path: [index, "dependsOn", dependencyIndex]
          });
        }
      }
    }

    for (const [index, item] of items.entries()) {
      for (const [dependencyIndex, dependency] of item.dependsOn.entries()) {
        if (!byAttempt.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "unknown_dependency",
            path: [index, "dependsOn", dependencyIndex]
          });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (attemptId: string): boolean => {
      if (visiting.has(attemptId)) return true;
      if (visited.has(attemptId)) return false;
      visiting.add(attemptId);
      const current = byAttempt.get(attemptId);
      for (const dependency of current?.dependsOn ?? []) {
        if (byAttempt.has(dependency) && visit(dependency)) return true;
      }
      visiting.delete(attemptId);
      visited.add(attemptId);
      return false;
    };
    for (const item of items) {
      if (visit(item.attemptId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cyclic_dependency",
          path: []
        });
        break;
      }
    }
  });

export const NativeWorkerReceiptSchema = z.object({
  attemptId: NativeIdSchema,
  runId: NativeIdSchema,
  taskId: NativeIdSchema,
  dispatchId: NativeIdSchema,
  terminalHandle: NativeIdSchema,
  worktreeId: NativeIdSchema,
  requested: LaunchProfileSchema,
  effective: z.object({
    agent: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(256).optional(),
    effort: z.string().trim().min(1).max(64).optional()
  }).strict()
}).strict();

export type LaunchProfile = z.infer<typeof LaunchProfileSchema>;
export type NativeWorkItem = z.infer<typeof NativeWorkItemSchema>;
export type NativeWorkPlan = z.infer<typeof NativeWorkPlanSchema>;
export type NativeWorkerReceipt = z.infer<typeof NativeWorkerReceiptSchema>;
