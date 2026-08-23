import { expect, test } from 'bun:test';

import { readCommitContextFacts } from '../src/services/repository-context.js';
import type { SpawnGitStreamResult } from '../src/git-utils.js';

function gitResult(text: string): SpawnGitStreamResult {
  return { text, truncated: false };
}

test('reads exact scope and recent history commands for changed paths', async () => {
  const commands: string[][] = [];
  const responses = ['feat(core): first\nfix(api): second', 'fix(api): second\nchore: third'];

  const result = await readCommitContextFacts(['src/a.ts', 'src/b.ts'], {
    runGit: async function (args) {
      commands.push(args);
      return gitResult(responses[commands.length - 1] ?? '');
    },
    fileExists: async function () {
      return false;
    },
  });

  expect(commands).toEqual([
    ['log', '-n', '50', '--pretty=format:%s', '--', 'src/a.ts', 'src/b.ts'],
    ['log', '-n', '20', '--pretty=format:%s', '--', 'src/a.ts', 'src/b.ts'],
  ]);
  expect(result).toEqual({
    scopeHistorySubjects: ['feat(core): first', 'fix(api): second'],
    recentSubjects: ['fix(api): second', 'chore: third'],
    repoType: 'single',
  });
});

test.each([
  [1, [], ['recent subject']],
  [2, ['scope subject'], []],
])(
  'keeps successful history and repository facts when Git query %d fails',
  async (failedCall, expectedScopeHistory, expectedRecentHistory) => {
    let call = 0;
    const result = await readCommitContextFacts(['src/a.ts'], {
      runGit: async function () {
        call += 1;
        if (call === failedCall) throw new Error('git log failed');
        return gitResult(call === 1 ? 'scope subject' : 'recent subject');
      },
      fileExists: async function (path) {
        return path === 'pnpm-workspace.yaml';
      },
    });

    expect(result).toEqual({
      scopeHistorySubjects: expectedScopeHistory,
      recentSubjects: expectedRecentHistory,
      repoType: 'monorepo',
    });
  },
);

test.each([
  ['lerna', ['lerna.json']],
  ['pnpm workspace', ['pnpm-workspace.yaml']],
  ['packages and apps directories', ['packages', 'apps']],
])('detects a monorepo from %s facts', async (_, existingPaths) => {
  const result = await readCommitContextFacts(['src/a.ts'], {
    runGit: async function () {
      return gitResult('');
    },
    fileExists: async function (path) {
      return existingPaths.includes(path);
    },
  });

  expect(result.repoType).toBe('monorepo');
});

test('requires both packages and apps directories for directory-based monorepo detection', async () => {
  const result = await readCommitContextFacts(['src/a.ts'], {
    runGit: async function () {
      return gitResult('');
    },
    fileExists: async function (path) {
      return path === 'packages';
    },
  });

  expect(result.repoType).toBe('single');
});

test('returns deterministic empty facts without I/O for no changed files', async () => {
  let calls = 0;
  const result = await readCommitContextFacts([], {
    runGit: async function () {
      calls += 1;
      return gitResult('');
    },
    fileExists: async function () {
      calls += 1;
      return false;
    },
  });

  expect(result).toEqual({ scopeHistorySubjects: [], recentSubjects: [], repoType: 'single' });
  expect(calls).toBe(0);
});
