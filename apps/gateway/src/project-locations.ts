import { execFile } from "node:child_process";
import { lstat, mkdir, opendir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ignored = new Set(["node_modules", "Library", "vendor", "dist", "build", "coverage", "__pycache__"]);
const systemRoots = new Set(["etc", "System", "Library", "Applications", "bin", "sbin", "usr", "dev", "proc", "sys", "boot", "root", "Volumes"]);

export interface ProjectLocationOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxResults?: number;
  deadlineMs?: number;
}

function validatePath(input: string): string {
  if (!isAbsolute(input) || input.includes("\0")) throw new Error("An absolute project path is required");
  const path = resolve(input);
  const parts = path.split(sep).filter(Boolean);
  if (parts.some((part) => part.startsWith(".") || ignored.has(part)) ||
      systemRoots.has(parts[0] ?? "") || parts.length < 2 || path === resolve(homedir()) ||
      ((parts[0] === "Users" || parts[0] === "home") && parts.length < 3)) {
    throw new Error("Broad or sensitive project paths are not allowed");
  }
  return path;
}

async function checkedDirectory(path: string): Promise<string> {
  // Inspect every ancestor: realpath alone would silently accept a symlink parent.
  let current = parse(path).root;
  for (const segment of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Symlink project paths are not allowed");
    if (!info.isDirectory()) throw new Error("Project parent must be an existing directory");
  }
  return realpath(path);
}

async function allowedDirectory(path: string): Promise<string> {
  const canonical = await checkedDirectory(path);
  // /private/var contains macOS temporary folders as well as sensitive system data.
  if (canonical.startsWith("/private/") || canonical.startsWith("/var/")) {
    const temp = await realpath(tmpdir());
    if (!canonical.startsWith(`${temp}${sep}`)) throw new Error("Sensitive system paths are not allowed");
  }
  return canonical;
}

function bounded(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Search limits must be nonnegative integers");
  return Math.min(value, fallback);
}

export function createProjectLocations(options: ProjectLocationOptions = {}) {
  const maxDepth = bounded(options.maxDepth, 4);
  const maxEntries = bounded(options.maxEntries, 2000);
  const maxResults = bounded(options.maxResults, 20);
  const deadlineMs = bounded(options.deadlineMs, 5000);
  return {
    async search(root: string, query: string): Promise<{ paths: string[]; truncated: boolean }> {
      const started = performance.now();
      const canonical = await allowedDirectory(validatePath(root));
      const paths: string[] = [];
      let entries = 0;
      let truncated = false;
      const pending = [{ path: canonical, depth: 0 }];
      const expired = () => performance.now() - started >= deadlineMs;
      while (pending.length > 0) {
        if (expired() || entries >= maxEntries || paths.length >= maxResults) { truncated = true; break; }
        const next = pending.shift()!;
        try {
          // Recheck queued entries in case a directory was replaced with a symlink.
          if (!(await lstat(next.path)).isDirectory()) continue;
          const directory = await opendir(next.path, { bufferSize: 1 });
          for await (const entry of directory) {
            if (expired() || entries >= maxEntries || paths.length >= maxResults) { truncated = true; break; }
            entries += 1;
            if (entry.name === ".git" && (entry.isDirectory() || entry.isFile())) {
              if (basename(next.path).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) paths.push(next.path);
              continue;
            }
            if (!entry.isDirectory() || entry.name.startsWith(".") || ignored.has(entry.name)) continue;
            if (next.depth >= maxDepth) { truncated = true; continue; }
            pending.push({ path: join(next.path, entry.name), depth: next.depth + 1 });
          }
        } catch (error) {
          if (["EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            truncated = true;
          } else throw error;
        }
      }
      return { paths, truncated };
    },
    async create(input: string): Promise<string> {
      const path = validatePath(input);
      const parent = await allowedDirectory(dirname(path));
      const target = join(parent, basename(path));
      await mkdir(target, { recursive: false, mode: 0o700 });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
      env.GIT_CONFIG_NOSYSTEM = "1";
      env.GIT_CONFIG_GLOBAL = "/dev/null";
      const config = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Orca HQ", "-c", "user.email=orca-hq@localhost"];
      try {
        await exec("git", [...config, "init", "--template=", "--", target], { env, timeout: 10_000 });
        await exec("git", ["-C", target, ...config, "commit", "--allow-empty", "--no-gpg-sign", "-m", "Initialize project"], { env, timeout: 10_000 });
      } catch {
        // Keep the exclusively-created directory intact; never delete user paths on failure.
        throw new Error(`Git initialization failed; the new directory was preserved: ${target}`);
      }
      return target;
    }
  };
}
