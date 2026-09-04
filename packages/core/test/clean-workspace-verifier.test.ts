import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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

interface RunningVerification {
  readonly pid: number;
  readonly completion: Promise<VerificationResult>;
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orca-hq-clean-verifier-workspace-")));
  const externalTemporaryDirectory = realpathSync(mkdtempSync(
    join(tmpdir(), "orca-hq-clean-verifier-external-")
  ));
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
const realRmdirSync = fs.rmdirSync;
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
  if (process.env.CLEAN_VERIFY_RENAME_LOG !== undefined) {
    fs.appendFileSync(
      process.env.CLEAN_VERIFY_RENAME_LOG,
      \`${"${String(source)}"}->${"${String(destination)}"}\\n\`
    );
  }
  if (
    process.env.CLEAN_VERIFY_FAIL_BACKUP_SOURCE !== undefined &&
    String(source).endsWith(process.env.CLEAN_VERIFY_FAIL_BACKUP_SOURCE) &&
    String(destination).includes(\`${"${sep}"}original${"${sep}"}\`)
  ) {
    const error = new Error("synthetic partial backup failure");
    error.code = "EIO";
    throw error;
  }
  if (
    process.env.CLEAN_VERIFY_FAIL_GENERATED_SOURCE !== undefined &&
    String(source).endsWith(process.env.CLEAN_VERIFY_FAIL_GENERATED_SOURCE) &&
    String(destination).includes(\`${"${sep}"}generated${"${sep}"}\`)
  ) {
    const error = new Error("synthetic generated sweep failure");
    error.code = "EIO";
    throw error;
  }
  if (
    process.env.CLEAN_VERIFY_FAIL_RESTORE_DESTINATION !== undefined &&
    String(source).includes(\`${"${sep}"}original${"${sep}"}\`) &&
    String(destination).endsWith(process.env.CLEAN_VERIFY_FAIL_RESTORE_DESTINATION)
  ) {
    const error = new Error("synthetic original restore failure");
    error.code = "EIO";
    throw error;
  }
  return realRenameSync(source, destination);
};
fs.rmdirSync = function rmdirSync(path, options) {
  if (
    process.env.CLEAN_VERIFY_FAIL_LOCK_CLEANUP_SUFFIX !== undefined &&
    String(path).endsWith(process.env.CLEAN_VERIFY_FAIL_LOCK_CLEANUP_SUFFIX)
  ) {
    const error = new Error("synthetic lock cleanup failure");
    error.code = "EIO";
    throw error;
  }
  return realRmdirSync(path, options);
};
syncBuiltinESMExports();
`,
    "utf8"
  );

  const fakePnpmPath = join(binDirectory, "pnpm");
  writeFileSync(
    fakePnpmPath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
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
if (process.env.CLEAN_VERIFY_GRANDCHILD_COMMAND === command) {
  spawn(
    process.execPath,
    [
      "-e",
      \`const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
writeFileSync(process.env.CLEAN_VERIFY_GRANDCHILD_READY_PATH, "ready\\\\n", "utf8");
setTimeout(() => {
  mkdirSync(dirname(process.env.CLEAN_VERIFY_LATE_WRITE_PATH), { recursive: true });
  writeFileSync(process.env.CLEAN_VERIFY_LATE_WRITE_PATH, "late-grandchild\\\\n", "utf8");
}, Number(process.env.CLEAN_VERIFY_LATE_WRITE_DELAY_MS));\`
    ],
    { env: process.env, stdio: "inherit" }
  );
}
if (process.env.CLEAN_VERIFY_HOLD_COMMAND === command) {
  writeFileSync(process.env.CLEAN_VERIFY_READY_PATH, "ready\\n", "utf8");
  while (!existsSync(process.env.CLEAN_VERIFY_RELEASE_PATH)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
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
    failGeneratedPath?: string;
    failLockCleanup?: boolean;
    failRestorePath?: string;
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
        CLEAN_VERIFY_FAIL_GENERATED_SOURCE: options.failGeneratedPath,
        CLEAN_VERIFY_FAIL_LOCK_CLEANUP_SUFFIX: options.failLockCleanup
          ? join(stagingDirectoryName, "active.lock")
          : undefined,
        CLEAN_VERIFY_FAIL_RESTORE_DESTINATION: options.failRestorePath,
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

function startVerifier(
  fixture: Fixture,
  options: Readonly<{
    commandLogPath?: string;
    holdCommand?: string;
    failRestorePath?: string;
    grandchildCommand?: string;
    grandchildReadyPath?: string;
    lateWriteDelayMs?: number;
    lateWritePath?: string;
    readyPath?: string;
    releasePath?: string;
    renameLogPath?: string;
  }> = {}
): RunningVerification {
  const commandLogPath = options.commandLogPath ?? fixture.commandLogPath;
  const child = spawn(
    process.execPath,
    ["--import", fixture.preloadPath, fixture.verifierPath],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        CLEAN_VERIFY_COMMAND_LOG: commandLogPath,
        CLEAN_VERIFY_FAIL_RESTORE_DESTINATION: options.failRestorePath,
        CLEAN_VERIFY_GRANDCHILD_COMMAND: options.grandchildCommand,
        CLEAN_VERIFY_GRANDCHILD_READY_PATH: options.grandchildReadyPath,
        CLEAN_VERIFY_HOLD_COMMAND: options.holdCommand,
        CLEAN_VERIFY_LATE_WRITE_DELAY_MS: options.lateWriteDelayMs?.toString(),
        CLEAN_VERIFY_LATE_WRITE_PATH: options.lateWritePath,
        CLEAN_VERIFY_READY_PATH: options.readyPath,
        CLEAN_VERIFY_RELEASE_PATH: options.releasePath,
        CLEAN_VERIFY_RENAME_LOG: options.renameLogPath,
        PATH: `${join(fixture.root, "test-support", "bin")}${delimiter}${process.env.PATH ?? ""}`,
        TMPDIR: fixture.externalTemporaryDirectory
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  if (child.pid === undefined) throw new Error("verifier subprocess has no pid");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<VerificationResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      const commands = existsSync(commandLogPath)
        ? readFileSync(commandLogPath, "utf8").trim().split("\n").filter(Boolean)
        : [];
      resolve({ status, stderr, commands });
    });
  });
  return { pid: child.pid, completion };
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function signalVerifier(pid: number, signal: "SIGINT" | "SIGTERM"): void {
  process.kill(process.platform === "win32" ? pid : -pid, signal);
}

function retainedRuns(fixture: Fixture): string[] {
  return readdirSync(join(fixture.root, stagingDirectoryName), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
    .map((entry) => join(fixture.root, stagingDirectoryName, entry.name));
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

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143]
  ] as const)("restores every original dist after %s", async (signal, expectedStatus) => {
    // Break caught: a handled termination signal can strand originals in staging.
    const fixture = createFixture();
    const original = distSnapshot(fixture.root);
    const readyPath = join(fixture.root, "test-support", "ready");
    const releasePath = join(fixture.root, "test-support", "release");
    const running = startVerifier(fixture, {
      holdCommand: "prepare",
      readyPath,
      releasePath
    });
    try {
      await waitForPath(readyPath);
      signalVerifier(running.pid, signal);
      const result = await running.completion;

      expect(result.status, result.stderr).toBe(expectedStatus);
      expect(result.commands.map((entry) => entry.split(":", 1)[0])).toEqual(["prepare"]);
      expect(distSnapshot(fixture.root)).toEqual(original);
      expectOnlySiblingRemains(fixture);
    } finally {
      if (existsSync(fixture.root)) writeFileSync(releasePath, "release\n", "utf8");
      await running.completion;
      removeFixture(fixture);
    }
  });

  it("rejects a concurrent verifier before it moves or generates any dist", async () => {
    // Break caught: an overlapping verifier can mistake the active run's output for originals.
    const fixture = createFixture();
    const original = distSnapshot(fixture.root);
    const readyPath = join(fixture.root, "test-support", "ready");
    const releasePath = join(fixture.root, "test-support", "release");
    const secondCommandLogPath = join(fixture.root, "test-support", "commands-second.log");
    const secondRenameLogPath = join(fixture.root, "test-support", "renames-second.log");
    const first = startVerifier(fixture, {
      holdCommand: "prepare",
      readyPath,
      releasePath
    });
    try {
      await waitForPath(readyPath);
      const activeOutput = distSnapshot(fixture.root);
      const second = startVerifier(fixture, {
        commandLogPath: secondCommandLogPath,
        renameLogPath: secondRenameLogPath
      });
      const secondResult = await second.completion;
      const activeRun = retainedRuns(fixture)[0];

      expect(secondResult.status).not.toBe(0);
      expect(secondResult.stderr).toContain(
        join(fixture.root, stagingDirectoryName, "active.lock")
      );
      expect(secondResult.stderr).toContain("manual review");
      expect(secondResult.stderr).toContain("do not remove the lock until");
      expect(activeRun).toBeDefined();
      if (activeRun === undefined) throw new Error("expected one active verifier run");
      expect(secondResult.stderr).toContain(join(activeRun, "original"));
      expect(secondResult.commands).toEqual([]);
      expect(existsSync(secondRenameLogPath)).toBe(false);
      expect(existsSync(join(fixture.root, stagingDirectoryName, "active.lock"))).toBe(true);
      expect(distSnapshot(fixture.root)).toEqual(activeOutput);

      writeFileSync(releasePath, "release\n", "utf8");
      const firstResult = await first.completion;
      expect(firstResult.status, firstResult.stderr).toBe(0);
      expect(distSnapshot(fixture.root)).toEqual(original);
      expectOnlySiblingRemains(fixture);
    } finally {
      if (existsSync(fixture.root)) writeFileSync(releasePath, "release\n", "utf8");
      await first.completion;
      removeFixture(fixture);
    }
  });

  it("fails closed on an active lock without touching workspace outputs", () => {
    // Break caught: a post-crash lock can be ignored and the next run can move originals.
    const fixture = createFixture();
    const original = distSnapshot(fixture.root);
    const lockPath = join(fixture.root, stagingDirectoryName, "active.lock");
    const recoveryPath = join(
      fixture.root,
      stagingDirectoryName,
      "run-crashed",
      "original"
    );
    mkdirSync(lockPath);
    mkdirSync(recoveryPath, { recursive: true });
    writeFileSync(join(recoveryPath, "inspect-me.txt"), "retained\n", "utf8");
    try {
      const result = runVerifier(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(lockPath);
      expect(result.stderr).toContain(recoveryPath);
      expect(result.stderr).toContain("do not remove the lock until");
      expect(result.stderr).toContain("manual review");
      expect(result.commands).toEqual([]);
      expect(distSnapshot(fixture.root)).toEqual(original);
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(join(recoveryPath, "inspect-me.txt"), "utf8"))
        .toBe("retained\n");
    } finally {
      removeFixture(fixture);
    }
  });

  it("fails closed on a stale run and reports its exact recovery path", () => {
    // Break caught: crash debris can be guessed to be generated output and deleted automatically.
    const fixture = createFixture();
    const original = distSnapshot(fixture.root);
    const staleRunPath = join(fixture.root, stagingDirectoryName, "run-crashed");
    mkdirSync(join(staleRunPath, "original"), { recursive: true });
    writeFileSync(join(staleRunPath, "original", "inspect-me.txt"), "retained\n", "utf8");
    try {
      const result = runVerifier(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(staleRunPath);
      expect(result.stderr).toContain("manual review");
      expect(result.commands).toEqual([]);
      expect(distSnapshot(fixture.root)).toEqual(original);
      expect(readFileSync(join(staleRunPath, "original", "inspect-me.txt"), "utf8"))
        .toBe("retained\n");
      expect(existsSync(join(fixture.root, stagingDirectoryName, "active.lock"))).toBe(false);
    } finally {
      removeFixture(fixture);
    }
  });

  it("continues restoring other originals and retains recovery data after generated sweep fails", () => {
    // Break caught: one generated-output move failure can abort all remaining original restores.
    const fixture = createFixture();
    try {
      const result = runVerifier(fixture, {
        failGeneratedPath: join("packages", "core", "dist")
      });
      const runs = retainedRuns(fixture);
      const run = runs[0];

      expect(result.status).not.toBe(0);
      expect(runs).toHaveLength(1);
      expect(run).toBeDefined();
      if (run === undefined) throw new Error("expected one retained verifier run");
      expect(result.stderr).toContain(`backup retained at ${run}`);
      expect(readFileSync(join(fixture.root, "packages/core/dist/generated.txt"), "utf8"))
        .toBe("prepare\n");
      expect(readFileSync(join(run, "original/packages/core/marker.txt"), "utf8"))
        .toBe("original-core\n");
      expect(readFileSync(join(fixture.root, "packages/installer/dist/marker.txt"), "utf8"))
        .toBe("original-installer\n");
      expect(readFileSync(join(fixture.root, "packages/test-support/dist/marker.txt"), "utf8"))
        .toBe("original-test-support\n");
      expect(readFileSync(join(fixture.root, stagingDirectoryName, "user-sibling/keep.txt"), "utf8"))
        .toBe("do-not-delete\n");
    } finally {
      removeFixture(fixture);
    }
  });

  it("continues restoring other originals and retains a backup after one restore fails", () => {
    // Break caught: one original restore error can prevent later originals from being restored.
    const fixture = createFixture();
    try {
      const result = runVerifier(fixture, {
        failRestorePath: join("packages", "core", "dist")
      });
      const runs = retainedRuns(fixture);
      const run = runs[0];

      expect(result.status).not.toBe(0);
      expect(runs).toHaveLength(1);
      expect(run).toBeDefined();
      if (run === undefined) throw new Error("expected one retained verifier run");
      expect(result.stderr).toContain(`backup retained at ${run}`);
      expect(existsSync(join(fixture.root, "packages/core/dist"))).toBe(false);
      expect(readFileSync(join(run, "original/packages/core/marker.txt"), "utf8"))
        .toBe("original-core\n");
      expect(readFileSync(join(fixture.root, "packages/installer/dist/marker.txt"), "utf8"))
        .toBe("original-installer\n");
      expect(readFileSync(join(fixture.root, "packages/test-support/dist/marker.txt"), "utf8"))
        .toBe("original-test-support\n");
      expect(readFileSync(join(fixture.root, stagingDirectoryName, "user-sibling/keep.txt"), "utf8"))
        .toBe("do-not-delete\n");
    } finally {
      removeFixture(fixture);
    }
  });

  it("uses exit 1 and retains recovery data when SIGTERM cleanup cannot restore", async () => {
    // Break caught: a signal exit code can misrepresent a higher-priority recovery failure.
    const fixture = createFixture();
    const readyPath = join(fixture.root, "test-support", "ready");
    const releasePath = join(fixture.root, "test-support", "release");
    const running = startVerifier(fixture, {
      failRestorePath: join("packages", "core", "dist"),
      holdCommand: "prepare",
      readyPath,
      releasePath
    });
    try {
      await waitForPath(readyPath);
      signalVerifier(running.pid, "SIGTERM");
      const result = await running.completion;
      const run = retainedRuns(fixture)[0];

      expect(result.status).toBe(1);
      expect(run).toBeDefined();
      if (run === undefined) throw new Error("expected one retained verifier run");
      expect(result.stderr).toContain("AggregateError");
      expect(result.stderr).toContain("interrupted by SIGTERM");
      expect(result.stderr).toContain("recovery failure takes precedence with exit code 1");
      expect(result.stderr).toContain(`backup retained at ${run}`);
      expect(readFileSync(join(run, "original/packages/core/marker.txt"), "utf8"))
        .toBe("original-core\n");
    } finally {
      if (existsSync(fixture.root)) writeFileSync(releasePath, "release\n", "utf8");
      await running.completion;
      removeFixture(fixture);
    }
  });

  it("classifies an isolated active lock cleanup failure without misreporting restore", () => {
    // Break caught: rmdir(active.lock) failure can be mislabeled as a dist restoration failure.
    const fixture = createFixture();
    const original = distSnapshot(fixture.root);
    const lockPath = join(fixture.root, stagingDirectoryName, "active.lock");
    try {
      const result = runVerifier(fixture, { failLockCleanup: true });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("synthetic lock cleanup failure");
      expect(result.stderr).toContain("could not clean up verifier lock");
      expect(result.stderr).not.toContain("could not restore dist outputs");
      expect(result.stderr).toContain(`lock retained at ${lockPath}`);
      expect(distSnapshot(fixture.root)).toEqual(original);
      expect(retainedRuns(fixture)).toEqual([]);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      removeFixture(fixture);
    }
  });

  it.runIf(process.platform !== "win32")(
    "terminates a pnpm grandchild before restoring after parent-only SIGTERM",
    async () => {
      // Break caught: signaling only pnpm can leave an orphan that writes into restored dist.
      const fixture = createFixture();
      const original = distSnapshot(fixture.root);
      const readyPath = join(fixture.root, "test-support", "ready");
      const releasePath = join(fixture.root, "test-support", "release");
      const grandchildReadyPath = join(fixture.root, "test-support", "grandchild-ready");
      const lateWritePath = join(fixture.root, "packages", "core", "dist", "late.txt");
      const running = startVerifier(fixture, {
        grandchildCommand: "prepare",
        grandchildReadyPath,
        holdCommand: "prepare",
        lateWriteDelayMs: 400,
        lateWritePath,
        readyPath,
        releasePath
      });
      try {
        await waitForPath(readyPath);
        await waitForPath(grandchildReadyPath);
        process.kill(running.pid, "SIGTERM");
        const result = await running.completion;
        await new Promise((resolve) => setTimeout(resolve, 650));

        expect(result.status, result.stderr).toBe(143);
        expect(result.commands.map((entry) => entry.split(":", 1)[0])).toEqual(["prepare"]);
        expect(existsSync(lateWritePath)).toBe(false);
        expect(distSnapshot(fixture.root)).toEqual(original);
        expectOnlySiblingRemains(fixture);
      } finally {
        if (existsSync(fixture.root)) writeFileSync(releasePath, "release\n", "utf8");
        await running.completion;
        removeFixture(fixture);
      }
    }
  );

  it("keeps verifier staging inside the repository's ignored boundary", () => {
    // Break caught: a future staging path can cross filesystems or become visible to git.
    expect(() => execFileSync(
      "git",
      ["check-ignore", "--quiet", "--no-index", `${stagingDirectoryName}/run-probe/original`],
      { cwd: repositoryRoot, stdio: "ignore" }
    )).not.toThrow();
  });
});
