import { parsePilotConfigText } from "@orca-hq/core";

import { ORCA_HQ_KEYCHAIN_SERVICE } from "./keychain.js";
import type { SecretPromptPort } from "./prompt.js";

export const credentialAccounts = Object.freeze(["slack-bot-token"] as const);
export type CredentialAccount = (typeof credentialAccounts)[number];

export interface CredentialPort {
  readonly configPath: string;
  readConfig(): Promise<string | undefined>;
  writeConfig(text: string): Promise<void>;
  storeSecret(service: string, account: string, value: string): Promise<void>;
  readonly prompt: SecretPromptPort;
  readonly output: { write(text: string): void };
}

export interface CredentialOperations {
  run(account: string): Promise<boolean>;
}

function isAllowedAccount(account: string): account is CredentialAccount {
  return credentialAccounts.includes(account as CredentialAccount);
}

function validSecret(account: CredentialAccount, value: string): boolean {
  return account === "slack-bot-token" && /^xoxb-\S+$/.test(value);
}

/** Stores one explicitly allowlisted secret and persists only its non-secret account name. */
export function createCredentialCommand(port: CredentialPort): CredentialOperations {
  return Object.freeze({
    async run(account: string): Promise<boolean> {
      if (!isAllowedAccount(account)) return false;
      try {
        const text = await port.readConfig();
        if (text === undefined) {
          port.output.write("유효한 pilot.json 설정이 없습니다. 먼저 hq setup을 실행하세요.");
          return false;
        }
        const config = parsePilotConfigText(text);
        const secret = await port.prompt.askSecret("Slack 봇 토큰(xoxb-): ");
        if (!validSecret(account, secret)) {
          port.output.write("Slack 봇 토큰 형식이 올바르지 않습니다.");
          return false;
        }
        port.output.write(`Keychain에 ${account}을 저장하고 ${port.configPath}의 계정 목록을 갱신합니다.`);
        if (!await port.prompt.confirm("계속하시겠습니까? [y/N] ")) {
          port.output.write("자격 증명 저장을 취소했습니다.");
          return false;
        }
        const credentialAccounts = [...new Set([...config.credentialAccounts, account])].sort();
        await port.storeSecret(ORCA_HQ_KEYCHAIN_SERVICE, account, secret);
        await port.writeConfig(`${JSON.stringify({ ...config, credentialAccounts }, null, 2)}\n`);
        port.output.write("Slack 봇 자격 증명을 저장했습니다.");
        return true;
      } catch {
        port.output.write("자격 증명을 안전하게 저장하지 못했습니다.");
        return false;
      } finally {
        port.prompt.close();
      }
    }
  });
}
