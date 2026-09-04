import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ORCA_HQ_PROTOCOL_VERSION } from "../src/index.js";
import vitestConfig from "../../../vitest.config.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const vitestExecutable = join(workspaceRoot, "node_modules/vitest/vitest.mjs");

interface AliasEntry {
  readonly find: string | RegExp;
  readonly replacement: string;
}

function configuredAliases(): readonly AliasEntry[] {
  const alias = (vitestConfig as {
    readonly resolve?: {
      readonly alias?: Readonly<Record<string, string>> | readonly AliasEntry[];
    };
  }).resolve?.alias;
  if (alias === undefined) return [];
  if (Array.isArray(alias)) return alias;
  return Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
}

function resolveAlias(specifier: string): string | undefined {
  for (const { find, replacement } of configuredAliases()) {
    if (typeof find === "string") {
      if (specifier !== find && !specifier.startsWith(`${find}/`)) continue;
      return `${replacement}${specifier.slice(find.length)}`;
    }
    if (!find.test(specifier)) continue;
    return specifier.replace(find, replacement);
  }
  return undefined;
}

function sourceFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules" || entry.name === "test-results") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    if (entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function workspacePackageImports(): readonly string[] {
  const imports = new Set<string>();
  for (const root of ["packages", "apps", "tests"]) {
    for (const path of sourceFiles(join(workspaceRoot, root))) {
      const source = readFileSync(path, "utf8");
      for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
        if (imported.fileName.startsWith("@orca-hq/")) imports.add(imported.fileName);
      }
    }
  }
  return [...imports].sort();
}

describe("workspace", () => {
  it("exports one explicit protocol version", () => {
    expect(ORCA_HQ_PROTOCOL_VERSION).toBe(1);
  });

  it("does not discover tests from nested worktrees", () => {
    const worktreesDirectory = join(workspaceRoot, ".worktrees");
    const worktreesDirectoryExisted = existsSync(worktreesDirectory);
    let fixtureDirectory: string | undefined;

    try {
      mkdirSync(worktreesDirectory, { recursive: true });
      fixtureDirectory = mkdtempSync(join(worktreesDirectory, "test-discovery-"));
      writeFileSync(
        join(fixtureDirectory, "nested.test.ts"),
        "throw new Error('nested worktree test was collected');\n"
      );

      const discoveredTests = execFileSync(
        process.execPath,
        [vitestExecutable, "list", "--filesOnly"],
        { cwd: workspaceRoot, encoding: "utf8" }
      );

      expect(discoveredTests).not.toContain(relative(workspaceRoot, fixtureDirectory));
    } finally {
      if (fixtureDirectory !== undefined) {
        rmSync(fixtureDirectory, { recursive: true });
      }
      if (!worktreesDirectoryExisted) {
        try {
          rmdirSync(worktreesDirectory);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            (error.code !== "ENOENT" && error.code !== "ENOTEMPTY")
          ) {
            throw error;
          }
        }
      }
    }
  });

  it("maps every workspace package import to a source entry", () => {
    // Break caught: a new public workspace import must not fall through to stale or missing dist.
    const unresolved = workspacePackageImports().filter((specifier) => {
      const resolved = resolveAlias(specifier);
      return resolved === undefined || !resolved.includes(`${sep}src${sep}`) || !existsSync(resolved);
    });

    expect(unresolved).toEqual([]);
  });
});
