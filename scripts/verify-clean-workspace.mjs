import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceDirectories = ["packages", "apps"].flatMap((parentName) => {
  const parentDirectory = join(workspaceRoot, parentName);
  return readdirSync(parentDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const relativePath = join(parentName, entry.name);
      const manifestPath = join(workspaceRoot, relativePath, "package.json");
      if (!existsSync(manifestPath)) return undefined;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof manifest.name !== "string") {
        throw new Error(`${relativePath}/package.json has no package name`);
      }
      return {
        relativePath,
        outputPath: join(parentDirectory, entry.name, "dist"),
        packageName: manifest.name,
        dependencyNames: Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.optionalDependencies
        })
      };
    })
    .filter((entry) => entry !== undefined);
});
const movedOutputs = [];
const prepareOutputs = new Set([
  join("packages", "core"),
  join("packages", "installer")
]);
const workspacesByPackageName = new Map(
  workspaceDirectories.map((workspace) => [workspace.packageName, workspace])
);

function workspaceDependencyOutputs(rootPackageName) {
  const outputs = new Set();
  const pending = [rootPackageName];
  while (pending.length > 0) {
    const packageName = pending.pop();
    if (packageName === undefined) continue;
    const workspace = workspacesByPackageName.get(packageName);
    if (workspace === undefined) {
      if (packageName === rootPackageName) {
        throw new Error(`Missing workspace package ${rootPackageName}`);
      }
      continue;
    }
    if (outputs.has(workspace.relativePath)) continue;
    outputs.add(workspace.relativePath);
    pending.push(...workspace.dependencyNames);
  }
  return outputs;
}

const testOutputs = new Set([
  ...prepareOutputs,
  ...workspaceDependencyOutputs("@orca-hq/test-support")
]);

const stagingRoot = join(workspaceRoot, ".clean-workspace-staging");
const lockDirectory = join(stagingRoot, "active.lock");
const signalExitCodes = new Map([
  ["SIGINT", 130],
  ["SIGTERM", 143]
]);

class VerificationSignalError extends Error {
  constructor(signal) {
    super(`clean-workspace verification interrupted by ${signal}`);
    this.name = "VerificationSignalError";
    this.signal = signal;
  }
}

let activeChild;
let receivedSignal;

function handleSignal(signal) {
  receivedSignal ??= signal;
  if (activeChild !== undefined) {
    activeChild.kill(signal);
  }
}

const handleSigint = () => handleSignal("SIGINT");
const handleSigterm = () => handleSignal("SIGTERM");
process.on("SIGINT", handleSigint);
process.on("SIGTERM", handleSigterm);

async function run(command, args) {
  if (receivedSignal !== undefined) {
    throw new VerificationSignalError(receivedSignal);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: "inherit"
    });
    activeChild = child;
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      activeChild = undefined;
      callback();
    };
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (status, signal) => settle(() => {
      if (receivedSignal !== undefined) {
        reject(new VerificationSignalError(receivedSignal));
        return;
      }
      if (status !== 0) {
        const outcome = signal === null ? `exit code ${status}` : `signal ${signal}`;
        reject(new Error(`${command} ${args.join(" ")} failed with ${outcome}`));
        return;
      }
      resolve();
    }));
  });
}

function assertNoWorkspaceDist() {
  const generatedOutput = workspaceDirectories.find(({ outputPath }) => existsSync(outputPath));
  if (generatedOutput !== undefined) {
    throw new Error(`${generatedOutput.relativePath}/dist existed before clean prepare`);
  }
}

function assertExactWorkspaceDist(expectedOutputs, phase) {
  const unexpectedOutput = workspaceDirectories.find(
    ({ relativePath, outputPath }) => existsSync(outputPath) && !expectedOutputs.has(relativePath)
  );
  if (unexpectedOutput !== undefined) {
    throw new Error(`${unexpectedOutput.relativePath}/dist was generated during ${phase}`);
  }
  for (const relativePath of expectedOutputs) {
    if (!existsSync(join(workspaceRoot, relativePath, "dist"))) {
      throw new Error(`${relativePath}/dist was not generated during ${phase}`);
    }
  }
}

let verificationError;
const restorationErrors = [];
let backupComplete = false;
let backupDirectory;
let originalOutputsDirectory;
let generatedOutputsDirectory;
let lockAcquired = false;

try {
  mkdirSync(stagingRoot, { recursive: true });
  try {
    mkdirSync(lockDirectory);
    lockAcquired = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    throw new Error(
      `clean-workspace verifier lock exists at ${lockDirectory}; ` +
      "another verifier may be active or a previous run may have crashed; " +
      "manual review is required before retrying"
    );
  }

  const staleRuns = readdirSync(stagingRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
    .map((entry) => join(stagingRoot, entry.name));
  if (staleRuns.length > 0) {
    throw new Error(
      `clean-workspace staging contains stale run data at ${staleRuns.join(", ")}; ` +
      "manual review is required before retrying"
    );
  }

  backupDirectory = mkdtempSync(join(stagingRoot, "run-"));
  originalOutputsDirectory = join(backupDirectory, "original");
  generatedOutputsDirectory = join(backupDirectory, "generated");
  mkdirSync(originalOutputsDirectory);
  mkdirSync(generatedOutputsDirectory);

  for (const { relativePath, outputPath } of workspaceDirectories) {
    if (!existsSync(outputPath)) continue;

    const backupPath = join(originalOutputsDirectory, relativePath);
    mkdirSync(dirname(backupPath), { recursive: true });
    renameSync(outputPath, backupPath);
    movedOutputs.push({ outputPath, backupPath });
  }

  backupComplete = true;
  assertNoWorkspaceDist();
  await run("pnpm", ["prepare"]);
  assertExactWorkspaceDist(prepareOutputs, "clean prepare");
  await run("pnpm", ["typecheck"]);
  assertExactWorkspaceDist(prepareOutputs, "clean typecheck");
  await run("pnpm", ["test"]);
  assertExactWorkspaceDist(testOutputs, "clean test");
} catch (error) {
  verificationError = error;
} finally {
  if (backupComplete && generatedOutputsDirectory !== undefined) {
    for (const { relativePath, outputPath } of workspaceDirectories) {
      if (!existsSync(outputPath)) continue;
      const generatedPath = join(generatedOutputsDirectory, relativePath);
      try {
        mkdirSync(dirname(generatedPath), { recursive: true });
        renameSync(outputPath, generatedPath);
      } catch (error) {
        restorationErrors.push(error);
      }
    }
  }
  for (const { outputPath, backupPath } of movedOutputs) {
    if (existsSync(outputPath)) {
      restorationErrors.push(
        new Error(`Refusing to overwrite ${outputPath} while restoring its original dist`)
      );
      continue;
    }
    try {
      renameSync(backupPath, outputPath);
    } catch (error) {
      restorationErrors.push(error);
    }
  }
  if (restorationErrors.length === 0 && backupDirectory !== undefined) {
    try {
      rmSync(backupDirectory, { recursive: true });
    } catch (error) {
      restorationErrors.push(error);
    }
  }
  if (lockAcquired) {
    try {
      rmdirSync(lockDirectory);
      lockAcquired = false;
    } catch (error) {
      restorationErrors.push(error);
    }
  }
}

process.off("SIGINT", handleSigint);
process.off("SIGTERM", handleSigterm);

if (restorationErrors.length > 0) {
  const recoveryLocations = [];
  if (backupDirectory !== undefined && existsSync(backupDirectory)) {
    recoveryLocations.push(`backup retained at ${backupDirectory}`);
  }
  if (existsSync(lockDirectory)) {
    recoveryLocations.push(`lock retained at ${lockDirectory}`);
  }
  const retentionLocation = recoveryLocations.length === 0
    ? "no recovery directory was created"
    : recoveryLocations.join("; ");
  if (receivedSignal !== undefined) {
    process.exitCode = signalExitCodes.get(receivedSignal);
  }
  throw new AggregateError(
    verificationError === undefined
      ? restorationErrors
      : [verificationError, ...restorationErrors],
    `clean-workspace verification could not restore dist outputs; ${retentionLocation}`
  );
}
if (receivedSignal !== undefined) {
  console.error(`clean-workspace verification interrupted by ${receivedSignal} after cleanup`);
  process.exitCode = signalExitCodes.get(receivedSignal);
} else if (verificationError !== undefined) {
  throw verificationError;
}
