import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export type MetadataCommand = (executable: string, args: readonly string[]) => Promise<string>;
const command: MetadataCommand = async (executable, args) => (await execute(executable, [...args], {
  timeout: 8000, maxBuffer: 512 * 1024,
  env: { HOME: process.env.HOME, PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
})).stdout;
export type ProjectFact = Readonly<{
  projectKey: string; available: boolean; branch?: string; revision?: string; changedFiles?: number; untrackedFiles?: number; changeCountUnavailable?: boolean;
}>;

/** No diff, content, hash of files, hooks, or model-provided shell arguments are evaluated. */
export async function collectLocalFacts(
  projects: readonly Readonly<{ projectKey: string; absolutePath: string; sensitivePaths?: readonly string[] }>[],
  run: MetadataCommand = command
): Promise<ProjectFact[]> {
  return await Promise.all(projects.map(async (project): Promise<ProjectFact> => {
    try {
      const prefix = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', project.absolutePath];
      const branch = (await run('git', [...prefix, 'branch', '--show-current'])).trim();
      const revision = (await run('git', [...prefix, 'rev-parse', '--short=8', 'HEAD'])).trim();
      if (project.sensitivePaths?.includes('docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md')) {
        return { projectKey: project.projectKey, available: true, branch: branch || '(detached)', revision, changeCountUnavailable: true };
      }
      const raw = await run('git', [...prefix, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.', ...[...new Set(['docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md', ...(project.sensitivePaths ?? [])])].map(path => `:(exclude,glob)${path}`)]);
      const entries = raw.split('\0');
      let changedFiles = 0; let untrackedFiles = 0;
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (!entry) continue;
        changedFiles += 1;
        if (entry.startsWith('?? ')) untrackedFiles += 1;
        if (/^[RC]|^.[RC]/.test(entry)) i += 1;
      }
      return { projectKey: project.projectKey, available: true, branch: branch || '(detached)', revision, changedFiles, untrackedFiles };
    } catch { return { projectKey: project.projectKey, available: false }; }
  }));
}
