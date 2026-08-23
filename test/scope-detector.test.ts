import { expect, test } from 'bun:test';

import { getCommitContextHints } from '../src/scope-detector';

test('returns deterministic empty hints without changed files', () => {
  expect(
    getCommitContextHints([], {
      scopeHistorySubjects: ['feat(core): ignored without changed files'],
      recentSubjects: ['feat(core): ignored without changed files'],
      repoType: 'monorepo',
    }),
  ).toEqual({ scopeSuggestions: [], recentCommitSubjects: [] });
});

test('deduplicates historical and single-repository path scopes in encounter order', async () => {
  const result = await getCommitContextHints(
    [
      'src/api/index.ts',
      'src/api/other.ts',
      '.github/workflows/ci.yml',
      'package.json',
      'scripts/release.ts',
    ],
    {
      scopeHistorySubjects: [
        'feat(core): add command',
        'fix(core): handle retry',
        'docs(api): explain endpoint',
        'plain subject',
      ],
      recentSubjects: [
        'feat(core): add command',
        'fix(core): handle retry',
        'docs(api): explain endpoint',
        'plain subject',
      ],
      repoType: 'single',
    },
  );

  expect(result.scopeSuggestions).toEqual(['core', 'api', 'ci', 'build', 'dx']);
  expect(result.recentCommitSubjects).toEqual([
    'feat(core): add command',
    'fix(core): handle retry',
    'docs(api): explain endpoint',
    'plain subject',
  ]);
});

test('detects app and package scopes in a monorepo', async () => {
  const result = await getCommitContextHints(
    ['apps/web/src/index.ts', 'packages/shared/src/index.ts', 'apps/web/src/other.ts'],
    { scopeHistorySubjects: [], recentSubjects: [], repoType: 'monorepo' },
  );

  expect(result.scopeSuggestions).toEqual(['web', 'shared']);
  expect(result.recentCommitSubjects).toEqual([]);
});

test('keeps the first ten unique non-empty recent subjects in order', async () => {
  const historySubjects = [
    '',
    'feat(one): first',
    'feat(one): first',
    'fix(two): second',
    'docs: third',
    'test: fourth',
    'build: fifth',
    'ci: sixth',
    'refactor: seventh',
    'perf: eighth',
    'style: ninth',
    'chore: tenth',
    'fix: eleventh',
  ];

  const result = await getCommitContextHints(['README.md'], {
    scopeHistorySubjects: [],
    recentSubjects: historySubjects,
    repoType: 'single',
  });

  expect(result.recentCommitSubjects).toEqual([
    'feat(one): first',
    'fix(two): second',
    'docs: third',
    'test: fourth',
    'build: fifth',
    'ci: sixth',
    'refactor: seventh',
    'perf: eighth',
    'style: ninth',
    'chore: tenth',
  ]);
});
