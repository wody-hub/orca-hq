import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const verifierSource = join(repositoryRoot, "scripts", "verify-clean-workspace.mjs");
const stagingDirectoryName = ".clean-workspace-staging";

interface Fixture {
  readonly root: string;
  readonly externalTemporaryDirectory: string;
  readonly commandLogPath: string;
  readonly preloadPath: string;
  readonly verifierPath: string;
}

interface VerificationResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly commands: readonly string[];
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function writeDist(root: string, relativePath: string, marker: string): void {
  const dist = join(root, relativePath, "dist");
  mkdirSync(join(dist, "nested"), { recursive: true });
  writeFileSync(join(dist, "marker.txt"), `${marker}\n`, "utf8");
  writeFileSync(join(dist, "nested", "payload.txt"), `${marker}:payload\n`, "utf8");
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "orca-hq-clean-verifier-workspace-"));
  const externalTemporaryDirectory = mkdtempSync(
    join(tmpdir(), "orca-hq-clean-verifier-external-")
  );
  const verifierPath = join(root, "scripts", "verify-clean-workspace.mjs");
  const preloadPath = join(root, "test-support", "fail-backup-rename.mjs");
  const binDirectory = join(root, "test-support", "bin");
  const commandLogPath = join(root, "test-support", "commands.log");

  mkdirSync(dirname(verifierPath), { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  copyFileSync(verifierSource, verifierPath);
  writeJson(join(root, "packages", "core", "package.json"), { name: "@orca-hq/core" });
  writeJson(join(root, "packages", "installer", "package.json"), {
    name: "@orca-hq/installer"
  });
  writeJson(join(root, "packages", "test-support", "package.json"), {
    name: "@orca-hq/test-support",
    dependencies: { "@orca-hq/core": "workspace:*" }
  });
  mkdirSync(join(root, "apps"), { recursive: true });

  for (const [relativePath, marker] of [
    ["packages/core", "original-core"],
    ["packages/installer", "original-installer"],
    ["packages/test-support", "original-test-support"]
  ] as const) {
    writeDist(root, relativePath, marker);
  }

  const siblingPath = join(root, stagingDirectoryName, "user-sibling", "keep.txt");
  mkdirSync(dirname(siblingPath), { recursive: true });
  writeFileSync(siblingPath, "do-not-delete\n", "utf8");
  writeFileSync(
    join(externalTemporaryDirectory, "user-file.txt"),
    "do-not-delete\n",
    "utf8"
  );

  writeFileSync(
    preloadPath,
    `import fs from "node:fs";
import { sep } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const realRenameSync = fs.renameSync;
const realMkdirSync = fs.mkdirSync;
fs.mkdirSync = function mkdirSync(path, options) {
  if (
    process.env.CLEAN_VERIFY_FAIL_STAGING_MKDIR_SUFFIX !== undefined &&
    String(path).endsWith(process.env.CLEAN_VERIFY_FAIL_STAGING_MKDIR_SUFFIX)
  ) {
    const error = new Error("synthetic staging preparation failure");
    error.code = "EIO";
    throw error;
  }
  return realMkdirSync(path, options);
};
fs.renameSync = function renameSync(source, destination) {
  if (
    process.env.CLEAN_VERIFY_FAIL_BACKUP_SOURCE !== undefined &&
    String(source).endsWith(process.env.CLEAN_VERIFY_FAIL_BACKUP_SOURCE) &&
    String(destination).includes(\`${"${sep}"}original${"${sep}"}\`)
  ) {
    const error = new Error("synthetic partial backup failure");
    error.code = "EIO";
    throw error;
  }
  return realRenameSync(source, destination);
};
syncBuiltinESMExports();
`,
    "utf8"
  );

  const fakePnpmPath = join(binDirectory, "pnpm");
  writeFileSync(
    fakePnpmPath,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const command = process.argv[2] ?? "missing";
const stagingRoot = join(process.cwd(), "${stagingDirectoryName}");
const runs = readdirSync(stagingRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
  .map((entry) => join(stagingRoot, entry.name));
appendFileSync(process.env.CLEAN_VERIFY_COMMAND_LOG, \`${"${command}"}:${"${runs.join(\"|\")}"}\\n\`);
if (runs.length !== 1) process.exit(86);
if (process.env.CLEAN_VERIFY_FAIL_COMMAND === command) process.exit(23);

function generate(relativePath) {
  const dist = join(process.cwd(), relativePath, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "generated.txt"), \`${"${command}"}\\n\`);
}

if (command === "prepare") {
  generate("packages/core");
  generate("packages/installer");
}
if (command === "test") generate("packages/test-support");
`,
    "utf8"
  );
  chmodSync(fakePnpmPath, 0o755);

  return {
    root,
    externalTemporaryDirectory,
    commandLogPath,
    preloadPath,
    verifierPath
  };
}

function distSnapshot(root: string): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const relativePath of [
    "packages/core/dist",
    "packages/installer/dist",
    "packages/test-support/dist"
  ]) {
    const pending = [join(root, relativePath)];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined || !existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        if (entry.isFile()) {
          snapshot[relative(root, path)] = createHash("sha256")
            .update(readFileSync(path))
            .digest("hex");
        }
      }
    }
  }
  return snapshot;
}

function runVerifier(
  fixture: Fixture,
  options: Readonly<{
    failBackupPath?: string;
    failCommand?: string;
    failStagingMkdirSuffix?: string;
  }> = {}
): VerificationResult {
  const result = spawnSync(
    process.execPath,
    ["--import", fixture.preloadPath, fixture.verifierPath],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        CLEAN_VERIFY_COMMAND_LOG: fixture.commandLogPath,
        CLEAN_VERIFY_FAIL_BACKUP_SOURCE: options.failBackupPath,
        CLEAN_VERIFY_FAIL_COMMAND: options.failCommand,
        CLEAN_VERIFY_FAIL_STAGING_MKDIR_SUFFIX: options.failStagingMkdirSuffix,
        PATH: `${join(fixture.root, "test-support", "bin")}${delimiter}${process.env.PATH ?? ""}`,
        TMPDIR: fixture.externalTemporaryDirectory
      }
    }
  );
  const commands = existsSync(fixture.commandLogPath)
    ? readFileSync(fixture.commandLogPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { status: result.status, stderr: result.stderr, commands };
}

function expectOnlySiblingRemains(fixture: Fixture): void {
  expect(
    readdirSync(join(fixture.root, stagingDirectoryName), { recursive: true }).sort()
  ).toEqual(["user-sibling", join("user-sibling", "keep.txt")].sort());
  expect(readFileSync(
    join(fixture.root, stagingDirectoryName, "user-sibling", "keep.txt"),
    "utf8"
  )).toBe("do-not-delete\n");
  expect(readFileSync(
    join(fixture.externalTemporaryDirectory, "user-file.txt"),
    "utf8"
  )).toBe("do-not-delete\n");
}

function removeFixture(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(fixture.externalTemporaryDirectory, { recursive: true, force: true });
}

describe("clean workspace verifier dist preservation", () => {
  it("cleans only its run directory when staging preparation fails", () => {
    // Break caught: an error after mkdtemp can leak a verifier-owned run beside user files.
    const fixture = createFixture();
    const original = distSnapshot(fixture.root);
    try {
      const result = runVerifier(fixture, {
        failStagingMkdirSuffix: "generated"
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("synthetic staging preparation failure");
      expect(result.commands).toEqual([]);
      expect(distSnapshot(fixture.root)).toEqual(original);
      expectOnlySiblingRemains(fixture);
    } finally {
      removeFixture(fixture);
    }
  });

  it("restores every original dist without running commands after a partial backup failure", () => {
    // Break caught: cleanup can delete an original dist that backup preparation never moved.
    const fixture = createFixture();
    const original = distSnapshot(fixture.root);
    try {
      const result = runVerifier(fixture, {
        failBackupPath: join("packages", "installer", "dist")
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("synthetic partial backup failure");
      expect(result.commands).toEqual([]);
      expect(distSnapshot(fixture.root)).toEqual(original);
      expectOnlySiblingRemains(fixture);
    } finally {
      removeFixture(fixture);
    }
  });

  it("restores every original dist after successful verification", () => {
    // Break caught: successful verification can replace original dist files with generated output.
    const fixture = createFixture();
    const original = distSnapshot(fixture.root);
    try {
      const result = runVerifier(fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(result.commands.map((entry) => entry.split(":", 1)[0])).toEqual([
        "prepare",
        "typecheck",
        "test"
      ]);
      expect(result.commands.every((entry) => entry.includes(fixture.root))).toBe(true);
      expect(distSnapshot(fixture.root)).toEqual(original);
      expectOnlySiblingRemains(fixture);
    } finally {
      removeFixture(fixture);
    }
  });

  it("restores every original dist after a verification command fails", () => {
    // Break caught: command failure cleanup can discard an original dist or retain generated output.
    const fixture = createFixture();
    const original = distSnapshot(fixture.root);
    try {
      const result = runVerifier(fixture, { failCommand: "typecheck" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("failed with exit code 23");
      expect(result.commands.map((entry) => entry.split(":", 1)[0])).toEqual([
        "prepare",
        "typecheck"
      ]);
      expect(distSnapshot(fixture.root)).toEqual(original);
      expectOnlySiblingRemains(fixture);
    } finally {
      removeFixture(fixture);
    }
  });

  it("keeps verifier staging inside the repository's ignored boundary", () => {
    // Break caught: a future staging path can cross filesystems or become visible to git.
    expect(() => execFileSync(
      "git",
      ["check-ignore", "--quiet", "--no-index", `${stagingDirectoryName}/run-probe/original`],
      { cwd: repositoryRoot, stdio: "ignore" }
    )).not.toThrow();
  });
});
