import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitService } from '../src/services/git-service.js';

const decoder = new TextDecoder();
const isolatedEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
let repository = '';

async function git(args: string[]): Promise<{ text: string; truncated: boolean }> {
  const child = Bun.spawn({
    cmd: ['git', ...args],
    cwd: repository,
    env: isolatedEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  if (exitCode !== 0) throw new Error(decoder.decode(stderr));
  return { text: decoder.decode(stdout), truncated: false };
}

const content = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join('');

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), 'gcm-diff-args-'));
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'color.ui', 'always']);
  await Bun.write(join(repository, 'old.txt'), content);
  await git(['add', 'old.txt']);
  await git(['commit', '-q', '-m', 'initial']);
  await git(['mv', 'old.txt', 'new.txt']);
  await Bun.write(join(repository, 'new.txt'), content.replace('line 3\n', 'changed\n'));
  await git(['add', 'new.txt']);
});

afterEach(async () => {
  await rm(repository, { recursive: true, force: true });
});

async function resultFor(commit: string | null, exclude: string[] = []) {
  if (commit) await git(['commit', '-q', '-m', 'rename']);
  return createGitService({ gitCommandRunner: git }).retrieveStagedChanges(commit, null, exclude);
}

async function diffFor(commit: string | null): Promise<string | undefined> {
  return (await resultFor(commit))?.stagedDiff;
}

async function stageRename(from: string, to: string, text: string): Promise<void> {
  await git(['reset', '-q', '--hard', 'HEAD']);
  await Bun.write(join(repository, from), text);
  await git(['add', from]);
  await git(['commit', '-q', '-m', 'add']);
  await git(['mv', from, to]);
  await Bun.write(join(repository, to), text.replace('LEAK_MARKER_2', 'LEAK_MARKER_3'));
  await git(['add', to]);
}

const secret = `${content}LEAK_MARKER_1\nLEAK_MARKER_2\n`;

for (const [form, commit] of [
  ['staged', null],
  ['commit', 'HEAD'],
] as const) {
  test(`${form} diff reports a rename`, async () => {
    const diff = await diffFor(commit);
    expect(diff).toContain('rename from old.txt');
    expect(diff).toContain('rename to new.txt');
  });

  test(`${form} file list has one logical path per rename`, async () => {
    expect((await resultFor(commit))?.stagedFiles).toEqual(['new.txt']);
  });

  test(`${form} diff has no colour codes`, async () => {
    expect(await diffFor(commit)).not.toContain('\u001b');
  });
}

for (const [form, commit] of [
  ['staged', null],
  ['commit', 'HEAD'],
] as const) {
  for (const [from, to] of [
    ['secret.env', 'config.txt'],
    ['notes.txt', 'secret.env'],
  ]) {
    test(`${form} rename ${from} -> ${to} leaks no excluded content`, async () => {
      await stageRename(from, to, secret);
      const result = await resultFor(commit, ['*.env']);
      expect(result?.stagedDiff ?? '').not.toContain('LEAK_MARKER');
      expect(result).toBeNull();
    });
  }

  test(`${form} diff ignores external diff and textconv drivers`, async () => {
    const script = join(repository, 'sentinel.sh');
    await Bun.write(script, '#!/bin/sh\necho EXT_DIFF_SENTINEL\n');
    const conv = join(repository, 'conv.sh');
    await Bun.write(conv, '#!/bin/sh\necho TEXTCONV_SENTINEL\n');
    await git(['config', 'diff.external', `sh ${script}`]);
    await git(['config', 'diff.sentinel.textconv', `sh ${conv}`]);
    await Bun.write(join(repository, '.gitattributes'), '*.txt diff=sentinel\n');
    const diff = await diffFor(commit);
    expect(diff).toContain('+changed');
    expect(diff).not.toContain('EXT_DIFF_SENTINEL');
    expect(diff).not.toContain('TEXTCONV_SENTINEL');
  });

  test(`${form} file list round-trips odd path names`, async () => {
    const odd = ['tab\there.txt', 'new\nline.txt', 'žluťoučký.txt'];
    for (const name of odd) await Bun.write(join(repository, name), 'x\n');
    await git(['add', ...odd]);
    const result = await resultFor(commit);
    expect([...(result?.stagedFiles ?? [])].sort()).toEqual(['new.txt', ...odd].sort());
  });
}

test('getRepositoryState reports a conflicted merge as in progress', async () => {
  const base = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).text.trim();
  await git(['commit', '-q', '-m', 'rename']);
  await git(['checkout', '-q', '-b', 'topic']);
  await Bun.write(join(repository, 'new.txt'), content.replace('line 3\n', 'topic\n'));
  await git(['commit', '-q', '-am', 'topic']);
  await git(['checkout', '-q', base]);
  await Bun.write(join(repository, 'new.txt'), content.replace('line 3\n', 'base\n'));
  await git(['commit', '-q', '-am', 'base']);
  await expect(git(['merge', 'topic'])).rejects.toThrow();

  // The service checks marker files relative to the process cwd, so hand it an absolute git dir.
  const runner = (args: string[]) =>
    git(args.join(' ') === 'rev-parse --git-dir' ? ['rev-parse', '--absolute-git-dir'] : args);
  const state = await createGitService({ gitCommandRunner: runner }).getRepositoryState(null);

  expect(state.inProgressOperation).toBe('merge');
  expect(state.hasUnmergedPaths).toBeTrue();
});
