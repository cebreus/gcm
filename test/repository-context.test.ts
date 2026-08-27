import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { readCommitContextFacts } from '../src/services/repository-context.js';
import type { SpawnGitStreamResult } from '../src/git-utils.js';

function gitResult(text: string): SpawnGitStreamResult {
  return { text, truncated: false };
}

test('reads exact scope and recent history commands for changed paths', async () => {
  const commands: string[][] = [];
  const history = Array.from({ length: 25 }, function (_, index) {
    return `feat(core): change ${index + 1}`;
  });

  const result = await readCommitContextFacts(['src/a.ts', 'src/b.ts'], {
    runGit: async function (args) {
      commands.push(args);
      return gitResult(history.join('\n'));
    },
    fileExists: async function () {
      return false;
    },
  });

  expect(commands).toEqual([
    ['log', '-n', '50', '--pretty=format:%s', '--', ':(literal)src/a.ts', ':(literal)src/b.ts'],
  ]);
  expect(result).toEqual({
    scopeHistorySubjects: history,
    recentSubjects: history.slice(0, 20),
    repoType: 'single',
  });
});

test('keeps repository facts when Git history fails', async () => {
  const result = await readCommitContextFacts(['src/a.ts'], {
    runGit: async function () {
      throw new Error('git log failed');
    },
    fileExists: async function (path) {
      return path === 'pnpm-workspace.yaml';
    },
  });

  expect(result).toEqual({
    scopeHistorySubjects: [],
    recentSubjects: [],
    repoType: 'monorepo',
  });
});

test('recovers recent history when the longer history read fails', async () => {
  const commands: string[][] = [];
  const result = await readCommitContextFacts(['src/a.ts'], {
    runGit: async function (args) {
      commands.push(args);
      if (commands.length === 1) throw new Error('transient git log failure');
      return gitResult('feat: recovered');
    },
    fileExists: async function () {
      return false;
    },
  });

  expect(commands).toEqual([
    ['log', '-n', '50', '--pretty=format:%s', '--', ':(literal)src/a.ts'],
    ['log', '-n', '20', '--pretty=format:%s', '--', ':(literal)src/a.ts'],
  ]);
  expect(result.scopeHistorySubjects).toEqual([]);
  expect(result.recentSubjects).toEqual(['feat: recovered']);
});

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

test('returns no history subject for empty Git output', async () => {
  const result = await readCommitContextFacts(['src/a.ts'], {
    runGit: async function () {
      return gitResult('');
    },
    fileExists: async function () {
      return false;
    },
  });

  expect(result.scopeHistorySubjects).toEqual([]);
  expect(result.recentSubjects).toEqual([]);
});

test('detects packages and apps directories with the default Bun adapter', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-context-'));
  const previousDirectory = process.cwd();
  try {
    await mkdir(join(repository, 'packages'));
    await mkdir(join(repository, 'apps'));
    process.chdir(repository);

    const result = await readCommitContextFacts(['src/index.ts']);

    expect(result.repoType).toBe('monorepo');
  } finally {
    process.chdir(previousDirectory);
    await rm(repository, { recursive: true, force: true });
  }
});
