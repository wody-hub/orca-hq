import { describe, expect, it } from "vitest";

import { runCli, type HostAdapters } from "../src/cli.js";
import type { DoctorPorts } from "../src/doctor.js";
import type { GuidedPromptPort } from "../src/prompt.js";

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

function adapters(options: Readonly<{
  confirm?: boolean;
  preflight?: "pass" | "fail";
  keychainError?: Error;
}> = {}): HostAdapters & { writes: string[]; prompts: number } {
  const writes: string[] = [];
  let prompts = 0;
  const doctor = passingDoctor();
  if (options.preflight === "fail") {
    doctor.checks.macosCpu = async () => "fail";
  }
  return {
    writes,
    get prompts() { return prompts; },
    doctor,
    setup(cliOutput, requestConfirmation, _pending) {
      return {
        ...doctor,
        keychain: { set: async (_service, account) => {
          if (options.keychainError !== undefined) throw options.keychainError;
          writes.push(`keychain:${account}`);
        } },
        configFile: {
          path: "/temporary/orca-hq.json",
          preview: async () => undefined,
          write: async () => { writes.push("config"); }
        },
        output: cliOutput,
        confirm: async () => { prompts += 1; return (await requestConfirmation()) && (options.confirm ?? true); }
      };
    }
  };
}

function guidedPrompt(credentials: Readonly<Record<string, string>> = {}): GuidedPromptPort & { closeCalls: number } {
  let closeCalls = 0;
  return {
    get closeCalls() { return closeCalls; },
    collectSetupAnswers: async () => ({ credentials, registryPath: "/temporary/projects.yaml" }),
    confirm: async () => true,
    close: () => { closeCalls += 1; }
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
    const prompt = guidedPrompt({ "slack-app-token": "xapp-secret" });
    const exitCode = await runCli(["setup"], {
      stdout,
      host: machine,
      prompt
    });

    expect(exitCode).toBe(0);
    expect(machine.prompts).toBe(1);
    expect(machine.writes).toEqual(["keychain:slack-app-token", "config"]);
    expect(stdout.lines.join("")).toContain("Planned configuration");
    expect(prompt.closeCalls).toBe(1);
  });

  it("does not write when guided setup confirmation is declined", async () => {
    // Break caught: a decline at the CLI confirmation gate must preserve the machine unchanged.
    const stdout = output();
    const machine = adapters({ confirm: false });
    const prompt = guidedPrompt();
    const exitCode = await runCli(["setup"], {
      stdout,
      host: machine,
      prompt
    });

    expect(exitCode).toBe(1);
    expect(machine.writes).toEqual([]);
    expect(prompt.closeCalls).toBe(1);
  });

  it("closes the setup prompt once when preflight stops before confirmation", async () => {
    // Break caught: a failed preflight must not leave readline holding the TTY open because confirm was skipped.
    const stdout = output();
    const machine = adapters({ preflight: "fail" });
    const prompt = guidedPrompt();

    const exitCode = await runCli(["setup"], { stdout, host: machine, prompt });

    expect(exitCode).toBe(1);
    expect(machine.prompts).toBe(0);
    expect(prompt.closeCalls).toBe(1);
  });

  it("closes the setup prompt and redacts adapter errors", async () => {
    // Break caught: a Keychain adapter failure can otherwise leak the secret from its argv and skip readline cleanup.
    const secret = "xapp-SUPERSECRET";
    const stdout = output();
    const machine = adapters({ keychainError: new Error(`security -w ${secret}`) });
    const prompt = guidedPrompt({ "slack-app-token": secret });

    const exitCode = await runCli(["setup"], { stdout, host: machine, prompt });

    expect(exitCode).toBe(1);
    expect(prompt.closeCalls).toBe(1);
    expect(stdout.lines.join("\n")).toContain("Setup failed while applying configuration.");
    expect(stdout.lines.join("\n")).not.toContain(secret);
  });

  it("rejects invalid commands and formats while preserving reserved command behavior", async () => {
    // Break caught: command parsing changes must retain the documented exit status contract.
    const stdout = output();

    await expect(runCli(["missing"], { stdout })).resolves.toBe(2);
    await expect(runCli(["doctor", "--format", "text"], { stdout })).resolves.toBe(2);
    await expect(runCli(["start"], { stdout })).resolves.toBe(1);
  });
});
