import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(command: string, arguments_: readonly string[]): Promise<ProcessResult> {
  return await new Promise((resolvePromise, reject) => {
    execFile(command, [...arguments_], { cwd: repositoryRoot }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolvePromise({ exitCode: error === null ? 0 : error.code, stdout, stderr });
    });
  });
}

function extractShellCommands(markdown: string): string[] {
  const commands: string[] = [];
  const fencePattern = /```(?:bash|sh|shell)\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(fencePattern)) {
    for (const line of (match[1] ?? "").split("\n")) {
      const command = line.trim();
      if (command.length > 0 && !command.startsWith("#")) commands.push(command);
    }
  }
  return commands;
}

function documentedHqCommand(command: string): string | undefined {
  const match = /^pnpm hq ([a-z-]+)(?:\s|$)/.exec(command);
  return match?.[1];
}

it("keeps documented CLI commands in sync with help output", async () => {
  // Break caught: onboarding or operations docs can advertise an hq subcommand the shipped CLI does not recognize.
  const [installation, operations, help] = await Promise.all([
    readFile(resolve(repositoryRoot, "docs/installation/private-pilot.md"), "utf8"),
    readFile(resolve(repositoryRoot, "docs/operations/runbook.md"), "utf8"),
    run("pnpm", ["hq"])
  ]);

  expect(help.exitCode).toBe(2);
  expect(help.stderr).toBe("");
  const usage = /^Usage: hq ([a-z|]+)$/m.exec(help.stdout);
  expect(usage, help.stdout).not.toBeNull();
  const recognized = new Set((usage?.[1] ?? "").split("|"));

  const commands = extractShellCommands(`${installation}\n${operations}`)
    .filter((command) => command.startsWith("pnpm hq"));
  const documented = commands
    .map(documentedHqCommand)
    .filter((command): command is string => command !== undefined);

  expect(documented).toEqual(expect.arrayContaining(["setup", "doctor", "start", "status"]));
  for (const command of documented) expect(recognized.has(command), command).toBe(true);
});
