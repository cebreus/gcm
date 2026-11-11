import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnGitStream } from '../src/git-utils.js';
import { createGitService } from '../src/services/git-service.js';

const savedEnv = { ...process.env };
let repository = '';

// Simulates the 120 s default at test speed; explicit timeouts are honoured.
const runner: typeof spawnGitStream = (args, options = {}) =>
  spawnGitStream(['-C', repository, ...args], { timeoutMs: 300, ...options });

beforeEach(async () => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  repository = await mkdtemp(join(tmpdir(), 'gcm-commit-timeout-'));
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'T'],
    ['config', 'user.email', 't@e.x'],
  ])
    await spawnGitStream(['-C', repository, ...args]);
  const hook = join(repository, '.git', 'hooks', 'pre-commit');
  await Bun.write(hook, '#!/bin/sh\nsleep 1\ntouch hook-ran\n');
  await chmod(hook, 0o755);
  await Bun.write(join(repository, 'a.txt'), 'a\n');
  await spawnGitStream(['-C', repository, 'add', 'a.txt']);
});

afterEach(async () => {
  process.env = { ...savedEnv };
  await rm(repository, { recursive: true, force: true });
});

test('commit waits for a hook that outlasts the default timeout', async () => {
  await createGitService({ gitCommandRunner: runner }).commitChanges('feat: a', null);
  expect(await Bun.file(join(repository, 'hook-ran')).exists()).toBeTrue();
  expect((await runner(['rev-parse', '--verify', 'HEAD'])).text.trim()).toMatch(/^[0-9a-f]{40}$/);
});

const nap = ['-c', 'alias.nap=!sleep 0.4', 'nap'];

test('spawnGitStream timeoutMs 0 means no timeout', async () => {
  const started = Date.now();
  const result = await spawnGitStream(nap, { timeoutMs: 0 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  expect(result.truncated).toBeFalse();
});

test('spawnGitStream kills a command that exceeds timeoutMs', async () => {
  await expect(spawnGitStream(nap, { timeoutMs: 100 })).rejects.toThrow('timed out');
});

// Real stdout overflow (hook output goes to stderr, so it cannot reach the cap).
const flood = (marker: string): string[] => [
  '-c',
  `alias.flood=!head -c 200000 /dev/zero | tr "\\0" a; sleep 0.2; touch ${marker}`,
  'flood',
];

test('stdout above the cap with timeoutMs 0 is drained, not killed', async () => {
  const marker = join(repository, 'flood-finished');
  const result = await spawnGitStream(flood(marker), {
    timeoutMs: 0,
    maxBytes: 10,
    allowTruncated: true,
  });
  expect(result.truncated).toBeTrue();
  expect(result.text.length).toBeLessThan(200000);
  expect(await Bun.file(marker).exists()).toBeTrue();
});

test('stdout above the cap with a normal timeout kills the command', async () => {
  const marker = join(repository, 'flood-finished');
  const result = await spawnGitStream(flood(marker), {
    timeoutMs: 5000,
    maxBytes: 10,
    allowTruncated: true,
  });
  expect(result.truncated).toBeTrue();
  await Bun.sleep(500);
  expect(await Bun.file(marker).exists()).toBeFalse();
  await expect(spawnGitStream(flood(marker), { timeoutMs: 5000, maxBytes: 10 })).rejects.toThrow(
    'truncated',
  );
});
