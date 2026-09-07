import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { preservedCorepackHome } from "./corepack-home.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repositoryRoot, "packages", "installer", "dist", "cli.js");

async function writeCommand(directory: string, name: string, body = "exit 0"): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(command: string, arguments_: readonly string[], options: Readonly<{
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}> = {}): Promise<ProcessResult> {
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

async function createHostFixture(): Promise<Readonly<{
  fixture: string;
  env: NodeJS.ProcessEnv;
  registryPath: string;
  bin: string;
}>> {
  const fixture = await mkdtemp(join(tmpdir(), "orca-hq-cli-process-"));
  const home = join(fixture, "home");
  const configHome = join(home, ".config");
  const bin = join(fixture, "bin");
  const configPath = join(configHome, "orca-hq", "pilot.json");
  const registryPath = join(fixture, "projects.yaml");
  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    schema: "orca-hq.private-pilot.v1",
    databasePath: join(home, "Library/Application Support/orca-hq/control.sqlite"),
    projectRegistryPath: registryPath,
    credentialAccounts: ["slack-app-token", "slack-channel-id", "telegram-bot-token", "telegram-allowed-chat-id", "openai-api-key"]
  }), "utf8");
  await writeFile(registryPath, "projects:\n  - one\n  - two\n  - three\n  - four\n  - five\n", "utf8");
  for (const name of ["orca", "codex", "claude", "tailscale", "security", "launchctl"]) {
    await writeCommand(bin, name);
  }
  return {
    fixture,
    bin,
    registryPath,
    env: {
      ...process.env,
      COREPACK_HOME: preservedCorepackHome,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      PATH: `${bin}:${process.env.PATH ?? ""}`
    }
  };
}

async function runInteractiveSetup(
  env: NodeJS.ProcessEnv,
  answers: readonly string[],
  timeoutMs = 15_000
): Promise<ProcessResult & { readonly timedOut: boolean }> {
  const prompts = [
    "Legacy project Registry path (existing entries are preserved; Orca discovers projects automatically): ",
    "Slack app token (required on first install; leave blank during migration to keep the existing Keychain account): ",
    "Slack channel ID (required on first install; leave blank during migration to keep the existing Keychain account): ",
    "Telegram bot token (required on first install; leave blank during migration to keep the existing Keychain account): ",
    "Telegram allowlisted chat ID (required on first install; leave blank during migration to keep the existing Keychain account): ",
    "OpenAI API key (optional for voice; leave blank on first install for text-only mode, or during migration to keep existing voice settings): ",
    "Apply this setup? [y/N] "
  ];
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, "setup"], { cwd: repositoryRoot, env });
    let stdout = "";
    let stderr = "";
    let answerIndex = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      while (answerIndex < prompts.length && stdout.includes(prompts[answerIndex])) {
        child.stdin.write(`${answers[answerIndex] ?? ""}\n`);
        answerIndex += 1;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode: code ?? 128, stdout, stderr, timedOut });
    });
  });
}

beforeAll(async () => {
  const build = await run("pnpm", ["--filter", "@orca-hq/installer", "build"], { cwd: repositoryRoot });
  if (build.exitCode !== 0) throw new Error(`installer build failed: ${build.stderr}`);
}, 60_000);

describe("pnpm hq doctor process contract", () => {
  it("writes one parseable JSON document to stdout with a temporary, fully-probed host", async () => {
    // Break caught: package-manager lifecycle banners or diagnostics on stdout corrupt automation consuming `pnpm hq doctor --format json`.
    const host = await createHostFixture();

    try {
      const result = await run("pnpm", ["hq", "doctor", "--format", "json"], {
        cwd: repositoryRoot,
        env: host.env
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
      expect(result.stderr).toBe("");
    } finally {
      await rm(host.fixture, { recursive: true, force: true });
    }
  });

  it("keeps failed doctor stdout as one JSON document and preserves exit 1", async () => {
    // Break caught: nonzero doctor output must remain parseable without changing its intentional failure status.
    const host = await createHostFixture();
    await writeCommand(host.bin, "tailscale", "exit 1");
    try {
      const result = await run("pnpm", ["hq", "doctor", "--format", "json"], { cwd: repositoryRoot, env: host.env });

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
      expect(result.stderr).toBe("");
    } finally {
      await rm(host.fixture, { recursive: true, force: true });
    }
  });

  it("preserves usage exit 2 for invalid command and format", async () => {
    // Break caught: a repository-wide pnpm reporter override must not collapse child exit 2 into exit 1.
    const invalidCommand = await run("pnpm", ["hq", "missing"], { cwd: repositoryRoot });
    const invalidFormat = await run("pnpm", ["hq", "doctor", "--format", "text"], { cwd: repositoryRoot });

    expect(invalidCommand.exitCode).toBe(2);
    expect(invalidFormat.exitCode).toBe(2);
  });
});

describe.sequential("hq setup process safety", () => {
  it("saves and diagnoses a fresh text-only install through the actual CLI without echoing secrets", async () => {
    // Break caught: unit setup succeeds but the built prompt/config boundary still requires voice.
    const host = await createHostFixture();
    const configPath = join(host.env.XDG_CONFIG_HOME!, "orca-hq", "pilot.json");
    await rm(configPath);
    await writeCommand(host.bin, "security", 'if [ "$1" = "-i" ]; then cat >/dev/null; fi\nexit 0');
    try {
      const result = await runInteractiveSetup(host.env, [
        host.registryPath, "xapp-TEXTSECRET", "C123", "telegram-TEXTSECRET", "123", "", "y"
      ]);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("TEXTSECRET");
      expect(result.stderr).toBe("");
      const configText = await readFile(configPath, "utf8");
      expect(configText).not.toContain("TEXTSECRET");
      expect(JSON.parse(configText)).toMatchObject({
        voiceMode: "disabled",
        credentialAccounts: ["slack-app-token", "slack-channel-id", "telegram-allowed-chat-id", "telegram-bot-token"]
      });
      const doctor = await run("pnpm", ["hq", "doctor", "--format", "json"], { cwd: repositoryRoot, env: host.env });
      expect(doctor.exitCode).toBe(0);
      expect(JSON.parse(doctor.stdout).checks).toContainEqual({
        id: "openai.voice", status: "skip",
        message: "OpenAI voice is disabled; text commands use Codex CLI authentication."
      });
    } finally {
      await rm(host.fixture, { recursive: true, force: true });
    }
  }, 30_000);

  it("exits after failed preflight without waiting on an open readline handle", async () => {
    // Break caught: preflight returns before confirm, so CLI-level prompt ownership must still release stdin.
    const host = await createHostFixture();
    await writeCommand(host.bin, "tailscale", "exit 1");
    try {
      const result = await runInteractiveSetup(host.env, [
        host.registryPath, "xapp-secret", "C123", "telegram-secret", "123", "voice-secret"
      ]);

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Setup stopped before configuration");
      expect(result.stdout).toContain("required on first install");
    } finally {
      await rm(host.fixture, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not echo credentials or expose a failing Keychain command", async () => {
    // Break caught: terminal echo or raw batch-process output can expose the credential material.
    const credentials = [
      "xapp-SUPERSECRET",
      "C-SUPERSECRET",
      "telegram-SUPERSECRET",
      "chat-SUPERSECRET",
      "sk-SUPERSECRET"
    ] as const;
    const host = await createHostFixture();
    // This PATH-injected fake checks process wiring and redaction only; it cannot validate
    // the real macOS `security` parser or Keychain storage semantics.
    await writeCommand(host.bin, "security", [
      "if [ \"$1\" = \"-i\" ]; then",
      "  IFS= read -r command",
      "  printf 'simulated-child-stdout:%s\\n' \"$command\"",
      "  printf 'simulated-child-stderr:%s\\n' \"$command\" >&2",
      "  exit 42",
      "fi",
      "exit 0"
    ].join("\n"));
    try {
      const result = await runInteractiveSetup(host.env, [
        host.registryPath, ...credentials, "y"
      ]);

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1);
      for (const credential of credentials) {
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(credential);
      }
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("simulated-child-stdout");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("simulated-child-stderr");
      expect(result.stdout).toContain("Setup failed while applying configuration.");
      expect(result.stderr).toBe("");
    } finally {
      await rm(host.fixture, { recursive: true, force: true });
    }
  }, 30_000);
});
