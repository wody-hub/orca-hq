import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { SetupAnswers } from "./setup.js";

export interface GuidedPromptPort {
  collectSetupAnswers(): Promise<SetupAnswers>;
  confirm(): Promise<boolean>;
}

const credentialPrompts = Object.freeze([
  ["slack-app-token", "Slack app token (leave blank to skip): "],
  ["slack-channel-id", "Slack channel ID (leave blank to skip): "],
  ["telegram-bot-token", "Telegram bot token (leave blank to skip): "],
  ["telegram-allowed-chat-id", "Telegram allowlisted chat ID (leave blank to skip): "],
  ["openai-api-key", "OpenAI API key (leave blank to skip): "]
] as const);

/** Terminal-only input boundary. Values are passed straight to Keychain and are never echoed by setup. */
export function createTerminalPrompt(): GuidedPromptPort {
  const prompt = createInterface({ input: stdin, output: stdout, terminal: true });
  let closed = false;
  async function ask(question: string): Promise<string> {
    try {
      return await prompt.question(question);
    } finally {
      // The confirmation is the final prompt in the normal flow; close below to release stdin either way.
    }
  }
  return {
    async collectSetupAnswers(): Promise<SetupAnswers> {
      const registryPath = (await ask("Pilot project Registry path: ")).trim();
      const credentials: Record<string, string> = {};
      for (const [account, question] of credentialPrompts) {
        const value = await ask(question);
        if (value.length > 0) credentials[account] = value;
      }
      return { registryPath, credentials };
    },
    async confirm(): Promise<boolean> {
      try {
        return (await ask("Apply this setup? [y/N] ")).trim().toLowerCase() === "y";
      } finally {
        if (!closed) {
          closed = true;
          prompt.close();
        }
      }
    }
  };
}
