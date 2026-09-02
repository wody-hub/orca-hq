import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sandboxPrefix = "orca-hq-sandbox-repo-";

export interface SandboxRepositoryStatus {
  readonly dirty: boolean;
  readonly head: string;
  readonly branch: string | null;
}

export interface SandboxWorktreeOccupancy {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string;
}

export interface SandboxCreateWorktreeInput {
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

async function runGit(repositoryPath: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  return result.stdout;
}

function parseWorktreeList(output: string): SandboxWorktreeOccupancy[] {
  const occupancies: SandboxWorktreeOccupancy[] = [];
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

export class SandboxGit {
  constructor(
    private readonly rootPath: string,
    private readonly repositoryPath: string
  ) {}

  async repositoryStatus(repositoryPath: string): Promise<SandboxRepositoryStatus> {
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
    return {
      dirty: porcelain.length > 0,
      head: head.trim(),
      branch
    };
  }

  async resolveRevision(repositoryPath: string, ref: string): Promise<string> {
    return (await runGit(repositoryPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`
    ])).trim();
  }

  async branchOccupancy(repositoryPath: string): Promise<readonly SandboxWorktreeOccupancy[]> {
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

  async createWorktree(input: SandboxCreateWorktreeInput): Promise<void> {
    if (resolve(input.repositoryPath) !== resolve(this.repositoryPath)) {
      throw new TypeError("sandbox worktrees must belong to the sandbox repository");
    }
    if (dirname(resolve(input.worktreePath)) !== resolve(this.rootPath)) {
      throw new TypeError("sandbox worktree must be a top-level sibling of the repository");
    }
    if (!/^orca-hq\/[a-z0-9][a-z0-9._-]*$/u.test(input.branch)) {
      throw new TypeError("sandbox worktree branch is invalid");
    }
    if (!/^[0-9a-f]{40}$/u.test(input.baseCommit)) {
      throw new TypeError("sandbox base commit is invalid");
    }
    await runGit(input.repositoryPath, [
      "worktree",
      "add",
      "-b",
      input.branch,
      input.worktreePath,
      input.baseCommit
    ]);
  }
}

export class SandboxRepo {
  readonly git: SandboxGit;

  private constructor(
    readonly rootPath: string,
    readonly repositoryPath: string,
    readonly initialCommit: string
  ) {
    this.git = new SandboxGit(rootPath, repositoryPath);
  }

  static async create(): Promise<SandboxRepo> {
    const rootPath = await mkdtemp(join(tmpdir(), sandboxPrefix));
    const repositoryPath = join(rootPath, "repository");
    await mkdir(repositoryPath);
    await execFileAsync("git", ["init", "--initial-branch=main", repositoryPath], {
      encoding: "utf8"
    });
    await runGit(repositoryPath, ["config", "user.name", "Orca HQ Sandbox"]);
    await runGit(repositoryPath, ["config", "user.email", "sandbox@example.invalid"]);
    await writeFile(join(repositoryPath, "README.md"), "# Sandbox repository\n", "utf8");
    await runGit(repositoryPath, ["add", "--", "README.md"]);
    await runGit(repositoryPath, ["commit", "-m", "chore: initialize sandbox"]);
    const initialCommit = (await runGit(repositoryPath, ["rev-parse", "HEAD"])).trim();
    return new SandboxRepo(rootPath, repositoryPath, initialCommit);
  }

  async cleanup(): Promise<void> {
    const resolved = resolve(this.rootPath);
    if (dirname(resolved) !== resolve(tmpdir()) || !basename(resolved).startsWith(sandboxPrefix)) {
      throw new Error("refusing to remove a path outside the sandbox temp root");
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

export async function createSandboxRepo(): Promise<SandboxRepo> {
  return SandboxRepo.create();
}
