import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function writeSuccessCommand(directory: string, name: string): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}

describe("pnpm hq doctor process contract", () => {
  it("writes one parseable JSON document to stdout with a temporary, fully-probed host", async () => {
    // Break caught: package-manager lifecycle banners or diagnostics on stdout corrupt automation consuming `pnpm hq doctor --format json`.
    const fixture = await mkdtemp(join(tmpdir(), "orca-hq-cli-process-"));
    const home = join(fixture, "home");
    const bin = join(fixture, "bin");
    const configPath = join(home, ".config", "orca-hq", "pilot.json");
    const registryPath = join(fixture, "projects.yaml");
    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      schema: "orca-hq.private-pilot.v1",
      projectRegistryPath: registryPath,
      credentialAccounts: ["slack-app-token", "slack-channel-id", "telegram-bot-token", "telegram-allowed-chat-id", "openai-api-key"]
    }), "utf8");
    await writeFile(registryPath, "projects:\n  - one\n  - two\n  - three\n  - four\n  - five\n", "utf8");
    for (const name of ["orca", "codex", "claude", "tailscale", "security", "launchctl"]) {
      await writeSuccessCommand(bin, name);
    }

    try {
      const result = await execFileAsync("pnpm", ["hq", "doctor", "--format", "json"], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` }
      });

      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
      expect(result.stderr).toBe("");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
