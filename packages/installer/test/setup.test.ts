import { describe, expect, it } from "vitest";

import { createSetup, type SetupPorts } from "../src/setup.js";

class RecordingKeychain {
  readonly entries: Array<readonly [string, string, string]> = [];

  async set(service: string, account: string, value: string): Promise<void> {
    this.entries.push([service, account, value]);
  }
}

class RecordingConfigFile {
  readonly path = "/private/pilot/orca-hq.json";
  previews: string[] = [];
  writes: string[] = [];

  async preview(text: string): Promise<void> {
    this.previews.push(text);
  }

  async write(text: string): Promise<void> {
    this.writes.push(text);
  }
}

function ports(): SetupPorts & { keychain: RecordingKeychain; configFile: RecordingConfigFile; output: { lines: string[]; write(text: string): void } } {
  const keychain = new RecordingKeychain();
  const configFile = new RecordingConfigFile();
  const output = { lines: [] as string[], write(text: string) { this.lines.push(text); } };
  const pass = async () => "pass" as const;
  return {
    databasePath: "/Users/pilot/Library/Application Support/orca-hq/control.sqlite",
    keychain,
    configFile,
    output,
    confirm: async () => true,
    checks: {
      pilotConfiguration: pass, macosCpu: pass, nodePnpm: pass, orcaCapabilities: pass, codexAuthentication: pass,
      claudeAuthentication: pass, tailscaleTailnet: pass, slackSocketMode: pass,
      telegramAllowlistedChat: pass, openAiVoice: pass, keychain: pass, sqliteDirectory: pass,
      launchd: pass, projectDiscovery: pass
    },
    registry: { review: async () => ({ status: "pass", curatedProjects: 5 }) }
  };
}

describe("guided private-pilot setup", () => {
  it("stores credentials in Keychain and never prints values", async () => {
    // Break caught: a convenient setup summary can copy a channel token into disk config or terminal history.
    const fixture = ports();
    const setup = createSetup(fixture);

    const result = await setup.run({
      credentials: {
        "slack-app-token": "xapp-secret",
        "telegram-bot-token": "telegram-secret",
        "openai-api-key": "voice-secret"
      },
      registryPath: "/private/pilot/projects.yaml"
    });

    expect(result.ok).toBe(true);
    expect(fixture.keychain.entries).toContainEqual(["orca-hq", "slack-app-token", "xapp-secret"]);
    expect(fixture.output.lines.join("\n")).not.toContain("xapp-secret");
    expect(fixture.output.lines.join("\n")).not.toContain("telegram-secret");
    expect(fixture.configFile.writes.join("\n")).not.toContain("xapp-secret");
    expect(fixture.configFile.previews).toHaveLength(1);
    expect(JSON.parse(fixture.configFile.writes[0] ?? "{}")).toMatchObject({
      databasePath: "/Users/pilot/Library/Application Support/orca-hq/control.sqlite"
    });
    expect(fixture.output.lines.join("\n")).toContain(fixture.configFile.path);
  });

  it("does not write configuration when a prerequisite check fails", async () => {
    // Break caught: setup could leave partial machine configuration after detecting an unsupported host.
    const fixture = ports();
    fixture.checks.macosCpu = async () => "fail";

    const result = await createSetup(fixture).run({ credentials: {}, registryPath: "/private/pilot/projects.yaml" });

    expect(result.ok).toBe(false);
    expect(fixture.keychain.entries).toEqual([]);
    expect(fixture.configFile.writes).toEqual([]);
  });

  it("leaves Keychain and config untouched when the explicit confirmation is declined", async () => {
    // Break caught: a displayed plan must not silently become a machine mutation when the user declines it.
    const fixture = ports();
    fixture.confirm = async () => false;

    const result = await createSetup(fixture).run({
      credentials: { "slack-app-token": "xapp-secret" },
      registryPath: "/private/pilot/projects.yaml"
    });

    expect(result.ok).toBe(false);
    expect(fixture.keychain.entries).toEqual([]);
    expect(fixture.configFile.writes).toEqual([]);
    expect(fixture.output.lines.join("\n")).toContain("Setup cancelled");
  });
});
