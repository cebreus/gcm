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

    await service.commitChanges('feat: analysed change', logger, { snapshot: staged!.snapshot! });

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
