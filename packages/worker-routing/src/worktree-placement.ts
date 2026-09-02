import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { RiskLevel } from "@orca-hq/core";

const execFileAsync = promisify(execFile);

export interface GitRepositoryStatus {
  readonly dirty: boolean;
  readonly head: string;
  readonly branch: string | null;
}

export interface GitWorktreeOccupancy {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string;
}

export interface CreateGitWorktreeInput {
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
}

interface MutableWorktreeOccupancy {
  path?: string;
  branch?: string | null;
  head?: string;
}

export interface GitWorktreePort {
  repositoryStatus(repositoryPath: string): Promise<GitRepositoryStatus>;
  resolveRevision(repositoryPath: string, ref: string): Promise<string>;
  branchOccupancy(repositoryPath: string): Promise<readonly GitWorktreeOccupancy[]>;
  pathExists(path: string): Promise<boolean>;
  createWorktree(input: CreateGitWorktreeInput): Promise<void>;
}

export interface CurrentWorktreeApproval {
  readonly approvalId: string;
  readonly worktreePath: string;
  readonly head: string;
}

export interface WorktreePlacementRequest {
  readonly proposalId: string;
  readonly riskLevel: RiskLevel;
  readonly repositoryPath: string;
  readonly baseRef?: string | undefined;
  readonly pinnedBaseCommit?: string | undefined;
  readonly currentWorktreeApproval?: CurrentWorktreeApproval | undefined;
  readonly attempt: number;
}

export type WorkerPermissions = "read-only" | "read-write";

export type WorktreeDescriptor =
  | Readonly<{
      kind: "existing-read-only";
      path: string;
      branch: string | null;
      head: string;
    }>
  | Readonly<{
      kind: "approved-current";
      path: string;
      branch: string | null;
      head: string;
      approvalId: string;
    }>
  | Readonly<{
      kind: "isolated";
      path: string;
      branch: string;
      head: string;
    }>;

export interface ReadyWorktreePlacement {
  readonly kind: "ready";
  readonly repositoryPath: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly worktree: WorktreeDescriptor;
  readonly permissions: WorkerPermissions;
  readonly requiresEditingLease: boolean;
}

export type WorktreePlacementReview =
  | Readonly<{
      kind: "review_required";
      reason: "base_ref_required";
    }>
  | Readonly<{
      kind: "review_required";
      reason: "dirty_current_worktree_requires_approval";
      path: string;
    }>
  | Readonly<{
      kind: "review_required";
      reason: "current_worktree_approval_mismatch";
      path: string;
    }>
  | Readonly<{
      kind: "review_required";
      reason: "current_worktree_base_mismatch";
      path: string;
      head: string;
      baseCommit: string;
    }>
  | Readonly<{
      kind: "review_required";
      reason: "base_branch_occupied_elsewhere" | "target_branch_occupied";
      path: string;
      branch: string;
    }>
  | Readonly<{
      kind: "review_required";
      reason: "target_path_occupied";
      path: string;
    }>;

export type WorktreePlacement = ReadyWorktreePlacement | WorktreePlacementReview;

export interface WorktreePlacementPort {
  resolve(input: WorktreePlacementRequest): Promise<WorktreePlacement>;
  createWorktree(placement: ReadyWorktreePlacement): Promise<WorktreePlacement>;
}

function normalizedPath(path: string): string {
  return resolve(path);
}

async function existingPathIdentity(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizedPath(path);
    throw error;
  }
}

function placementIdentity(proposalId: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError("worktree attempt must be a positive safe integer");
  }
  const slug = proposalId
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 32) || "proposal";
  const hash = createHash("sha256").update(proposalId).digest("hex").slice(0, 8);
  const retry = attempt === 1 ? "" : `-retry-${attempt - 1}`;
  return `${slug}-${hash}${retry}`;
}

function plannedWorktree(
  repositoryPath: string,
  proposalId: string,
  attempt: number,
  baseCommit: string
): WorktreeDescriptor & { kind: "isolated" } {
  const identity = placementIdentity(proposalId, attempt);
  return Object.freeze({
    kind: "isolated",
    path: join(dirname(repositoryPath), `${basename(repositoryPath)}-${identity}`),
    branch: `orca-hq/${identity}`,
    head: baseCommit
  });
}

function conflictingOccupancy(
  occupancies: readonly GitWorktreeOccupancy[],
  predicate: (occupancy: GitWorktreeOccupancy) => boolean
): GitWorktreeOccupancy | undefined {
  return occupancies.find(predicate);
}

export class GitWorktreePlacementService implements WorktreePlacementPort {
  constructor(private readonly git: GitWorktreePort) {}

  async resolve(input: WorktreePlacementRequest): Promise<WorktreePlacement> {
    const repositoryPath = normalizedPath(input.repositoryPath);
    const status = await this.git.repositoryStatus(repositoryPath);
    const baseRef = input.baseRef?.trim() || status.branch || (input.riskLevel === "L0" ? status.head : "");
    if (baseRef.length === 0) return Object.freeze({ kind: "review_required", reason: "base_ref_required" });
    const pinnedBaseCommit = input.pinnedBaseCommit?.trim();
    const [baseCommit, occupancies] = await Promise.all([
      this.git.resolveRevision(repositoryPath, pinnedBaseCommit || baseRef),
      this.git.branchOccupancy(repositoryPath)
    ]);
    if (pinnedBaseCommit !== undefined && pinnedBaseCommit.length > 0 && baseCommit !== pinnedBaseCommit) {
      throw new TypeError("pinned base commit did not resolve exactly");
    }

    if (input.riskLevel === "L0") {
      if (status.head !== baseCommit) {
        return Object.freeze({
          kind: "review_required",
          reason: "current_worktree_base_mismatch",
          path: repositoryPath,
          head: status.head,
          baseCommit
        });
      }
      return Object.freeze({
        kind: "ready",
        repositoryPath,
        baseRef,
        baseCommit,
        worktree: Object.freeze({
          kind: "existing-read-only",
          path: repositoryPath,
          branch: status.branch,
          head: status.head
        }),
        permissions: "read-only",
        requiresEditingLease: false
      });
    }

    if (status.dirty) {
      const approval = input.currentWorktreeApproval;
      if (approval === undefined) {
        return Object.freeze({
          kind: "review_required",
          reason: "dirty_current_worktree_requires_approval",
          path: repositoryPath
        });
      }
      if (
        approval.approvalId.trim().length === 0
        || normalizedPath(approval.worktreePath) !== repositoryPath
        || approval.head !== status.head
      ) {
        return Object.freeze({
          kind: "review_required",
          reason: "current_worktree_approval_mismatch",
          path: repositoryPath
        });
      }
      if (status.head !== baseCommit) {
        return Object.freeze({
          kind: "review_required",
          reason: "current_worktree_base_mismatch",
          path: repositoryPath,
          head: status.head,
          baseCommit
        });
      }
      return Object.freeze({
        kind: "ready",
        repositoryPath,
        baseRef,
        baseCommit,
        worktree: Object.freeze({
          kind: "approved-current",
          path: repositoryPath,
          branch: status.branch,
          head: status.head,
          approvalId: approval.approvalId
        }),
        permissions: "read-write",
        requiresEditingLease: true
      });
    }

    const repositoryIdentity = await existingPathIdentity(repositoryPath);
    const occupancyIdentities = await Promise.all(
      occupancies.map(({ path }) => existingPathIdentity(path))
    );
    const baseConflict = occupancies.find((occupancy, index) =>
      occupancy.branch === baseRef && occupancyIdentities[index] !== repositoryIdentity
    );
    if (baseConflict !== undefined) {
      return Object.freeze({
        kind: "review_required",
        reason: "base_branch_occupied_elsewhere",
        path: baseConflict.path,
        branch: baseRef
      });
    }

    const worktree = plannedWorktree(repositoryPath, input.proposalId, input.attempt, baseCommit);
    const branchConflict = conflictingOccupancy(
      occupancies,
      (occupancy) => occupancy.branch === worktree.branch
    );
    if (branchConflict !== undefined) {
      return Object.freeze({
        kind: "review_required",
        reason: "target_branch_occupied",
        path: branchConflict.path,
        branch: worktree.branch
      });
    }
    const pathConflict = conflictingOccupancy(
      occupancies,
      (occupancy) => normalizedPath(occupancy.path) === normalizedPath(worktree.path)
    );
    if (pathConflict !== undefined || await this.git.pathExists(worktree.path)) {
      return Object.freeze({
        kind: "review_required",
        reason: "target_path_occupied",
        path: worktree.path
      });
    }

    return Object.freeze({
      kind: "ready",
      repositoryPath,
      baseRef,
      baseCommit,
      worktree,
      permissions: "read-write",
      requiresEditingLease: true
    });
  }

  async createWorktree(placement: ReadyWorktreePlacement): Promise<WorktreePlacement> {
    if (placement.worktree.kind !== "isolated") return placement;
    const occupancies = await this.git.branchOccupancy(placement.repositoryPath);
    const branchConflict = conflictingOccupancy(
      occupancies,
      (occupancy) => occupancy.branch === placement.worktree.branch
    );
    if (branchConflict !== undefined) {
      return Object.freeze({
        kind: "review_required",
        reason: "target_branch_occupied",
        path: branchConflict.path,
        branch: placement.worktree.branch
      });
    }
    if (
      conflictingOccupancy(
        occupancies,
        (occupancy) => normalizedPath(occupancy.path) === normalizedPath(placement.worktree.path)
      ) !== undefined
      || await this.git.pathExists(placement.worktree.path)
    ) {
      return Object.freeze({
        kind: "review_required",
        reason: "target_path_occupied",
        path: placement.worktree.path
      });
    }
    await this.git.createWorktree({
      repositoryPath: placement.repositoryPath,
      worktreePath: placement.worktree.path,
      branch: placement.worktree.branch,
      baseCommit: placement.baseCommit
    });
    return placement;
  }
}

async function runGit(repositoryPath: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  return result.stdout;
}

function parseWorktreeList(output: string): GitWorktreeOccupancy[] {
  const occupancies: GitWorktreeOccupancy[] = [];
  let current: MutableWorktreeOccupancy | undefined;
  const finish = (): void => {
    if (current?.path !== undefined && current.head !== undefined) {
      occupancies.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head
      });
    }
    current = undefined;
  };

  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      finish();
      current = { path: field.slice("worktree ".length) };
    } else if (field.startsWith("HEAD ") && current !== undefined) {
      current.head = field.slice("HEAD ".length);
    } else if (field.startsWith("branch ") && current !== undefined) {
      current.branch = field.slice("branch refs/heads/".length);
    }
  }
  finish();
  return occupancies;
}

export class SystemGitWorktreePort implements GitWorktreePort {
  async repositoryStatus(repositoryPath: string): Promise<GitRepositoryStatus> {
    const [porcelain, head] = await Promise.all([
      runGit(repositoryPath, ["status", "--porcelain=v1", "-z"]),
      runGit(repositoryPath, ["rev-parse", "--verify", "HEAD"])
    ]);
    let branch: string | null = null;
    try {
      branch = (await runGit(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    } catch {
      branch = null;
    }
    return Object.freeze({ dirty: porcelain.length > 0, head: head.trim(), branch });
  }

  async resolveRevision(repositoryPath: string, ref: string): Promise<string> {
    if (ref.trim().length === 0) throw new TypeError("base ref is required");
    return (await runGit(repositoryPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`
    ])).trim();
  }

  async branchOccupancy(repositoryPath: string): Promise<readonly GitWorktreeOccupancy[]> {
    return parseWorktreeList(await runGit(repositoryPath, ["worktree", "list", "--porcelain", "-z"]));
  }

  async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async createWorktree(input: CreateGitWorktreeInput): Promise<void> {
    const repositoryPath = normalizedPath(input.repositoryPath);
    const worktreePath = normalizedPath(input.worktreePath);
    if (dirname(worktreePath) !== dirname(repositoryPath) || worktreePath === repositoryPath) {
      throw new TypeError("editing worktree must be a top-level repository sibling");
    }
    if (!/^orca-hq\/[a-z0-9][a-z0-9._-]*$/u.test(input.branch)) {
      throw new TypeError("worktree branch is invalid");
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.baseCommit)) {
      throw new TypeError("base commit is invalid");
    }
    await runGit(repositoryPath, [
      "worktree",
      "add",
      "-b",
      input.branch,
      worktreePath,
      input.baseCommit
    ]);
  }
}
