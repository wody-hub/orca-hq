import { describe, expect, it } from "vitest";

import { createDoctor } from "../src/doctor.js";
import { createMacosHostAdapters, createNodeMachine, type HostMachinePort } from "../src/host.js";
import { createSetup } from "../src/setup.js";

class RecordingMachine implements HostMachinePort {
  readonly requests: string[] = [];
  readonly mutations: string[] = [];

  constructor(private readonly hasConfig = true) {}

  platform(): string { this.requests.push("platform"); return "darwin"; }
  architecture(): string { this.requests.push("architecture"); return "arm64"; }
  nodeVersion(): string { this.requests.push("nodeVersion"); return "v22.20.0"; }
  homeDirectory(): string { this.requests.push("homeDirectory"); return "/temporary/home"; }
  configDirectory(): string { this.requests.push("configDirectory"); return "/temporary/config"; }
  async command(executable: string, arguments_: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
    this.requests.push(`command:${executable}:${arguments_.join(" ")}`);
    return { ok: true, stdout: "[]" };
  }
  async readText(path: string): Promise<string | undefined> {
    this.requests.push(`read:${path}`);
    if (path.endsWith("pilot.json") && this.hasConfig) {
      return JSON.stringify({
        projectRegistryPath: "/temporary/projects.yaml",
        credentialAccounts: ["slack-app-token", "slack-channel-id", "telegram-bot-token", "telegram-allowed-chat-id", "openai-api-key"]
      });
    }
    return "projects:\n  - one\n  - two\n  - three\n  - four\n  - five\n";
  }
  async directoryWritable(path: string): Promise<boolean> { this.requests.push(`access:${path}`); return true; }
  async createDirectory(path: string): Promise<void> { this.mutations.push(`mkdir:${path}`); }
  async writeText(path: string): Promise<void> { this.mutations.push(`write:${path}`); }
  async storeKeychainSecret(_service: string, account: string): Promise<void> { this.mutations.push(`keychain:${account}`); }
}

describe("macOS host adapters", () => {
  it("replaces Keychain command failures with a fixed secret-free error", async () => {
    // Break caught: Node's execFile error contains every argv value, including the credential passed after -w.
    const secret = "xapp-SUPERSECRET";
    const machine = createNodeMachine(async (_executable, arguments_) => {
      throw new Error(`Command failed: security ${arguments_.join(" ")}`);
    });

    let thrown: unknown;
    try {
      await machine.storeKeychainSecret("orca-hq", "slack-app-token", secret);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Unable to store credential in macOS Keychain.");
    expect((thrown as Error).message).not.toContain(secret);
  });

  it("runs every doctor probe through a recording read-only machine boundary", async () => {
    // Break caught: adding a config, filesystem, process, or Keychain write to doctor must make this assertion fail.
    const machine = new RecordingMachine();

    const result = await createDoctor(createMacosHostAdapters(machine).doctor).run({ format: "json" });

    expect(result.ok).toBe(true);
    expect(machine.mutations).toEqual([]);
    expect(machine.requests).toContain("command:tailscale:status --json");
    expect(machine.requests).toContain("command:security:list-keychains");
    expect(machine.requests).toContain("read:/temporary/config/orca-hq/pilot.json");
    expect(machine.requests).toContain("read:/temporary/projects.yaml");
    expect(machine.requests).toContain("access:/temporary/config");
  });

  it("records real setup writes, proving the doctor read-only fake is not a no-op", async () => {
    // Break caught: if recording mutations is disconnected, the preceding no-mutation assertion would be vacuous.
    const machine = new RecordingMachine();
    const adapters = createMacosHostAdapters(machine);
    const output = { write: (_text: string) => undefined };

    const answers = {
      credentials: { "slack-app-token": "xapp-secret" },
      registryPath: "/temporary/projects.yaml"
    };
    const result = await createSetup(adapters.setup(output, async () => true, answers)).run(answers);

    expect(result.ok).toBe(true);
    expect(machine.mutations).toEqual([
      "keychain:slack-app-token",
      "mkdir:/temporary/config/orca-hq",
      "write:/temporary/config/orca-hq/pilot.json"
    ]);
  });

  it("allows a fresh guided setup to validate the supplied plan before it exists on disk", async () => {
    // Break caught: a new source installation must not require a pre-existing config or Keychain entry before it can create either.
    const machine = new RecordingMachine(false);
    const adapters = createMacosHostAdapters(machine);
    const answers = {
      credentials: {
        "slack-app-token": "xapp-secret", "slack-channel-id": "C123",
        "telegram-bot-token": "telegram-secret", "telegram-allowed-chat-id": "123",
        "openai-api-key": "voice-secret"
      },
      registryPath: "/temporary/projects.yaml"
    };

    const result = await createSetup(adapters.setup({ write: () => undefined }, async () => true, answers)).run(answers);

    expect(result.ok).toBe(true);
    expect(machine.mutations).toContain("write:/temporary/config/orca-hq/pilot.json");
  });
});
