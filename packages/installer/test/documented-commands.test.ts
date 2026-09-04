import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { runCli, type CliDependencies } from "../src/cli.js";
import type { DoctorPorts } from "../src/doctor.js";
import type { LifecycleComposition } from "../src/lifecycle-host.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fullRevision = "a".repeat(40);
const programPath = "/tmp/orca-hq-synthetic-program";
const dataPath = "/tmp/orca-hq-synthetic-data";
const programPhrase = `REMOVE ORCA HQ PROGRAM AT ${programPath}`;
const dataPhrase = `${programPhrase} AND DATA AT ${dataPath}`;

function passingDoctor(): DoctorPorts {
  const pass = async () => "pass" as const;
  return {
    checks: {
      pilotConfiguration: pass,
      macosCpu: pass,
      nodePnpm: pass,
      orcaCapabilities: pass,
      codexAuthentication: pass,
      claudeAuthentication: pass,
      tailscaleTailnet: pass,
      slackSocketMode: pass,
      telegramAllowlistedChat: pass,
      openAiVoice: pass,
      keychain: pass,
      sqliteDirectory: pass,
      launchd: pass,
      projectDiscovery: pass
    },
    registry: { review: async () => ({ status: "pass", curatedProjects: 5 }) }
  };
}

function fakeLifecycle(calls: string[]): LifecycleComposition {
  return {
    update: {
      async run(options) {
        calls.push(`update:${options?.revision ?? "missing"}`);
        return {
          previousRevision: "b".repeat(40),
          revision: fullRevision,
          backup: {
            id: "synthetic-backup",
            path: "/tmp/orca-hq-synthetic-backup",
            databasePath: "/tmp/orca-hq-synthetic-backup/runtime.sqlite",
            createdAt: "2026-09-04T00:00:00.000Z",
            sourceRevision: "b".repeat(40),
            schemaVersion: 2,
            includesConfig: true,
            includesSecrets: false
          }
        };
      }
    },
    uninstall: {
      programPath,
      dataPath,
      programConfirmationPhrase: programPhrase,
      dataConfirmationPhrase: dataPhrase,
      async run(options) {
        calls.push(`uninstall:${String(options.removeData)}:${options.confirmation ?? "missing"}`);
        return { dataPreserved: !options.removeData, removedProgramPath: programPath };
      }
    }
  };
}

function fakeDependencies(calls: string[], lines: string[]): CliDependencies {
  return {
    stdout: {
      write(text) {
        lines.push(text);
        return true;
      }
    },
    doctor: passingDoctor(),
    prompt: {
      collectSetupAnswers: async () => { throw new Error("synthetic setup probe"); },
      confirm: async () => false,
      close: () => undefined
    },
    launchd: {
      install: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      status: async () => ({ state: "running", pid: 4242 }),
      uninstall: async () => undefined
    },
    lifecycle: fakeLifecycle(calls)
  };
}

function extractDocumentedHqCommands(markdown: string): string[] {
  const commands: string[] = [];
  const fencePattern = /```(?:bash|sh|shell)\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(fencePattern)) {
    for (const line of (match[1] ?? "").split("\n")) {
      const command = line.trim();
      if (command.startsWith("pnpm hq")) commands.push(command);
    }
  }
  for (const match of markdown.matchAll(/`(pnpm hq(?: [^`\n]+)?)`/g)) {
    commands.push(match[1]!);
  }
  return commands;
}

function documentedArgv(command: string): string[] {
  return command
    .replace("<full-commit-sha>", fullRevision)
    .split(/\s+/)
    .slice(2);
}

async function probe(input: readonly string[]): Promise<Readonly<{
  exitCode: number;
  output: string;
  calls: readonly string[];
}>> {
  const lines: string[] = [];
  const calls: string[] = [];
  const exitCode = await runCli(input, fakeDependencies(calls, lines));
  return { exitCode, output: lines.join(""), calls };
}

it("validates every documented hq command's full argv without external side effects", async () => {
  // Break caught: a documented safety flag can drift while the subcommand name remains valid.
  const documentPaths = [
    "README.md",
    "docs/installation/private-pilot.md",
    "docs/operations/runbook.md",
    "SECURITY.md"
  ];
  const documents = await Promise.all(documentPaths.map(async (path) =>
    await readFile(resolve(repositoryRoot, path), "utf8")));
  const commands = [...new Set(documents.flatMap(extractDocumentedHqCommands))];

  expect(commands).toEqual(expect.arrayContaining([
    "pnpm hq setup",
    "pnpm hq doctor --format json",
    "pnpm hq start",
    "pnpm hq status",
    "pnpm hq update --revision <full-commit-sha>",
    "pnpm hq uninstall --remove-data"
  ]));

  for (const command of commands) {
    const result = await probe(documentedArgv(command));
    expect(result.output, command).not.toMatch(/^Usage: hq /);
    expect(result.output, command).not.toContain("requires --format json");
  }

  for (const revision of [fullRevision, "c".repeat(64)]) {
    const update = await probe(["update", "--revision", revision]);
    expect(update.calls).toEqual([`update:${revision}`]);
  }

  const uninstall = await probe(["uninstall", "--remove-data", "--confirm", dataPhrase]);
  expect(uninstall.exitCode).toBe(0);
  expect(uninstall.calls).toEqual([`uninstall:true:${dataPhrase}`]);
});

it("rejects misspelled or trailing flags with usage and exit 2", async () => {
  // Break caught: a typo after a valid argv can be silently ignored and invoke the documented operation.
  for (const input of [
    ["doctor", "--formt", "json"],
    ["doctor", "--format", "json", "--formt", "json"],
    ["update", "--revison", fullRevision],
    ["uninstall", "--remove-data", "--confim", dataPhrase]
  ]) {
    const result = await probe(input);
    expect(result.exitCode, input.join(" ")).toBe(2);
    expect(result.output, input.join(" ")).toMatch(/^Usage: hq /);
    expect(result.calls, input.join(" ")).toEqual([]);
  }
});

it("keeps generated acceptance and browser-test output outside the public repository index", () => {
  // Break caught: a standard acceptance or Playwright run can leave publishable output that `git add -A` stages.
  for (const generatedPath of [
    ".artifacts/private-pilot-acceptance.json",
    "apps/web/test-results/private-pilot/trace.zip"
  ]) {
    expect(() => execFileSync(
      "git",
      ["check-ignore", "--quiet", "--no-index", generatedPath],
      { cwd: repositoryRoot, stdio: "ignore" }
    ), generatedPath).not.toThrow();
  }
});
