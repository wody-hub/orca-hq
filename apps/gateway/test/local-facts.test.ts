import { describe, expect, it } from 'vitest';
import { collectLocalFacts } from '../src/local-facts.js';

describe('L0 metadata collection', () => {
  it('uses only fixed git metadata probes and returns counts instead of filenames', async () => {
    const calls: readonly string[][] = [];
    const mutable = calls as string[][];
    const result = await collectLocalFacts([{ projectKey: 'sample', absolutePath: '/private/project' }], async (_cmd, args) => {
      mutable.push([...args]);
      if (args.includes('--short=8')) return '1234abcd\n';
      if (args.includes('--show-current')) return 'dev\n';
      return ' M private-roadmap.md\0?? secret-name.txt\0';
    });
    expect(result).toEqual([{ projectKey: 'sample', available: true, branch: 'dev', revision: '1234abcd', changedFiles: 2, untrackedFiles: 1 }]);
    expect(JSON.stringify(result)).not.toContain('roadmap');
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(calls).toEqual([
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', '/private/project', 'branch', '--show-current'],
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', '/private/project', 'rev-parse', '--short=8', 'HEAD'],
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', '/private/project', 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.', ':(exclude,glob)docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md']
    ]);
  });
  it('never runs status for a project declaring the protected roadmap', async () => {
    const calls: string[][] = [];
    const result = await collectLocalFacts([{ projectKey: 'protected', absolutePath: '/private/project', sensitivePaths: ['docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md'] }], async (_cmd, args) => {
      calls.push([...args]);
      return args.includes('--show-current') ? 'dev' : '1234abcd';
    });
    expect(calls).toHaveLength(2);
    expect(calls.some(args => args.includes('status'))).toBe(false);
    expect(result).toEqual([{ projectKey: 'protected', available: true, branch: 'dev', revision: '1234abcd', changeCountUnavailable: true }]);
  });

  it('reports unavailable metadata without forwarding command error details', async () => {
    const result = await collectLocalFacts([{ projectKey: 'sample', absolutePath: '/private/project' }], async () => { throw new Error('secret path'); });
    expect(result).toEqual([{ projectKey: 'sample', available: false }]);
  });
});
