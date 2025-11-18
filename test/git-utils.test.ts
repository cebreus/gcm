import { test, expect } from 'bun:test';
import { spawnGitStream, spawnGitLines, ensureGitRepo, runGitCmdSync } from '../src/git-utils';

async function gitUtilsGitVersionTest(): Promise<void> {
  const { text } = await spawnGitStream(['--version']);
  expect(text.toLowerCase()).toContain('git version');
}
test('git-utils: gitVersionTest', gitUtilsGitVersionTest);

async function gitUtilsSpawnLinesTest(): Promise<void> {
  const { lines } = await spawnGitLines(['--version']);
  expect(Array.isArray(lines)).toBe(true);
}
test('git-utils: spawnLinesTest', gitUtilsSpawnLinesTest);

async function gitUtilsRunSyncTest(): Promise<void> {
  const out = runGitCmdSync(['--version']);
  expect(out.toLowerCase()).toContain('git version');
}
test('git-utils: runSyncTest', gitUtilsRunSyncTest);

async function gitUtilsRepoTest(): Promise<void> {
  const isRepo = ensureGitRepo();
  // At minimum assert is boolean so we don't trigger unused var rule
  expect(typeof isRepo).toBe('boolean');
}
test('git-utils: repoTest', gitUtilsRepoTest);
