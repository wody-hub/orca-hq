import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const backupDirectory = mkdtempSync(join(tmpdir(), "orca-hq-dist-backup-"));
const originalOutputsDirectory = join(backupDirectory, "original");
const generatedOutputsDirectory = join(backupDirectory, "generated");
mkdirSync(originalOutputsDirectory);
mkdirSync(generatedOutputsDirectory);
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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
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
let restorationError;

try {
  for (const { relativePath, outputPath } of workspaceDirectories) {
    if (!existsSync(outputPath)) continue;

    const backupPath = join(originalOutputsDirectory, relativePath);
    mkdirSync(dirname(backupPath), { recursive: true });
    renameSync(outputPath, backupPath);
    movedOutputs.push({ outputPath, backupPath });
  }

  assertNoWorkspaceDist();
  run("pnpm", ["prepare"]);
  assertExactWorkspaceDist(prepareOutputs, "clean prepare");
  run("pnpm", ["typecheck"]);
  assertExactWorkspaceDist(prepareOutputs, "clean typecheck");
  run("pnpm", ["test"]);
  assertExactWorkspaceDist(testOutputs, "clean test");
} catch (error) {
  verificationError = error;
} finally {
  try {
    for (const { relativePath, outputPath } of workspaceDirectories) {
      if (existsSync(outputPath)) {
        const generatedPath = join(generatedOutputsDirectory, relativePath);
        mkdirSync(dirname(generatedPath), { recursive: true });
        renameSync(outputPath, generatedPath);
      }
    }
    for (const { outputPath, backupPath } of movedOutputs) {
      renameSync(backupPath, outputPath);
    }
    rmSync(backupDirectory, { recursive: true });
  } catch (error) {
    restorationError = error;
  }
}

if (restorationError !== undefined) {
  throw new AggregateError(
    verificationError === undefined ? [restorationError] : [verificationError, restorationError],
    `clean-workspace verification could not restore dist outputs; backup retained at ${backupDirectory}`
  );
}
if (verificationError !== undefined) {
  throw verificationError;
}
