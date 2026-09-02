import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileAssignmentArtifactStore,
  type AssignmentArtifact
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function store(): Promise<FileAssignmentArtifactStore> {
  const directory = await mkdtemp(join(tmpdir(), "orca-hq-assignment-artifacts-"));
  directories.push(directory);
  return new FileAssignmentArtifactStore({ rootDirectory: join(directory, "assignments") });
}

describe("FileAssignmentArtifactStore", () => {
  it("durably stages a private artifact before launch and atomically swaps retry versions", async () => {
    // Break caught: a post-start receipt cannot be consumed as the worker's initial assignment.
    const artifacts = await store();
    const reference = artifacts.referenceFor("task:proposal-1:implement");
    const first = await artifacts.stage({
      reference,
      version: 1,
      ownerDispatchId: "dispatch:proposal-1:implement:1",
      content: "attempt-one"
    });

    expect(JSON.parse(await readFile(reference.path, "utf8"))).toEqual(first);
    expect((await stat(reference.path)).mode & 0o777).toBe(0o600);

    const second = await artifacts.stage({
      reference,
      version: 2,
      ownerDispatchId: "dispatch:proposal-1:implement:2",
      content: "attempt-two"
    });

    expect(second.path).toBe(first.path);
    expect(second.version).toBe(2);
    expect(second.sha256).not.toBe(first.sha256);
    expect(JSON.parse(await readFile(reference.path, "utf8"))).toEqual(second);
    await expect(artifacts.cleanup(first)).resolves.toBe("superseded");
    expect(JSON.parse(await readFile(reference.path, "utf8"))).toEqual(second);
    await expect(artifacts.cleanup(second)).resolves.toBe("removed");
    await expect(access(reference.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stale or duplicate version without replacing the current owner", async () => {
    // Break caught: attempt one must never overwrite an already-staged attempt two assignment.
    const artifacts = await store();
    const reference = artifacts.referenceFor("task:proposal-1:implement");
    const current = await artifacts.stage({
      reference,
      version: 2,
      ownerDispatchId: "dispatch:proposal-1:implement:2",
      content: "current-attempt"
    });

    await expect(artifacts.stage({
      reference,
      version: 1,
      ownerDispatchId: "dispatch:proposal-1:implement:1",
      content: "stale-attempt"
    })).rejects.toMatchObject({ code: "assignment_artifact_version_conflict" });
    expect(JSON.parse(await readFile(reference.path, "utf8"))).toEqual(current);
  });

  it("validates cleanup ownership instead of deleting a replacement artifact", async () => {
    // Break caught: delayed cleanup from an older Dispatch cannot delete the live retry input.
    const artifacts = await store();
    const reference = artifacts.referenceFor("task:proposal-1:implement");
    const current = await artifacts.stage({
      reference,
      version: 1,
      ownerDispatchId: "dispatch:proposal-1:implement:1",
      content: "current-attempt"
    });
    const forged = {
      ...current,
      ownerDispatchId: "dispatch:proposal-1:implement:other"
    } satisfies AssignmentArtifact;

    await expect(artifacts.cleanup(forged)).resolves.toBe("superseded");
    expect(JSON.parse(await readFile(reference.path, "utf8"))).toEqual(current);
  });

  it("rejects an unsafe pre-existing root without changing caller-owned permissions", async () => {
    // Break caught: an artifact store must never chmod /tmp or another shared caller directory.
    const directory = await mkdtemp(join(tmpdir(), "orca-hq-unsafe-artifact-root-"));
    directories.push(directory);
    const sharedRoot = join(directory, "shared");
    await mkdir(sharedRoot, { mode: 0o777 });
    await chmod(sharedRoot, 0o777);
    const artifacts = new FileAssignmentArtifactStore({ rootDirectory: sharedRoot });
    const reference = artifacts.referenceFor("task:proposal-1:implement");

    await expect(artifacts.stage({
      reference,
      version: 1,
      ownerDispatchId: "dispatch:proposal-1:implement:1",
      content: "attempt-one"
    })).rejects.toMatchObject({ code: "assignment_artifact_root_unsafe" });
    expect((await stat(sharedRoot)).mode & 0o777).toBe(0o777);
  });

  it("rejects a symlink at the artifact root", async () => {
    // Break caught: the store must not follow a caller-controlled final root link.
    const directory = await mkdtemp(join(tmpdir(), "orca-hq-linked-artifact-root-"));
    directories.push(directory);
    const target = join(directory, "target");
    const linkedRoot = join(directory, "assignments");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linkedRoot);
    const artifacts = new FileAssignmentArtifactStore({ rootDirectory: linkedRoot });

    await expect(artifacts.stage({
      reference: artifacts.referenceFor("task:proposal-1:implement"),
      version: 1,
      ownerDispatchId: "dispatch:proposal-1:implement:1",
      content: "attempt-one"
    })).rejects.toMatchObject({ code: "assignment_artifact_root_unsafe" });
  });

  it("canonicalizes a symlinked ancestor before deriving artifact references", async () => {
    // Break caught: later path operations must not re-follow an ancestor link that can be swapped.
    const directory = await mkdtemp(join(tmpdir(), "orca-hq-linked-artifact-parent-"));
    directories.push(directory);
    const targetParent = join(directory, "target-parent");
    const linkedParent = join(directory, "linked-parent");
    await mkdir(targetParent, { mode: 0o700 });
    await symlink(targetParent, linkedParent);
    const artifacts = new FileAssignmentArtifactStore({
      rootDirectory: join(linkedParent, "assignments")
    });
    const reference = artifacts.referenceFor("task:proposal-1:implement");

    expect(reference.path.startsWith(`${await realpath(targetParent)}/`)).toBe(true);
    await expect(artifacts.stage({
      reference,
      version: 1,
      ownerDispatchId: "dispatch:proposal-1:implement:1",
      content: "attempt-one"
    })).resolves.toMatchObject({ path: reference.path });
  });
});
