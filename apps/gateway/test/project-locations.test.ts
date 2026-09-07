import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectLocations } from "../src/project-locations.js";

const exec = promisify(execFile);
let root: string;
beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), "hq-locations-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function repo(path: string) { await mkdir(path, { recursive: true }); await exec("git", ["init", "--template=", path]); return path; }

describe("project locations", () => {
  it("finds actual repositories by directory name, without reading project contents", async () => {
    const project = await repo(join(root, "My-App"));
    await mkdir(join(root, "fake-app"));
    expect(await createProjectLocations().search(root, "APP")).toEqual({ paths: [project], truncated: false });
  });
  it("discovers Git worktrees through .git file metadata without reading its contents", async () => {
    const original = await createProjectLocations().create(join(root, "source"));
    const worktree = join(root, "linked-app");
    await exec("git", ["-C", original, "worktree", "add", "--detach", worktree]);
    expect(await createProjectLocations().search(root, "linked-app")).toEqual({ paths: [worktree], truncated: false });
  });
  it("does not follow symlinks or visit hidden and dependency directories", async () => {
    await repo(join(root, ".secrets", "app"));
    await repo(join(root, "node_modules", "app"));
    await repo(join(root, "Library", "app"));
    await symlink(join(root, "Library"), join(root, "linked"));
    expect(await createProjectLocations().search(root, "")).toEqual({ paths: [], truncated: false });
    await expect(createProjectLocations().search(join(root, "linked"), "")).rejects.toThrow(/symlink/i);
  });
  it("bounds depth, entries, results, and elapsed search time", async () => {
    await repo(join(root, "a", "nested"));
    await repo(join(root, "b"));
    expect(await createProjectLocations({ maxDepth: 0 }).search(root, "")).toEqual({ paths: [], truncated: true });
    const shallow = await createProjectLocations({ maxDepth: 1 }).search(root, "");
    expect(shallow.paths).toEqual([join(root, "b")]);
    expect(shallow.truncated).toBe(true);
    expect(await createProjectLocations({ maxEntries: 0 }).search(root, "")).toEqual({ paths: [], truncated: true });
    const limited = await createProjectLocations({ maxResults: 1 }).search(root, "");
    expect(limited.paths).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(await createProjectLocations({ deadlineMs: 0 }).search(root, "")).toEqual({ paths: [], truncated: true });
  });
  it("rejects relative, broad, and sensitive search roots", async () => {
    for (const path of [".", "/", "/Users", homedir(), join(root, ".ssh"), "/etc"]) {
      await expect(createProjectLocations().search(path, "")).rejects.toThrow();
    }
  });
  it("creates an empty committed repository usable by git worktree", async () => {
    const path = join(root, "my project;literal");
    expect(await createProjectLocations().create(path)).toBe(path);
    expect((await exec("git", ["-C", path, "ls-tree", "--name-only", "HEAD"])).stdout).toBe("");
    await exec("git", ["-C", path, "worktree", "add", "--detach", join(root, "worktree")]);
  });
  it("never overwrites an existing directory or creates missing parents", async () => {
    const path = join(root, "existing");
    await mkdir(path);
    await writeFile(join(path, "keep.txt"), "untouched");
    await expect(createProjectLocations().create(path)).rejects.toThrow();
    expect(await readFile(join(path, "keep.txt"), "utf8")).toBe("untouched");
    await expect(createProjectLocations().create(join(root, "missing", "child"))).rejects.toThrow();
  });
  it("does not execute inherited Git configuration or hooks", async () => {
    const hook = join(root, "hook");
    const marker = join(root, "hook-ran");
    await mkdir(hook);
    await writeFile(join(hook, "pre-commit"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    const config = join(root, "gitconfig");
    await writeFile(config, `[core]\n hooksPath = ${hook}\n[commit]\n gpgSign = true\n`);
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      const project = await createProjectLocations().create(join(root, "isolated"));
      expect((await exec("git", ["-C", project, "log", "-1", "--format=%an <%ae>"])).stdout.trim()).toBe("Orca HQ <orca-hq@localhost>");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });
  it("rejects symlink parents when creating a repository", async () => {
    await mkdir(join(root, "actual"));
    await symlink(join(root, "actual"), join(root, "link"));
    await expect(createProjectLocations().create(join(root, "link", "new"))).rejects.toThrow(/symlink/i);
  });
});
