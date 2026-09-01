import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const packagesDirectory = join(workspaceRoot, "packages");
const backupDirectory = mkdtempSync(join(tmpdir(), "orca-hq-dist-backup-"));
const originalOutputsDirectory = join(backupDirectory, "original");
const generatedOutputsDirectory = join(backupDirectory, "generated");
mkdirSync(originalOutputsDirectory);
mkdirSync(generatedOutputsDirectory);
const packageNames = readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(packagesDirectory, name, "package.json")));
const movedOutputs = [];

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

function assertNoPackageDist() {
  const generatedOutput = packageNames.find((packageName) =>
    existsSync(join(packagesDirectory, packageName, "dist"))
  );
  if (generatedOutput !== undefined) {
    throw new Error(`packages/${generatedOutput}/dist was generated during clean verification`);
  }
}

let verificationError;
let restorationError;

try {
  for (const packageName of packageNames) {
    const outputPath = join(packagesDirectory, packageName, "dist");
    if (!existsSync(outputPath)) continue;

    const backupPath = join(originalOutputsDirectory, packageName);
    renameSync(outputPath, backupPath);
    movedOutputs.push({ outputPath, backupPath });
  }

  assertNoPackageDist();
  run("pnpm", ["test"]);
  assertNoPackageDist();
  run("pnpm", ["typecheck"]);
  assertNoPackageDist();
} catch (error) {
  verificationError = error;
} finally {
  try {
    for (const packageName of packageNames) {
      const outputPath = join(packagesDirectory, packageName, "dist");
      if (existsSync(outputPath)) {
        renameSync(outputPath, join(generatedOutputsDirectory, packageName));
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
