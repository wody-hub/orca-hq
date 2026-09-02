import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { ORCA_HQ_PROTOCOL_VERSION } from "../src/index.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const vitestExecutable = join(workspaceRoot, "node_modules/vitest/vitest.mjs");

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
});
