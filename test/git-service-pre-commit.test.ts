import { expect, test } from 'bun:test';
import { createGitService } from '../src/services/git-service.js';
import type { Logger } from '../src/logger.js';

const decoder = new TextDecoder();

function runGit(repository: string, args: string[]): { text: string; truncated: boolean } {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: repository, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(decoder.decode(result.stderr));
  }
  return { text: decoder.decode(result.stdout), truncated: false };
}

function runCommand(args: string[]): void {
  const result = Bun.spawnSync({ cmd: args, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(decoder.decode(result.stderr));
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
    runCommand(['mkdir', '-p', repository]);
    runGit(repository, ['init', '-q']);
    runGit(repository, ['config', 'user.name', 'Test User']);
    runGit(repository, ['config', 'user.email', 'test@example.com']);
    await Bun.write(`${repository}/analysed.txt`, 'before\n');
    runGit(repository, ['add', 'analysed.txt']);
    runGit(repository, ['commit', '-qm', 'chore: initial']);

    await Bun.write(`${repository}/analysed.txt`, 'after\n');
    runGit(repository, ['add', 'analysed.txt']);
    await Bun.write(
      `${repository}/.git/hooks/pre-commit`,
      '#!/bin/sh\nprintf "extra\\n" > hook-added.txt\ngit add hook-added.txt\n',
    );
    runCommand(['chmod', '+x', `${repository}/.git/hooks/pre-commit`]);

    const service = createGitService({
      gitCommandRunner: async function (args) {
        return runGit(repository, args);
      },
    });
    const staged = await service.retrieveStagedChanges(null, logger);

    await service.commitChanges('feat: analysed change', logger, { snapshot: staged!.snapshot! });

    expect(runGit(repository, ['show', '--format=', '--name-only', 'HEAD']).text).toContain('hook-added.txt');
    expect(warnings).toEqual([
      'Commit completed, but pre-commit hooks changed the committed tree after analysis. Paths that differ from the analysed snapshot: "hook-added.txt".',
    ]);
  } finally {
    runCommand(['rm', '-rf', repository]);
  }
});
