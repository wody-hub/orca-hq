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
      macosCpu: pass, nodePnpm: pass, orcaCapabilities: pass, codexAuthentication: pass,
      claudeAuthentication: pass, tailscaleTailnet: pass, slackSocketMode: pass,
      telegramAllowlistedChat: pass, openAiVoice: pass, keychain: pass, sqliteDirectory: pass,
      launchd: pass, projectDiscovery: pass
    },
    registry: { review: async () => ({ status: "warn", curatedProjects: 4 }) }
  };
}

describe("read-only private-pilot doctor", () => {
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

  it("does not downgrade an explicit failed Registry review to a warning", async () => {
    // Break caught: an unavailable Registry review must block setup even when its project count is also incomplete.
    const machine = ports();
    machine.registry = { review: async () => ({ status: "fail", curatedProjects: 0 }) };

    const result = await createDoctor(machine).run({ format: "json" });

    expect(result.checks.find((check) => check.id === "registry.five-project-curation")?.status).toBe("fail");
    await expect(doctorExitCode(result)).resolves.toBe(1);
  });
});
