import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { parsePilotConfigText, pilotConfigurationPath } from '@orca-hq/core';
import { Registry, type DiscoveredProject } from '@orca-hq/project-registry';
import { startLocalTextService } from './local-service.js';
import { createLocalChannels } from './local-channels.js';
import { summarizeWithCodex } from './local-codex.js';

const execute = promisify(execFile);
const accounts = ['slack-app-token', 'slack-bot-token', 'slack-channel-id', 'telegram-bot-token', 'telegram-allowed-chat-id'] as const;

export async function readLocalCredential(account: typeof accounts[number]): Promise<string> {
  try {
    const result = await execute('security', ['find-generic-password', '-s', 'orca-hq', '-a', account, '-w'], { timeout: 8000, maxBuffer: 4096 });
    const value = result.stdout.replace(/\n$/, '');
    if (!value.trim() || /\s/.test(value)) throw new Error();
    return value;
  } catch { throw new Error(`local_credential_unavailable:${account}`); }
}

export async function startLocalTextRuntime() {
  process.umask(0o077);
  const config = parsePilotConfigText(await readFile(pilotConfigurationPath({ homeDirectory: homedir(), configDirectory: process.env.XDG_CONFIG_HOME }), 'utf8'));
  if (config.voiceMode !== 'disabled') throw new Error('local_text_requires_disabled_voice');
  if (accounts.some(account => !config.credentialAccounts.includes(account))) {
    throw new Error('local_text_credentials_incomplete: run hq credential --account slack-bot-token');
  }
  let discovered: DiscoveredProject[];
  try {
    const output = await execute('orca', ['repo', 'list', '--json'], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(output.stdout) as { ok?: boolean; result?: { repos?: Array<{ id: string; path: string }> } };
    if (parsed.ok !== true || !Array.isArray(parsed.result?.repos)) throw new Error();
    discovered = parsed.result.repos.map(repo => ({ orcaProjectId: repo.id, absolutePath: repo.path, approved: true }));
  } catch { throw new Error('local_project_discovery_failed'); }
  const projects = Registry.load(config.projectRegistryPath, discovered);
  if (projects.length !== 5 || projects.some(project => project.allowedOperations.length !== 1 || project.allowedOperations[0] !== 'L0')) throw new Error('local_text_requires_five_L0_projects');
  const values = await Promise.all(accounts.map(readLocalCredential));
  const credentials = Object.fromEntries(accounts.map((account, index) => [account, values[index]!])) as Record<typeof accounts[number], string>;
  return await startLocalTextService({
    databasePath: config.databasePath,
    projects,
    channelFactory: ports => createLocalChannels({
      telegramBotToken: credentials['telegram-bot-token'], telegramChatId: credentials['telegram-allowed-chat-id'],
      slackAppToken: credentials['slack-app-token'], slackBotToken: credentials['slack-bot-token'], slackChannelId: credentials['slack-channel-id'],
      ...ports
    }),
    summarize: summarizeWithCodex
  });
}
