import { describe, expect, it } from "vitest";

import { createDoctor } from "../src/doctor.js";
import { createMacosHostAdapters, createNodeMachine, type HostMachinePort } from "../src/host.js";
import { createSetup } from "../src/setup.js";

class RecordingMachine implements HostMachinePort {
  readonly requests: string[] = [];
  readonly mutations: string[] = [];
  writtenConfig: string | undefined;

  constructor(private readonly options: Readonly<{
    config?: "current" | "legacy" | "missing" | "malformed" | "arbitrary";
    legacyAccounts?: readonly string[];
  }> = {}) {}

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
    if (path.endsWith("pilot.json")) {
      const config = this.options.config ?? "current";
      if (config === "missing") return undefined;
      if (config === "malformed") return "{not-json";
      const snapshot: Record<string, unknown> = {
        schema: "orca-hq.private-pilot.v1",
        projectRegistryPath: config === "arbitrary" ? "/private/stale/projects.yaml" : "/temporary/projects.yaml",
        credentialAccounts: config === "arbitrary"
          ? ["stale-account"]
          : this.options.legacyAccounts ?? ["slack-app-token", "slack-channel-id", "telegram-bot-token", "telegram-allowed-chat-id", "openai-api-key"]
      };
      if (config === "arbitrary") snapshot.unexpected = "not-a-legacy-config";
      if (config === "current") {
        snapshot.databasePath = "/temporary/home/Library/Application Support/orca-hq/control.sqlite";
      }
      return JSON.stringify(snapshot);
    }
    return path === "/temporary/projects.yaml"
      ? "projects:\n  - one\n  - two\n  - three\n  - four\n  - five\n"
      : undefined;
  }
  async directoryWritable(path: string): Promise<boolean> { this.requests.push(`access:${path}`); return true; }
  async createDirectory(path: string): Promise<void> { this.mutations.push(`mkdir:${path}`); }
  async writeText(path: string, text: string): Promise<void> {
    this.mutations.push(`write:${path}`);
    this.writtenConfig = text;
  }
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

  it("diagnoses a legacy config as migration-needed while preserving credential and Registry checks", async () => {
    // Break caught: dropping legacy fields during parsing makes healthy Keychain accounts and Registry look unavailable.
    const machine = new RecordingMachine({ config: "legacy" });

    const result = await createDoctor(createMacosHostAdapters(machine).doctor).run({ format: "json" });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "config.pilot-schema")?.status).toBe("warn");
    expect(result.checks.find((check) => check.id === "slack.socket-mode")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "telegram.allowlisted-chat")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "openai.voice")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "registry.five-project-curation")?.status).toBe("pass");
    expect(machine.mutations).toEqual([]);
    expect(machine.requests.filter((request) => request.startsWith("command:security:find-generic-password"))).toHaveLength(5);
    expect(machine.requests.join("\n")).not.toContain(" -w ");
  });

  it("fails the dedicated config check for missing and arbitrary malformed config", async () => {
    // Break caught: missing or malformed input can accidentally enter the narrow legacy migration branch.
    for (const config of ["missing", "malformed", "arbitrary"] as const) {
      const machine = new RecordingMachine({ config });

      const result = await createDoctor(createMacosHostAdapters(machine).doctor).run({ format: "json" });

      expect(result.ok).toBe(false);
      expect(result.checks.find((check) => check.id === "config.pilot-schema")?.status).toBe("fail");
      expect(result.checks.find((check) => check.id === "slack.socket-mode")?.status).toBe("fail");
      expect(result.checks.find((check) => check.id === "registry.five-project-curation")?.status).toBe("fail");
      expect(machine.mutations).toEqual([]);
    }
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
    const machine = new RecordingMachine({ config: "missing" });
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

  it.each(["malformed", "arbitrary"] as const)(
    "replaces %s config only from complete new inputs after confirmation",
    async (config) => {
      // Break caught: setup can keep treating an invalid on-disk config as a failed prerequisite or reuse its untrusted metadata.
      const machine = new RecordingMachine({ config });
      const adapters = createMacosHostAdapters(machine);
      const preview = { lines: [] as string[], write(text: string) { this.lines.push(text); } };
      let confirmations = 0;
      const answers = {
        credentials: {
          "slack-app-token": "new-slack-secret", "slack-channel-id": "C456",
          "telegram-bot-token": "new-telegram-secret", "telegram-allowed-chat-id": "456",
          "openai-api-key": "new-openai-secret"
        },
        registryPath: "/temporary/projects.yaml"
      };

      const result = await createSetup(adapters.setup(preview, async () => {
        confirmations += 1;
        expect(machine.mutations).toEqual([]);
        return true;
      }, answers)).run(answers);

      expect(result.ok).toBe(true);
      expect(confirmations).toBe(1);
      expect(preview.lines).toEqual([
        "Planned configuration: /temporary/config/orca-hq/pilot.json",
        "Planned changes: save non-secret pilot configuration and store selected credentials in Keychain.",
        "Configuration written: /temporary/config/orca-hq/pilot.json"
      ]);
      expect(preview.lines.join("\n")).not.toContain("new-slack-secret");
      expect(machine.mutations.filter((mutation) => mutation.startsWith("keychain:"))).toEqual([
        "keychain:openai-api-key",
        "keychain:slack-app-token",
        "keychain:slack-channel-id",
        "keychain:telegram-allowed-chat-id",
        "keychain:telegram-bot-token"
      ]);
      expect(JSON.parse(machine.writtenConfig ?? "{}")).toEqual({
        schema: "orca-hq.private-pilot.v1",
        databasePath: "/temporary/home/Library/Application Support/orca-hq/control.sqlite",
        projectRegistryPath: "/temporary/projects.yaml",
        credentialAccounts: [
          "openai-api-key",
          "slack-app-token",
          "slack-channel-id",
          "telegram-allowed-chat-id",
          "telegram-bot-token"
        ]
      });
      expect(machine.requests).not.toContain("read:/private/stale/projects.yaml");
    }
  );

  it.each([
    { config: "malformed" as const, credentials: {}, registryPath: "/temporary/projects.yaml" },
    {
      config: "arbitrary" as const,
      credentials: {
        "slack-app-token": "new-slack-secret", "slack-channel-id": "C456",
        "telegram-bot-token": "new-telegram-secret", "telegram-allowed-chat-id": "456",
        "openai-api-key": "new-openai-secret"
      },
      registryPath: ""
    }
  ])("does not mutate $config config when required recovery input is missing", async ({ config, credentials, registryPath }) => {
    // Break caught: lowering only the schema check could let an incomplete recovery plan overwrite config or Keychain state.
    const machine = new RecordingMachine({ config });
    const adapters = createMacosHostAdapters(machine);
    const answers = { credentials, registryPath };

    const result = await createSetup(adapters.setup({ write: () => undefined }, async () => true, answers)).run(answers);

    expect(result.ok).toBe(false);
    expect(machine.mutations).toEqual([]);
    expect(machine.writtenConfig).toBeUndefined();
  });

  it("migrates a legacy config with blank inputs without reading or rewriting Keychain secrets", async () => {
    // Break caught: setup can require every secret again or erase legacy account names during migration.
    const machine = new RecordingMachine({ config: "legacy" });
    const adapters = createMacosHostAdapters(machine);
    const answers = { credentials: {}, registryPath: "" };

    const result = await createSetup(adapters.setup({ write: () => undefined }, async () => true, answers)).run(answers);

    expect(result.ok).toBe(true);
    expect(machine.mutations.filter((mutation) => mutation.startsWith("keychain:"))).toEqual([]);
    expect(machine.requests.join("\n")).not.toContain(" -w ");
    expect(JSON.parse(machine.writtenConfig ?? "{}")).toEqual({
      schema: "orca-hq.private-pilot.v1",
      databasePath: "/temporary/home/Library/Application Support/orca-hq/control.sqlite",
      projectRegistryPath: "/temporary/projects.yaml",
      credentialAccounts: ["openai-api-key", "slack-app-token", "slack-channel-id", "telegram-allowed-chat-id", "telegram-bot-token"]
    });
  });

  it("merges a newly entered credential with legacy account names", async () => {
    // Break caught: entering one new credential can replace every preserved account name in pilot.json.
    const machine = new RecordingMachine({
      config: "legacy",
      legacyAccounts: ["slack-app-token", "slack-channel-id", "telegram-bot-token", "telegram-allowed-chat-id"]
    });
    const adapters = createMacosHostAdapters(machine);
    const answers = { credentials: { "openai-api-key": "new-secret" }, registryPath: "" };

    const result = await createSetup(adapters.setup({ write: () => undefined }, async () => true, answers)).run(answers);

    expect(result.ok).toBe(true);
    expect(machine.mutations.filter((mutation) => mutation.startsWith("keychain:"))).toEqual(["keychain:openai-api-key"]);
    expect(JSON.parse(machine.writtenConfig ?? "{}")).toMatchObject({
      projectRegistryPath: "/temporary/projects.yaml",
      credentialAccounts: ["openai-api-key", "slack-app-token", "slack-channel-id", "telegram-allowed-chat-id", "telegram-bot-token"]
    });
  });
});
