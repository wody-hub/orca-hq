import { describe, expect, it } from "vitest";
import { PassThrough, Writable } from "node:stream";

import { createCredentialCommand, type CredentialPort } from "../src/credential.js";
import { createSecretPrompt } from "../src/prompt.js";

const existingConfig = {
  schema: "orca-hq.private-pilot.v1",
  databasePath: "/Users/pilot/Library/Application Support/orca-hq/control.sqlite",
  projectRegistryPath: "/Users/pilot/.config/orca-hq/projects.yaml",
  credentialAccounts: ["slack-app-token"],
  voiceMode: "disabled"
} as const;

function fixture(options: Readonly<{ confirmed?: boolean; secret?: string }> = {}) {
  const mutations: string[] = [];
  const lines: string[] = [];
  let written = "";
  const port: CredentialPort = {
    configPath: "/Users/pilot/.config/orca-hq/pilot.json",
    readConfig: async () => `${JSON.stringify(existingConfig, null, 2)}\n`,
    writeConfig: async (text) => { mutations.push("config"); written = text; },
    storeSecret: async (_service, account, value) => { mutations.push(`keychain:${account}:${value}`); },
    prompt: {
      askSecret: async () => options.secret ?? "xoxb-private-value",
      confirm: async () => options.confirmed ?? true,
      close: () => { mutations.push("close"); }
    },
    output: { write: (text) => { lines.push(text); } }
  };
  return { port, mutations, lines, get written() { return written; } };
}

describe("credential command", () => {
  it("stores an allowed Slack bot token and adds only its account to a validated config", async () => {
    // Break caught: a reply credential can be persisted in pilot.json or replace unrelated setup fields.
    const subject = fixture();

    await expect(createCredentialCommand(subject.port).run("slack-bot-token")).resolves.toBe(true);

    expect(subject.mutations).toEqual([
      "keychain:slack-bot-token:xoxb-private-value",
      "config",
      "close"
    ]);
    expect(JSON.parse(subject.written)).toEqual({
      ...existingConfig,
      credentialAccounts: ["slack-app-token", "slack-bot-token"]
    });
    expect(subject.written).not.toContain("xoxb-private-value");
  });

  it.each(["", "xapp-wrong-kind", "xoxb-has space", " xoxb-leading"])(
    "rejects malformed Slack bot token input %j before mutation",
    async (secret) => {
      // Break caught: malformed or whitespace-bearing values can replace the working Keychain item.
      const subject = fixture({ secret });

      await expect(createCredentialCommand(subject.port).run("slack-bot-token")).resolves.toBe(false);

      expect(subject.mutations).toEqual(["close"]);
    }
  );

  it("preserves Keychain and config when confirmation is declined", async () => {
    // Break caught: the narrow credential command can mutate state before its explicit confirmation gate.
    const subject = fixture({ confirmed: false });

    await expect(createCredentialCommand(subject.port).run("slack-bot-token")).resolves.toBe(false);

    expect(subject.mutations).toEqual(["close"]);
  });

  it("rejects every account outside the explicit allowlist without prompting", async () => {
    // Break caught: accepting arbitrary account names turns the command into an unrestricted Keychain writer.
    const subject = fixture();

    await expect(createCredentialCommand(subject.port).run("openai-api-key")).resolves.toBe(false);

    expect(subject.mutations).toEqual([]);
  });

  it("keeps terminal secret input out of prompt output", async () => {
    // Break caught: a one-off credential prompt can regress to readline's normal input echo behavior.
    const input = new PassThrough();
    let visible = "";
    const output = new Writable({
      write(chunk, _encoding, callback) { visible += chunk.toString(); callback(); }
    });
    const prompt = createSecretPrompt({ input, output });
    const answer = prompt.askSecret("Slack bot token: ");
    input.end("xoxb-never-echo\n");

    await expect(answer).resolves.toBe("xoxb-never-echo");
    prompt.close();

    expect(visible).toContain("Slack bot token: ");
    expect(visible).not.toContain("xoxb-never-echo");
  });
});
