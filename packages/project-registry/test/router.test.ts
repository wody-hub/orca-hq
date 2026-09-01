import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  decideRankedRoute,
  Registry,
  routeProject,
  type DiscoveredProject,
  type ProjectRegistryEntry
} from "../src/index.js";

const temporaryDirectories: string[] = [];

const discoveredProjects: DiscoveredProject[] = [
  {
    orcaProjectId: "orca-synthetic-api",
    absolutePath: "/srv/orca/projects/synthetic-api",
    approved: true
  },
  {
    orcaProjectId: "orca-synthetic-web",
    absolutePath: "/srv/orca/projects/synthetic-web",
    approved: true
  }
];

const entries: ProjectRegistryEntry[] = [
  {
    projectKey: "synthetic-api",
    orcaProjectId: "orca-synthetic-api",
    absolutePath: "/srv/orca/projects/synthetic-api",
    canonicalRemote: "https://git.example.test/synthetic/api.git",
    aliases: ["Synthetic API", "synthetic backend"],
    component: "backend",
    instructionsFiles: ["AGENTS.md"],
    setupPolicy: "run",
    allowedOperations: ["L0", "L1", "L2"],
    requiredChecks: ["pnpm test"],
    sensitivePaths: ["secrets/**"],
    lockKey: "synthetic-api"
  },
  {
    projectKey: "synthetic-web",
    orcaProjectId: "orca-synthetic-web",
    absolutePath: "/srv/orca/projects/synthetic-web",
    canonicalRemote: "https://git.example.test/synthetic/web.git",
    aliases: ["Synthetic Web"],
    component: "frontend",
    instructionsFiles: [],
    setupPolicy: "inherit",
    allowedOperations: ["L0", "L1"],
    requiredChecks: ["pnpm test"],
    sensitivePaths: [],
    lockKey: "synthetic-web"
  }
];

function registryFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "orca-hq-registry-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "projects.yaml");
  writeFileSync(path, contents, "utf8");
  return path;
}

function registryYaml(projects: unknown = entries): string {
  return `projects:\n${JSON.stringify(projects, null, 2).replace(/^/gm, "  ")}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Registry.load", () => {
  it("loads only approved discovered projects from a real YAML registry file", () => {
    const loaded = Registry.load(registryFile(registryYaml()), discoveredProjects);

    expect(loaded).toEqual(entries);
  });

  it("fails closed when no approved Orca imports are supplied", () => {
    expect(() => Registry.load(registryFile(registryYaml())))
      .toThrow("was not imported from Orca");
  });

  it("rejects aliases that collide after Unicode, whitespace, and case normalization", () => {
    const duplicateAliasEntries = [
      entries[0],
      { ...entries[1], aliases: ["  ＳＹＮＴＨＥＴＩＣ   ＡＰＩ  "] }
    ];

    expect(() => Registry.load(registryFile(registryYaml(duplicateAliasEntries)), discoveredProjects))
      .toThrow("duplicate alias");
  });

  it("rejects a relative project path", () => {
    const relativePathEntries = [{ ...entries[0], absolutePath: "projects/synthetic-api" }];

    expect(() => Registry.load(registryFile(registryYaml(relativePathEntries)), discoveredProjects))
      .toThrow("absolutePath");
  });

  it("rejects an entry without required checks", () => {
    const uncheckedEntries = [{ ...entries[0], requiredChecks: [] }];

    expect(() => Registry.load(registryFile(registryYaml(uncheckedEntries)), discoveredProjects))
      .toThrow("requiredChecks");
  });

  it("rejects an imported project that a human has not approved", () => {
    const unapproved = [{ ...discoveredProjects[0], approved: false }, discoveredProjects[1]];

    expect(() => Registry.load(registryFile(registryYaml()), unapproved))
      .toThrow("not approved");
  });

  it("rejects an operation risk level outside L0 through L3", () => {
    const invalidOperationEntries = [{ ...entries[0], allowedOperations: ["L4"] }];

    expect(() => Registry.load(registryFile(registryYaml(invalidOperationEntries)), discoveredProjects))
      .toThrow("allowedOperations");
  });
});

describe("routeProject", () => {
  it("selects an exact approved alias regardless of text case", () => {
    const result = routeProject({ text: "Please test SYNTHETIC API today" }, entries);

    expect(result).toEqual({
      kind: "selected",
      projectKey: "synthetic-api",
      score: 1,
      evidence: ["alias:Synthetic API"]
    });
  });

  it("requires clarification when two exact aliases are ambiguous", () => {
    const result = routeProject({ text: "Compare Synthetic API with Synthetic Web" }, entries);

    expect(result).toEqual({
      kind: "clarification_required",
      candidates: [
        { projectKey: "synthetic-api", score: 1, evidence: ["alias:Synthetic API"] },
        { projectKey: "synthetic-web", score: 1, evidence: ["alias:Synthetic Web"] }
      ]
    });
  });
});

describe("decideRankedRoute", () => {
  it("selects a candidate at the exact score and margin thresholds", () => {
    expect(decideRankedRoute([
      { projectKey: "a", score: 0.85, evidence: ["model"] },
      { projectKey: "b", score: 0.7, evidence: ["model"] }
    ])).toEqual({ kind: "selected", projectKey: "a", score: 0.85, evidence: ["model"] });
  });

  it("selects a mathematical 0.15 margin despite decimal representation", () => {
    expect(decideRankedRoute([
      { projectKey: "a", score: 0.95, evidence: ["model"] },
      { projectKey: "b", score: 0.8, evidence: ["model"] }
    ])).toEqual({ kind: "selected", projectKey: "a", score: 0.95, evidence: ["model"] });
  });

  it("requires clarification below the score threshold", () => {
    expect(decideRankedRoute([
      { projectKey: "a", score: 0.849, evidence: ["model"] }
    ])).toEqual({
      kind: "clarification_required",
      candidates: [{ projectKey: "a", score: 0.849, evidence: ["model"] }]
    });
  });

  it("requires clarification when the winner margin is below 0.15", () => {
    expect(decideRankedRoute([
      { projectKey: "a", score: 0.9, evidence: ["model"] },
      { projectKey: "b", score: 0.751, evidence: ["model"] }
    ])).toEqual({
      kind: "clarification_required",
      candidates: [
        { projectKey: "a", score: 0.9, evidence: ["model"] },
        { projectKey: "b", score: 0.751, evidence: ["model"] }
      ]
    });
  });
});
