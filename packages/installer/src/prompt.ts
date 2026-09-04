import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";

import type { SetupAnswers } from "./setup.js";

export interface GuidedPromptPort {
  collectSetupAnswers(): Promise<SetupAnswers>;
  confirm(): Promise<boolean>;
  close(): void;
}

export interface TerminalPromptOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

const credentialPrompts = Object.freeze([
  ["slack-app-token", "Slack app token (leave blank to skip): "],
  ["slack-channel-id", "Slack channel ID (leave blank to skip): "],
  ["telegram-bot-token", "Telegram bot token (leave blank to skip): "],
  ["telegram-allowed-chat-id", "Telegram allowlisted chat ID (leave blank to skip): "],
  ["openai-api-key", "OpenAI API key (leave blank to skip): "]
] as const);

/** Terminal-only input boundary. Values are passed straight to Keychain and are never echoed. */
export function createTerminalPrompt(options: TerminalPromptOptions = {}): GuidedPromptPort {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  let muted = false;
  const readlineOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    }
  });
  Object.assign(readlineOutput, {
    isTTY: true,
    columns: (output as { readonly columns?: number }).columns ?? 80
  });
  const prompt = createInterface({ input, output: readlineOutput, terminal: true });
  let closed = false;
  async function askSecret(question: string): Promise<string> {
    output.write(question);
    muted = true;
    try {
      return await prompt.question("");
    } finally {
      muted = false;
      output.write("\n");
    }
  }
  return {
    async collectSetupAnswers(): Promise<SetupAnswers> {
      const registryPath = (await prompt.question("Pilot project Registry path: ")).trim();
      const credentials: Record<string, string> = {};
      for (const [account, question] of credentialPrompts) {
        const value = await askSecret(question);
        if (value.length > 0) credentials[account] = value;
      }
      return { registryPath, credentials };
    },
    async confirm(): Promise<boolean> {
      return (await prompt.question("Apply this setup? [y/N] ")).trim().toLowerCase() === "y";
    },
    close(): void {
      if (!closed) {
        closed = true;
        prompt.close();
      }
    }
  };
}
