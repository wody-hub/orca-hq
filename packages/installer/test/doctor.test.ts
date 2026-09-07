import { describe, expect, it } from "vitest";

import {
  DoctorResultSchema,
  createDoctor,
  doctorExitCode,
  type DoctorPorts
} from "../src/doctor.js";

function ports(): DoctorPorts & { mutations: string[] } {
  const mutations: string[] = [];
  const pass = async () => "pass" as const;
  return {
    mutations,
    checks: {
      pilotConfiguration: pass, macosCpu: pass, nodePnpm: pass, orcaCapabilities: pass, codexAuthentication: pass,
      claudeAuthentication: pass, tailscaleTailnet: pass, slackSocketMode: pass,
      telegramAllowlistedChat: pass, openAiVoice: pass, keychain: pass, sqliteDirectory: pass,
      launchd: pass, projectDiscovery: pass
    },
    registry: { review: async () => ({ status: "warn", curatedProjects: 4 }) }
  };
}

class ReadOnlyMachine {
  readonly mutations: string[] = [];

  attemptMutation(operation: string): never {
    this.mutations.push(operation);
    throw new Error(`doctor attempted mutation: ${operation}`);
  }
}

describe("read-only private-pilot doctor", () => {
  it("never permits required host or Registry checks to be skipped", async () => {
    const machine = ports();
    machine.checks.codexAuthentication = async () => "skip";
    machine.registry = { review: async () => ({ status: "skip", curatedProjects: 5 }) };
    const result = await createDoctor(machine).run({ format: "json" });
    expect(result.checks.find((check) => check.id === "codex.authentication")?.status).toBe("fail");
    expect(result.checks.find((check) => check.id === "registry.projects-ready")?.status).toBe("fail");
    expect(result.ok).toBe(false);
  });

  it("does not mutate machine state and emits a validated JSON report", async () => {
    // Break caught: a diagnostic run must never install services, alter credentials, or create files.
    const machine = ports();

    const result = await createDoctor(machine).run({ format: "json" });

    expect(machine.mutations).toEqual([]);
    expect(DoctorResultSchema.parse(result)).toEqual(result);
    expect(result.checks.map((check) => check.id)).toContain("orca.capabilities");
    expect(JSON.stringify(result)).not.toContain("xapp-secret");
    await expect(doctorExitCode(result)).resolves.toBe(0);
  });

  it("returns exit code one only for failed checks, not warnings", async () => {
    // Break caught: a warning could unnecessarily stop the pilot, while a failed capability could be ignored.
    const warning = await createDoctor(ports()).run({ format: "json" });
    const failedPorts = ports();
    failedPorts.checks.orcaCapabilities = async () => "fail";
    const failed = await createDoctor(failedPorts).run({ format: "json" });

    await expect(doctorExitCode(warning)).resolves.toBe(0);
    await expect(doctorExitCode(failed)).resolves.toBe(1);
  });

  it("accepts one registered project and explains automatic Orca discovery", async () => {
    // Break caught: the legacy pilot's exactly-five gate can reject a valid managed installation with one project.
    const machine = ports();
    machine.registry = { review: async () => ({ status: "pass", curatedProjects: 1 }) };

    const result = await createDoctor(machine).run({ format: "json" });

    expect(result.checks.find((check) => check.id === "registry.projects-ready")).toEqual({
      id: "registry.projects-ready",
      status: "pass",
      message: "1 registered project is ready. Orca discovers local repositories automatically."
    });
    expect(result.ok).toBe(true);
  });

  it("fails Registry readiness when no project is registered", async () => {
    // Break caught: zero projects could remain a warning and allow setup to create an unusable managed service.
    const machine = ports();
    machine.registry = { review: async () => ({ status: "warn", curatedProjects: 0 }) };

    const result = await createDoctor(machine).run({ format: "json" });

    expect(result.checks.find((check) => check.id === "registry.projects-ready")).toMatchObject({
      status: "fail",
      remediation: "Run hq projects sync to discover Orca projects automatically, then review the Registry."
    });
    expect(result.ok).toBe(false);
  });

  it("reports legacy pilot configuration with a fixed migration warning", async () => {
    // Break caught: a legacy schema can be misreported as unrelated credential and Registry failures.
    const machine = ports();
    machine.checks.pilotConfiguration = async () => "warn";

    const result = await createDoctor(machine).run({ format: "json" });

    expect(result.checks.find((check) => check.id === "config.pilot-schema")).toEqual({
      id: "config.pilot-schema",
      status: "warn",
      message: "Pilot configuration migration is required.",
      remediation: "Run hq setup to create or migrate the pilot configuration."
    });
    await expect(doctorExitCode(result)).resolves.toBe(0);
  });

  it("does not downgrade an explicit failed Registry review to a warning", async () => {
    // Break caught: an unavailable Registry review must block setup even when its project count is also incomplete.
    const machine = ports();
    machine.registry = { review: async () => ({ status: "fail", curatedProjects: 0 }) };

    const result = await createDoctor(machine).run({ format: "json" });

    expect(result.checks.find((check) => check.id === "registry.projects-ready")?.status).toBe("fail");
    await expect(doctorExitCode(result)).resolves.toBe(1);
  });

  it("records a forbidden machine mutation so the read-only assertion is not vacuous", async () => {
    // Break caught: a future doctor adapter that reaches a write-capable operation must fail the read-only fixture.
    const machine = new ReadOnlyMachine();
    const fixture = ports();
    fixture.checks.keychain = async () => machine.attemptMutation("security add-generic-password");

    const result = await createDoctor(fixture).run({ format: "json" });

    expect(machine.mutations).toEqual(["security add-generic-password"]);
    expect(result.checks.find((check) => check.id === "keychain.access")?.status).toBe("fail");
  });
});
