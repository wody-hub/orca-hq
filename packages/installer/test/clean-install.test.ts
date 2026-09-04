import { execFile } from "node:child_process";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function cleanPath(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => !entry.includes(`${sep}node_modules${sep}.bin`))
    .join(delimiter);
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  command: string,
  arguments_: readonly string[],
  options: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv }>
): Promise<ProcessResult> {
  return await new Promise((resolvePromise, reject) => {
    execFile(command, [...arguments_], options, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolvePromise({ exitCode: error === null ? 0 : error.code, stdout, stderr });
    });
  });
}

async function writeCommand(directory: string, name: string): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}

async function createCleanWorkspace(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "orca-hq-clean-install-"));
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"]) {
    await copyFile(join(repositoryRoot, name), join(fixture, name));
  }

  const installerRoot = join(repositoryRoot, "packages", "installer");
  await cp(installerRoot, join(fixture, "packages", "installer"), {
    recursive: true,
    filter(source) {
      const firstSegment = relative(installerRoot, source).split(sep)[0];
      return firstSegment !== "dist" && firstSegment !== "node_modules" && firstSegment !== "test";
    }
  });
  const coreRoot = join(repositoryRoot, "packages", "core");
  await cp(coreRoot, join(fixture, "packages", "core"), {
    recursive: true,
    filter(source) {
      const firstSegment = relative(coreRoot, source).split(sep)[0];
      return firstSegment !== "dist" && firstSegment !== "node_modules" && firstSegment !== "test";
    }
  });
  return fixture;
}

async function createIsolatedHost(fixture: string): Promise<NodeJS.ProcessEnv> {
  const home = join(fixture, "host", "home");
  const configHome = join(home, ".config");
  const bin = join(fixture, "host", "bin");
  const configPath = join(configHome, "orca-hq", "pilot.json");
  const registryPath = join(fixture, "host", "projects.yaml");
  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    schema: "orca-hq.private-pilot.v1",
    databasePath: join(home, "Library/Application Support/orca-hq/control.sqlite"),
    projectRegistryPath: registryPath,
    credentialAccounts: [
      "slack-app-token",
      "slack-channel-id",
      "telegram-bot-token",
      "telegram-allowed-chat-id",
      "openai-api-key"
    ]
  }), "utf8");
  await writeFile(registryPath, "projects:\n  - one\n  - two\n  - three\n  - four\n  - five\n", "utf8");
  for (const name of ["orca", "codex", "claude", "tailscale", "security", "launchctl"]) {
    await writeCommand(bin, name);
  }
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    PATH: `${bin}${delimiter}${cleanPath()}`
  };
}

it("runs exact pnpm hq after the first offline install of a clean source workspace", async () => {
  // Break caught: if the package bin points at a generated dist file, pnpm skips the first-install shim before prepare builds it.
  const fixture = await createCleanWorkspace();
  try {
    await expect(access(join(fixture, "packages", "installer", "dist"))).rejects.toThrow();

    const store = await run("pnpm", ["store", "path"], { cwd: repositoryRoot });
    expect(store.exitCode, store.stderr).toBe(0);
    const installHome = join(fixture, "install-home");
    await mkdir(installHome, { recursive: true });
    const install = await run("pnpm", [
      "install",
      "--offline",
      "--frozen-lockfile",
      "--store-dir",
      store.stdout.trim()
    ], {
      cwd: fixture,
      env: {
        ...process.env,
        CI: "true",
        HOME: installHome,
        XDG_CONFIG_HOME: join(installHome, ".config"),
        NPM_CONFIG_USERCONFIG: join(installHome, ".npmrc"),
        PATH: cleanPath()
      }
    });
    expect(install.exitCode, `${install.stdout}\n${install.stderr}`).toBe(0);

    const result = await run("pnpm", ["hq", "doctor", "--format", "json"], {
      cwd: fixture,
      env: await createIsolatedHost(fixture)
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
    expect(result.stderr).toBe("");
    await expect(access(join(fixture, "node_modules", ".bin", "hq"))).resolves.toBeUndefined();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 120_000);
