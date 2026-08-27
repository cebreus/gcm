import { expect, test } from 'bun:test';
import { createGitService } from '../src/services/git-service.js';
import type { Logger } from '../src/logger.js';

const decoder = new TextDecoder();

async function runGit(
  repository: string,
  args: string[],
): Promise<{ text: string; truncated: boolean }> {
  const child = Bun.spawn({
    cmd: ['git', ...args],
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  if (exitCode !== 0) {
    throw new Error(decoder.decode(stderr));
  }
  return { text: decoder.decode(stdout), truncated: false };
}

async function runCommand(args: string[]): Promise<void> {
  const child = Bun.spawn({ cmd: args, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  if (exitCode !== 0) throw new Error(decoder.decode(stderr));
}

test('git service: warns when a pre-commit hook stages an extra path', async function () {
  const repository = `/tmp/gcm-pre-commit-${crypto.randomUUID()}`;
  const warnings: string[] = [];
  const logger: Logger = {
    log: function (level, message) {
      if (level === 'warn') warnings.push(message);
    },
  };

  try {
    await runCommand(['mkdir', '-p', repository]);
    await runGit(repository, ['init', '-q']);
    await runGit(repository, ['config', 'user.name', 'Test User']);
    await runGit(repository, ['config', 'user.email', 'test@example.com']);
    await Bun.write(`${repository}/analysed.txt`, 'before\n');
    await runGit(repository, ['add', 'analysed.txt']);
    await runGit(repository, ['commit', '-qm', 'chore: initial']);

    await Bun.write(`${repository}/analysed.txt`, 'after\n');
    await runGit(repository, ['add', 'analysed.txt']);
    await Bun.write(
      `${repository}/.git/hooks/pre-commit`,
      '#!/bin/sh\nprintf "extra\\n" > hook-added.txt\ngit add hook-added.txt\n',
    );
    await runCommand(['chmod', '+x', `${repository}/.git/hooks/pre-commit`]);

    const service = createGitService({
      gitCommandRunner: async function (args) {
        return await runGit(repository, args);
      },
    });
    const staged = await service.retrieveStagedChanges(null, logger);
    if (!staged?.snapshot) throw new Error('Expected staged snapshot.');

    await service.commitChanges('feat: analysed change', logger, { snapshot: staged.snapshot });

    expect((await runGit(repository, ['show', '--format=', '--name-only', 'HEAD'])).text).toContain(
      'hook-added.txt',
    );
    expect(warnings).toEqual([
      'Commit completed, but pre-commit hooks changed the committed tree after analysis. Paths that differ from the analysed snapshot: "hook-added.txt".',
    ]);
  } finally {
    await runCommand(['rm', '-rf', repository]);
  }
});

test('git service: rolls back a hook-modified amend! commit and keeps its files staged', async function () {
  const repository = `/tmp/gcm-reword-hook-${crypto.randomUUID()}`;
  try {
    await runCommand(['mkdir', '-p', repository]);
    await runGit(repository, ['init', '-q']);
    await runGit(repository, ['config', 'user.name', 'Test User']);
    await runGit(repository, ['config', 'user.email', 'test@example.com']);
    await Bun.write(`${repository}/analysed.txt`, 'content\n');
    await runGit(repository, ['add', 'analysed.txt']);
    await runGit(repository, ['commit', '-qm', 'chore: initial']);
    await Bun.write(
      `${repository}/.git/hooks/pre-commit`,
      '#!/bin/sh\nprintf "extra\\n" > hook-added.txt\ngit add hook-added.txt\n',
    );
    await runCommand(['chmod', '+x', `${repository}/.git/hooks/pre-commit`]);

    const service = createGitService({
      gitCommandRunner: async function (args) {
        return await runGit(repository, args);
      },
    });
    const target = await service.inspectCommitTarget('HEAD', null);
    const originalHead = (await runGit(repository, ['rev-parse', 'HEAD'])).text.trim();

    await expect(service.rewordCommit(target, 'fix: replacement', null)).rejects.toThrow(
      'amend! commit contains file changes',
    );

    expect((await runGit(repository, ['rev-parse', 'HEAD'])).text.trim()).toBe(originalHead);
    expect((await runGit(repository, ['diff', '--cached', '--name-only'])).text).toContain(
      'hook-added.txt',
    );
  } finally {
    await runCommand(['rm', '-rf', repository]);
  }
});

async function createRepository(repository: string): Promise<void> {
  await runCommand(['mkdir', '-p', repository]);
  await runGit(repository, ['init', '-q']);
  await runGit(repository, ['config', 'user.name', 'Test User']);
  await runGit(repository, ['config', 'user.email', 'test@example.com']);
  await Bun.write(`${repository}/file.txt`, 'content\n');
  await runGit(repository, ['add', 'file.txt']);
  await runGit(repository, ['commit', '-qm', 'chore: initial']);
}

test('git service: treats a commit as published when configured remotes have no tracking refs', async function () {
  const repository = `/tmp/gcm-unfetched-remote-${crypto.randomUUID()}`;
  try {
    await createRepository(repository);
    await runGit(repository, ['remote', 'add', 'origin', 'https://example.test/repository.git']);
    const service = createGitService({
      gitCommandRunner: async function (args) {
        return await runGit(repository, args);
      },
    });

    expect((await service.inspectCommitTarget('HEAD', null)).isPublished).toBe(true);
  } finally {
    await runCommand(['rm', '-rf', repository]);
  }
});

test('git service: treats a commit as unpublished when the repository has no remotes', async function () {
  const repository = `/tmp/gcm-local-remote-${crypto.randomUUID()}`;
  try {
    await createRepository(repository);
    const service = createGitService({
      gitCommandRunner: async function (args) {
        return await runGit(repository, args);
      },
    });

    expect((await service.inspectCommitTarget('HEAD', null)).isPublished).toBe(false);
  } finally {
    await runCommand(['rm', '-rf', repository]);
  }
});

test('git service: inspects independent commit facts concurrently', async function () {
  let active = 0;
  let peak = 0;
  const service = createGitService({
    gitCommandRunner: async function (args) {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(1);
      active -= 1;
      const command = args.join(' ');
      if (command === 'rev-parse --verify target^{commit}')
        return { text: 'target\n', truncated: false };
      if (command === 'rev-parse --verify HEAD^{commit}')
        return { text: 'head\n', truncated: false };
      if (command === 'log -1 --format=%s target')
        return { text: 'feat: target\n', truncated: false };
      if (command === 'log --format=%s target^')
        return { text: 'chore: parent\n', truncated: false };
      if (command === 'branch --remotes --contains target') return { text: '', truncated: false };
      if (command === 'remote') return { text: '', truncated: false };
      if (command === 'merge-base HEAD target') return { text: 'target\n', truncated: false };
      if (command === 'symbolic-ref --quiet HEAD')
        return { text: 'refs/heads/main\n', truncated: false };
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  const target = await service.inspectCommitTarget('target', null);

  expect(peak).toBeGreaterThan(1);
  expect(target).toMatchObject({
    hash: 'target',
    headHash: 'head',
    subject: 'feat: target',
    isHead: false,
    isPublished: false,
    isAncestorOfHead: true,
    isHeadDetached: false,
    hasParent: true,
    hasAmbiguousSubject: false,
  });
});
