import { describe, expect, it } from "vitest";

import { runCli, type HostAdapters } from "../src/cli.js";
import type { DoctorPorts } from "../src/doctor.js";

function passingDoctor(): DoctorPorts {
  const pass = async () => "pass" as const;
  return {
    checks: {
      macosCpu: pass, nodePnpm: pass, orcaCapabilities: pass, codexAuthentication: pass,
      claudeAuthentication: pass, tailscaleTailnet: pass, slackSocketMode: pass,
      telegramAllowlistedChat: pass, openAiVoice: pass, keychain: pass, sqliteDirectory: pass,
      launchd: pass, projectDiscovery: pass
    },
    registry: { review: async () => ({ status: "pass", curatedProjects: 5 }) }
  };
}

function output(): { lines: string[]; write(text: string): boolean } {
  const lines: string[] = [];
  return { lines, write(text: string) { lines.push(text); return true; } };
}

function adapters(confirm = true): HostAdapters & { writes: string[]; prompts: number } {
  const writes: string[] = [];
  let prompts = 0;
  return {
    writes,
    get prompts() { return prompts; },
    doctor: passingDoctor(),
    setup(cliOutput, requestConfirmation, _pending) {
      return {
        ...passingDoctor(),
        keychain: { set: async (_service, account) => { writes.push(`keychain:${account}`); } },
        configFile: {
          path: "/temporary/orca-hq.json",
          preview: async () => undefined,
          write: async () => { writes.push("config"); }
        },
        output: cliOutput,
        confirm: async () => { prompts += 1; return (await requestConfirmation()) && confirm; }
      };
    }
  };
}

describe("hq command-line contract", () => {
  it("uses the host adapter factory for doctor and emits only JSON on stdout", async () => {
    // Break caught: omitting the default host factory would return the old all-fail placeholder report.
    const stdout = output();
    const machine = adapters();

    const exitCode = await runCli(["doctor", "--format", "json"], { stdout, host: machine });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.lines.join(""))).toMatchObject({ ok: true });
    expect(stdout.lines.join("")).not.toContain("xapp-secret");
  });

  it("runs guided setup through the host adapter and writes only after confirmation", async () => {
    // Break caught: source-installed `hq setup` must not require test-only injected setup answers.
    const stdout = output();
    const machine = adapters();
    const exitCode = await runCli(["setup"], {
      stdout,
      host: machine,
      prompt: {
        collectSetupAnswers: async () => ({
          credentials: { "slack-app-token": "xapp-secret" },
          registryPath: "/temporary/projects.yaml"
        }),
        confirm: async () => true
      }
    });

    expect(exitCode).toBe(0);
    expect(machine.prompts).toBe(1);
    expect(machine.writes).toEqual(["keychain:slack-app-token", "config"]);
    expect(stdout.lines.join("")).toContain("Planned configuration");
  });

  it("does not write when guided setup confirmation is declined", async () => {
    // Break caught: a decline at the CLI confirmation gate must preserve the machine unchanged.
    const stdout = output();
    const machine = adapters(false);
    const exitCode = await runCli(["setup"], {
      stdout,
      host: machine,
      prompt: { collectSetupAnswers: async () => ({ credentials: {}, registryPath: "/temporary/projects.yaml" }), confirm: async () => false }
    });

    expect(exitCode).toBe(1);
    expect(machine.writes).toEqual([]);
  });

  it("rejects invalid commands and formats while preserving reserved command behavior", async () => {
    // Break caught: command parsing changes must retain the documented exit status contract.
    const stdout = output();

    await expect(runCli(["missing"], { stdout })).resolves.toBe(2);
    await expect(runCli(["doctor", "--format", "text"], { stdout })).resolves.toBe(2);
    await expect(runCli(["start"], { stdout })).resolves.toBe(1);
  });
});
