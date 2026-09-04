import { describe, expect, it } from "vitest";

import { runCli, type HostAdapters } from "../src/cli.js";
import type { DoctorPorts } from "../src/doctor.js";
import type { LaunchdOperations, LaunchdStatus } from "../src/launchd.js";
import type { LifecycleComposition } from "../src/lifecycle-host.js";
import type { GuidedPromptPort } from "../src/prompt.js";

function passingDoctor(): DoctorPorts {
  const pass = async () => "pass" as const;
  return {
    checks: {
      pilotConfiguration: pass, macosCpu: pass, nodePnpm: pass, orcaCapabilities: pass, codexAuthentication: pass,
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
    Object.assign(doctor.checks, { macosCpu: async () => "fail" as const });
  }
  return {
    writes,
    get prompts() { return prompts; },
    doctor,
    setup(cliOutput, requestConfirmation, _pending) {
      return {
        ...doctor,
        databasePath: "/Users/pilot/Library/Application Support/orca-hq/control.sqlite",
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

function launchd(status: LaunchdStatus = { state: "running", pid: 428 }): LaunchdOperations & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async install() { calls.push("install"); },
    async start() { calls.push("start"); },
    async stop() { calls.push("stop"); },
    async status() { calls.push("status"); return status; },
    async uninstall() { calls.push("uninstall"); }
  };
}

describe("hq command-line contract", () => {
  it("dispatches update with an exact revision through the lifecycle composition", async () => {
    // Break caught: `pnpm hq update` could remain a reserved branch instead of invoking guarded lifecycle work.
    const stdout = output();
    const calls: string[] = [];
    const revision = "a".repeat(40);
    const lifecycle: LifecycleComposition = {
      update: {
        async run(options?: Readonly<{ revision?: string }>) {
          calls.push(`update:${options?.revision ?? "missing"}`);
          return {
            previousRevision: "b".repeat(40),
            revision,
            backup: {
              id: "backup-1",
              path: "/pilot/backups/backup-1",
              databasePath: "/pilot/backups/backup-1/runtime.sqlite",
              createdAt: "2026-09-04T01:02:03.000Z",
              sourceRevision: "b".repeat(40),
              schemaVersion: 2,
              includesConfig: false,
              includesSecrets: false
            }
          };
        }
      },
      uninstall: {
        programPath: "/pilot/program",
        dataPath: "/pilot/data",
        programConfirmationPhrase: "REMOVE ORCA HQ PROGRAM AT /pilot/program",
        dataConfirmationPhrase: "REMOVE ORCA HQ PROGRAM AT /pilot/program AND DATA AT /pilot/data",
        async run() { throw new Error("unexpected uninstall"); }
      }
    };

    const exitCode = await runCli(["update", "--revision", revision], {
      stdout,
      lifecycle
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([`update:${revision}`]);
    expect(stdout.lines.join("\n")).toContain('"backupId":"backup-1"');
  });

  it("previews both uninstall targets and dispatches only exact program or program-plus-data confirmation", async () => {
    // Break caught: uninstall CLI can recursively delete a checkout without first displaying and confirming its absolute path.
    const stdout = output();
    const calls: unknown[] = [];
    const programPhrase = "REMOVE ORCA HQ PROGRAM AT /pilot/program";
    const dataPhrase = "REMOVE ORCA HQ PROGRAM AT /pilot/program AND DATA AT /pilot/data";
    const lifecycle: LifecycleComposition = {
      update: { async run() { throw new Error("unexpected update"); } },
      uninstall: {
        programPath: "/pilot/program",
        dataPath: "/pilot/data",
        programConfirmationPhrase: programPhrase,
        dataConfirmationPhrase: dataPhrase,
        async run(options: Readonly<{ removeData: boolean; confirmation?: string }>) {
          calls.push(options);
          return { dataPreserved: !options.removeData, removedProgramPath: "/pilot/program" };
        }
      }
    };

    await expect(runCli(["uninstall"], { stdout, lifecycle })).resolves.toBe(2);
    expect(stdout.lines.join("\n")).toContain("Program path: /pilot/program");
    expect(stdout.lines.join("\n")).toContain(`pnpm hq uninstall --confirm '${programPhrase}'`);
    expect(calls).toEqual([]);
    await expect(runCli(["uninstall", "--confirm", programPhrase], { stdout, lifecycle })).resolves.toBe(0);
    await expect(runCli(["uninstall", "--remove-data"], { stdout, lifecycle })).resolves.toBe(2);
    expect(stdout.lines.join("\n")).toContain("Data path: /pilot/data");
    expect(stdout.lines.join("\n")).toContain(`pnpm hq uninstall --remove-data --confirm '${dataPhrase}'`);
    await expect(runCli(
      ["uninstall", "--remove-data", "--confirm", dataPhrase],
      { stdout, lifecycle }
    )).resolves.toBe(0);

    expect(calls).toEqual([
      { removeData: false, confirmation: programPhrase },
      { removeData: true, confirmation: dataPhrase }
    ]);
  });

  it("shell-quotes the preview re-run command without evaluating path metacharacters", async () => {
    // Break caught: copying a preview command can evaluate shell syntax embedded in an otherwise valid local path.
    const stdout = output();
    const phrase = "REMOVE ORCA HQ PROGRAM AT /pilot/$(touch unsafe)";
    const lifecycle: LifecycleComposition = {
      update: { async run() { throw new Error("unexpected update"); } },
      uninstall: {
        programPath: "/pilot/$(touch unsafe)",
        dataPath: "/pilot/data",
        programConfirmationPhrase: phrase,
        dataConfirmationPhrase: `${phrase} AND DATA AT /pilot/data`,
        async run() { throw new Error("unexpected uninstall"); }
      }
    };

    await expect(runCli(["uninstall"], { stdout, lifecycle })).resolves.toBe(2);

    expect(stdout.lines.join("\n")).toContain(`pnpm hq uninstall --confirm '${phrase}'`);
    expect(stdout.lines.join("\n")).not.toContain(`--confirm "${phrase}"`);
  });

  it("redacts lifecycle provider failures at the CLI boundary", async () => {
    // Break caught: UpdateFailedError.cause can retain diagnostics internally but must not print provider secrets.
    const stdout = output();
    const lifecycle: LifecycleComposition = {
      update: { async run() { throw new Error("provider-secret-token"); } },
      uninstall: {
        programPath: "/pilot/program",
        dataPath: "/pilot/data",
        programConfirmationPhrase: "REMOVE ORCA HQ PROGRAM AT /pilot/program",
        dataConfirmationPhrase: "REMOVE ORCA HQ PROGRAM AT /pilot/program AND DATA AT /pilot/data",
        async run() { throw new Error("unexpected uninstall"); }
      }
    };

    await expect(runCli(
      ["update", "--revision", "a".repeat(40)],
      { stdout, lifecycle }
    )).resolves.toBe(1);

    expect(stdout.lines.join("\n")).toContain("Lifecycle operation failed.");
    expect(stdout.lines.join("\n")).not.toContain("provider-secret-token");
  });

  it("reports lifecycle configuration failures with a fixed setup action and no raw details", async () => {
    // Break caught: an invalid pilot config can be absorbed into the generic provider failure with no recovery action.
    for (const input of [
      ["update", "--revision", "a".repeat(40)],
      ["uninstall"]
    ]) {
      const stdout = output();
      const lifecycleFactory = async (): Promise<LifecycleComposition> => {
        throw Object.assign(new Error("secret=/tmp/private/pilot.json"), { code: "lifecycle_config_invalid" });
      };

      await expect(runCli(input, { stdout, lifecycleFactory })).resolves.toBe(1);

      expect(stdout.lines).toEqual([
        "Lifecycle configuration is missing or invalid; run hq setup to create or migrate it.\n"
      ]);
      expect(stdout.lines.join("\n")).not.toContain("secret=");
      expect(stdout.lines.join("\n")).not.toContain("/tmp/private/pilot.json");
    }
  });

  it("rejects impossible lifecycle syntax before creating the lifecycle host", async () => {
    // Break caught: a typo can invoke config loading first and be misreported as a configuration failure.
    let factoryCalls = 0;
    const lifecycleFactory = async (): Promise<LifecycleComposition> => {
      factoryCalls += 1;
      throw new Error("factory must not run");
    };

    for (const input of [
      ["update"],
      ["update", "--revision"],
      ["update", "--wrong", "a".repeat(40)],
      ["uninstall", "--wrong"],
      ["uninstall", "--confirm"],
      ["uninstall", "--confirm", "phrase", "extra"]
    ]) {
      const stdout = output();
      await expect(runCli(input, { stdout, lifecycleFactory })).resolves.toBe(2);
      expect(stdout.lines.join("\n")).toContain("Usage: hq");
    }

    expect(factoryCalls).toBe(0);
  });

  it("creates the lifecycle host for uninstall path previews", async () => {
    // Break caught: moving every uninstall form ahead of the factory can produce a preview without canonical paths.
    let factoryCalls = 0;
    const subject: LifecycleComposition = {
      update: { async run() { throw new Error("unexpected update"); } },
      uninstall: {
        programPath: "/pilot/program",
        dataPath: "/pilot/data",
        programConfirmationPhrase: "REMOVE ORCA HQ PROGRAM AT /pilot/program",
        dataConfirmationPhrase: "REMOVE ORCA HQ PROGRAM AT /pilot/program AND DATA AT /pilot/data",
        async run() { throw new Error("unexpected uninstall"); }
      }
    };
    const lifecycleFactory = async (): Promise<LifecycleComposition> => {
      factoryCalls += 1;
      return subject;
    };

    await expect(runCli(["uninstall"], { stdout: output(), lifecycleFactory })).resolves.toBe(2);
    await expect(runCli(["uninstall", "--remove-data"], { stdout: output(), lifecycleFactory })).resolves.toBe(2);

    expect(factoryCalls).toBe(2);
  });

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
    await expect(runCli(["logs"], { stdout })).resolves.toBe(1);
  });

  it("does not restart an already running LaunchAgent through the start surface", async () => {
    // Break caught: a repeated `hq start` interrupts healthy gateway work with a forced restart.
    const stdout = output();
    const service = launchd();

    await expect(runCli(["start"], { stdout, launchd: service })).resolves.toBe(0);

    expect(service.calls).toEqual(["install", "status"]);
    expect(stdout.lines).toEqual(["Orca HQ gateway started.\n"]);
  });

  it("starts an installed but non-running LaunchAgent", async () => {
    // Break caught: avoiding a destructive restart must not leave a loaded, stopped service idle.
    const stdout = output();
    const service = launchd({ state: "loaded" });

    await expect(runCli(["start"], { stdout, launchd: service })).resolves.toBe(0);

    expect(service.calls).toEqual(["install", "status", "start"]);
  });

  it("stops and reports status through the exact LaunchAgent operations", async () => {
    // Break caught: stop/status bypass the injected service boundary or expose raw launchctl output.
    const stopOutput = output();
    const statusOutput = output();
    const service = launchd({ state: "stopped" });

    await expect(runCli(["stop"], { stdout: stopOutput, launchd: service })).resolves.toBe(0);
    await expect(runCli(["status"], { stdout: statusOutput, launchd: service })).resolves.toBe(1);

    expect(service.calls).toEqual(["stop", "status"]);
    expect(stopOutput.lines).toEqual(["Orca HQ gateway stopped.\n"]);
    expect(statusOutput.lines).toEqual([`${JSON.stringify({ state: "stopped" })}\n`]);
  });

  it("returns a redacted failure when a launchd operation rejects", async () => {
    // Break caught: launchctl stderr or command details can leak through the CLI service boundary.
    const stdout = output();
    const service = launchd({ state: "loaded" });
    service.start = async () => { throw new Error("TOKEN=launchd-secret"); };

    await expect(runCli(["start"], { stdout, launchd: service })).resolves.toBe(1);

    expect(stdout.lines.join("\n")).toContain("Gateway service operation failed.");
    expect(stdout.lines.join("\n")).not.toContain("launchd-secret");
  });
});
