import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProjectCatalog,
  selectOrcaCliExecutable,
  selectOrcaCliEnvironment,
  type OrcaProject
} from "../src/managed-projects.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix = "orca-managed-projects-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function projects(count: number): OrcaProject[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `orca-${index + 1}`,
    name: `project-${index + 1}`,
    absolutePath: `/workspace/project-${index + 1}`
  }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("managed project catalog", () => {
  it.each([
    [{ ORCA_CLI_COMMAND: "/custom/orca" }, "darwin", "/custom/orca"],
    [{ ORCA_DEV_REPO_ROOT: "/workspace/orca" }, "darwin", "orca-dev"],
    [{}, "linux", "orca-ide"],
    [{}, "darwin", "orca"]
  ] as const)("selects the shared Orca executable for environment %j on %s", (environment, hostPlatform, expected) => {
    expect(selectOrcaCliExecutable(environment, hostPlatform)).toBe(expected);
  });

  it("preserves runtime connection context while excluding unrelated process secrets", () => {
    expect(selectOrcaCliEnvironment({
      PATH: "/bin",
      ORCA_CLI_COMMAND: "/custom/orca",
      ORCA_ENVIRONMENT: "saved-environment",
      ORCA_PAIRING_CODE: "pairing-context",
      ORCA_USER_DATA_PATH: "/profile/orca",
      UNRELATED_SECRET: "must-not-propagate"
    })).toEqual({
      PATH: "/bin",
      ORCA_CLI_COMMAND: "/custom/orca",
      ORCA_ENVIRONMENT: "saved-environment",
      ORCA_PAIRING_CODE: "pairing-context",
      ORCA_USER_DATA_PATH: "/profile/orca"
    });
  });

  it("lists every Orca project and preserves legacy execution protections", async () => {
    const directory = await temporaryDirectory();
    const legacyRegistryPath = join(directory, "projects.yaml");
    await writeFile(
      legacyRegistryPath,
      [
        "projects:",
        "  - projectKey: project-1",
        "    orcaProjectId: orca-1",
        "    absolutePath: /workspace/project-1",
        "    aliases: [legacy-one]",
        "    component: mixed",
        "    instructionsFiles: []",
        "    setupPolicy: run",
        "    allowedOperations: [L0]",
        "    requiredChecks: [pnpm test]",
        "    sensitivePaths: [.env, docs/private.md]",
        "    lockKey: project-1"
      ].join("\n"),
      "utf8"
    );
    const catalog = createProjectCatalog({
      directory,
      legacyRegistryPath,
      discover: async () => projects(6)
    });

    const listed = await catalog.list();

    expect(listed).toHaveLength(6);
    expect(listed[0]).toMatchObject({
      id: "orca-1",
      aliases: ["legacy-one"],
      sensitivePaths: [".env", "docs/private.md"],
      setupPolicy: "run"
    });
    expect(listed[5]).toMatchObject({
      id: "orca-6",
      aliases: [],
      enabled: true,
      sensitivePaths: [],
      setupPolicy: "inherit"
    });
  });

  it("keeps matching legacy metadata when another legacy project disappeared from Orca", async () => {
    // Break caught: one stale legacy entry must not make every current Orca project unavailable.
    const directory = await temporaryDirectory();
    const legacyRegistryPath = join(directory, "projects.yaml");
    const entry = (id: string, name: string, path: string) => [
      `  - projectKey: ${name}`,
      `    orcaProjectId: ${id}`,
      `    absolutePath: ${path}`,
      `    aliases: [${name}-legacy]`,
      "    component: mixed",
      "    instructionsFiles: []",
      "    setupPolicy: skip",
      "    allowedOperations: [L0]",
      "    requiredChecks: [pnpm test]",
      "    sensitivePaths: [.env]",
      `    lockKey: ${name}`
    ].join("\n");
    await writeFile(legacyRegistryPath, [
      "projects:",
      entry("orca-current", "old-current-name", "/workspace/current"),
      entry("orca-stale", "stale", "/workspace/stale")
    ].join("\n"), "utf8");
    const catalog = createProjectCatalog({
      directory,
      legacyRegistryPath,
      discover: async () => [{ id: "orca-current", name: "new-current-name", absolutePath: "/workspace/current" }]
    });

    const listed = await catalog.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: "orca-current",
      name: "new-current-name",
      aliases: ["old-current-name", "old-current-name-legacy"],
      setupPolicy: "skip"
    });
    await expect(catalog.resolve("old-current-name")).resolves.toMatchObject({ id: "orca-current" });
  });

  it("merges configured global sensitive defaults without duplicating legacy paths", async () => {
    // Break caught: generic secret defaults can disappear for projects that have no legacy metadata.
    const directory = await temporaryDirectory();
    const catalog = createProjectCatalog({
      directory,
      defaultSensitivePaths: [".env", ".env.*", "**/*.pem", ".env"],
      discover: async () => projects(1)
    });

    await expect(catalog.resolve("orca-1")).resolves.toMatchObject({
      sensitivePaths: [".env", ".env.*", "**/*.pem"]
    });
  });

  it("persists aliases and HQ exclusions across catalog instances", async () => {
    const directory = await temporaryDirectory();
    const discover = async () => projects(1);
    const first = createProjectCatalog({ directory, discover });
    await first.alias("orca-1", "첫 프로젝트");
    await first.setEnabled("첫 프로젝트", false);

    const second = createProjectCatalog({ directory, discover });

    expect(await second.resolve("첫 프로젝트")).toMatchObject({
      id: "orca-1",
      aliases: ["첫 프로젝트"],
      enabled: false
    });
    expect(JSON.parse(await readFile(join(directory, "managed-projects.json"), "utf8")))
      .toMatchObject({ projects: { "orca-1": { aliases: ["첫 프로젝트"], enabled: false } } });
  });

  it("preserves concurrent metadata mutations from separate catalog instances", async () => {
    // Break caught: two read-modify-rename operations can each succeed while the later rename drops the earlier update.
    const directory = await temporaryDirectory();
    const discover = async () => projects(2);
    const first = createProjectCatalog({ directory, discover });
    const second = createProjectCatalog({ directory, discover });

    await Promise.all([
      first.alias("orca-1", "primary"),
      second.setEnabled("orca-2", false)
    ]);

    expect(await first.resolve("primary")).toMatchObject({ id: "orca-1" });
    expect(await first.resolve("orca-2")).toMatchObject({ enabled: false });
  });

  it("rejects selectors that match duplicate Orca names", async () => {
    const directory = await temporaryDirectory();
    const discover = async () => [
      { id: "orca-a", name: "shared", absolutePath: "/workspace/a" },
      { id: "orca-b", name: "shared", absolutePath: "/workspace/b" }
    ];
    const catalog = createProjectCatalog({ directory, discover });

    await expect(catalog.resolve("shared")).rejects.toThrow("project_selector_ambiguous");
    await expect(catalog.alias("orca-a", "shared")).rejects.toThrow("project_alias_conflict");
  });

  it("rejects aliases that collide with another project's id or alias", async () => {
    const directory = await temporaryDirectory();
    const catalog = createProjectCatalog({ directory, discover: async () => projects(2) });
    await catalog.alias("orca-1", "primary");

    await expect(catalog.alias("orca-2", "PRIMARY")).rejects.toThrow("project_alias_conflict");
    await expect(catalog.alias("orca-2", "orca-1")).rejects.toThrow("project_alias_conflict");
  });

  it("guards project metadata mutations while the project is busy", async () => {
    const directory = await temporaryDirectory();
    const catalog = createProjectCatalog({
      directory,
      discover: async () => projects(1),
      isBusy: id => id === "orca-1"
    });

    await expect(catalog.alias("orca-1", "blocked")).rejects.toThrow("project_busy:orca-1");
    await expect(catalog.setEnabled("orca-1", false)).rejects.toThrow("project_busy:orca-1");
  });

  it("canonicalizes a Git repository before registering it with Orca", async () => {
    const directory = await temporaryDirectory();
    const repository = join(directory, "repository");
    const nested = join(repository, "nested");
    await mkdir(nested, { recursive: true });
    await execute("git", ["-C", repository, "init", "--quiet"]);
    const addToOrca = vi.fn(async (absolutePath: string): Promise<OrcaProject> => ({
      id: "orca-added",
      name: "repository",
      absolutePath
    }));
    const catalog = createProjectCatalog({
      directory: join(directory, "metadata"),
      discover: async () => [],
      addToOrca
    });
    const canonicalRepository = await realpath(repository);

    expect(await catalog.add(nested)).toMatchObject({
      id: "orca-added",
      absolutePath: canonicalRepository
    });
    expect(addToOrca).toHaveBeenCalledWith(canonicalRepository);
  });

  it("serializes concurrent registration of the same absolute Git repository", async () => {
    // Break caught: concurrent add requests can both observe absence and invoke Orca registration twice.
    const directory = await temporaryDirectory();
    const repository = join(directory, "repository");
    await mkdir(repository);
    await execute("git", ["-C", repository, "init", "--quiet"]);
    const registered: OrcaProject[] = [];
    const addToOrca = vi.fn(async (absolutePath: string): Promise<OrcaProject> => {
      const added = { id: "orca-added", name: "repository", absolutePath };
      registered.push(added);
      return added;
    });
    const catalog = createProjectCatalog({
      directory: join(directory, "metadata"),
      discover: async () => registered,
      addToOrca
    });

    const [first, second] = await Promise.all([catalog.add(repository), catalog.add(repository)]);

    expect(first).toEqual(second);
    expect(addToOrca).toHaveBeenCalledTimes(1);
  });

  it("rejects a relative Git path before invoking Orca registration", async () => {
    // Break caught: structured clients can bypass the terminal absolute-path check and resolve against gateway cwd.
    const directory = await temporaryDirectory();
    const addToOrca = vi.fn();
    const catalog = createProjectCatalog({ directory, discover: async () => [], addToOrca });

    await expect(catalog.add("relative/repository")).rejects.toThrow("project_path_not_absolute");
    expect(addToOrca).not.toHaveBeenCalled();
  });

  it("does not call Orca registration for a non-Git path", async () => {
    const directory = await temporaryDirectory();
    const plainDirectory = join(directory, "plain");
    await mkdir(plainDirectory);
    const addToOrca = vi.fn();
    const catalog = createProjectCatalog({
      directory: join(directory, "metadata"),
      discover: async () => [],
      addToOrca
    });

    await expect(catalog.add(plainDirectory)).rejects.toThrow("project_path_not_git");
    expect(addToOrca).not.toHaveBeenCalled();
  });
});
