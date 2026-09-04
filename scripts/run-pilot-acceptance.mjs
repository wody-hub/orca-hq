import { execFile } from "node:child_process";
import { lstat, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INVALID = "pilot_acceptance_invalid_arguments";
const BUILD_FAILED = "pilot_acceptance_build_failed";
const GATE_FAILED = "pilot_acceptance_gate_failed";
const repositoryRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const supportRoot = resolve(repositoryRoot, "packages/test-support");

function fail(message, exitCode) {
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
}

function parseArguments(argv) {
  let runs;
  let output;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== "--runs" && flag !== "--output") || value === undefined || seen.has(flag)) {
      throw new TypeError(INVALID);
    }
    seen.add(flag);
    if (flag === "--runs") runs = value;
    if (flag === "--output") output = value;
  }
  if (seen.size !== 2 || runs === undefined || output === undefined || !/^[1-9]\d*$/.test(runs)) {
    throw new TypeError(INVALID);
  }
  const parsedRuns = Number(runs);
  if (!Number.isSafeInteger(parsedRuns) || parsedRuns <= 0) throw new TypeError(INVALID);
  return { runs: parsedRuns, output };
}

async function boundedOutputPath(value) {
  if (!isAbsolute(value)) throw new TypeError(INVALID);
  const requestedPath = resolve(value);
  if (
    extname(requestedPath) !== ".json"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(basename(requestedPath))
  ) {
    throw new TypeError(INVALID);
  }
  const outputDirectory = await realpath(dirname(requestedPath));
  const relativeDirectory = relative(repositoryRoot, outputDirectory);
  if (
    relativeDirectory === ""
    || (relativeDirectory !== ".."
      && !relativeDirectory.startsWith(`..${sep}`)
      && !isAbsolute(relativeDirectory))
  ) {
    throw new TypeError(INVALID);
  }
  const outputPath = join(outputDirectory, basename(requestedPath));
  try {
    const existing = await lstat(outputPath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new TypeError(INVALID);
  } catch (error) {
    if (error instanceof TypeError || error?.code !== "ENOENT") throw error;
  }
  return outputPath;
}

async function harnessNeedsBuild() {
  try {
    const sourceDirectory = resolve(supportRoot, "src");
    const sourceFiles = (await readdir(sourceDirectory))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => resolve(sourceDirectory, name));
    const sourceTimes = await Promise.all(sourceFiles.map(async (path) => (await stat(path)).mtimeMs));
    const outputTimes = await Promise.all([
      resolve(supportRoot, "dist/index.js"),
      resolve(supportRoot, "dist/pilot-harness.js")
    ].map(async (path) => (await stat(path)).mtimeMs));
    return Math.max(...sourceTimes) > Math.min(...outputTimes);
  } catch {
    return true;
  }
}

let parsed;
let outputPath;
try {
  parsed = parseArguments(process.argv.slice(2));
  outputPath = await boundedOutputPath(parsed.output);
} catch {
  fail(INVALID, 2);
}

if (parsed !== undefined && outputPath !== undefined) {
  try {
    if (await harnessNeedsBuild()) {
      await execFileAsync("pnpm", ["--filter", "@orca-hq/test-support...", "build"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
    }
  } catch {
    fail(BUILD_FAILED, 1);
  }
}

if (process.exitCode === undefined && parsed !== undefined && outputPath !== undefined) {
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    const {
      pilotAcceptancePassesGate,
      runPilotAcceptance
    } = await import("../packages/test-support/dist/index.js");
    const report = await runPilotAcceptance({ runs: parsed.runs, runIdPrefix: "acceptance" });
    if (!pilotAcceptancePassesGate(report)) {
      fail(GATE_FAILED, 1);
    } else {
      await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await rename(temporaryPath, outputPath);
    }
  } catch {
    await rm(temporaryPath, { force: true });
    if (process.exitCode === undefined) fail(GATE_FAILED, 1);
  }
}
