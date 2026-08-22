import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli';
import { createCommitActionService } from '../src/commit-action-service';
import { spawnGitStream } from '../src/git-utils';
import { createGitService } from '../src/services/git-service';
import { shouldExcludeFile, filterExcludedFiles } from '../src/utils';

function runGitInRepository(repository: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

// Integration test for exclude patterns
test('exclude-files: should parse exclude patterns from CLI and filter files', () => {
  // Parse CLI arguments with exclude patterns
  const parsedArgs = parseArgs(['--exclude', '*manifest*,*lock*']);
  expect(parsedArgs.exclude).toEqual(['*manifest*', '*lock*']);

  // Filter files using parsed patterns
  const files = [
    'src/app.ts',
    'manifest.json',
    'package-lock.json',
    'src/manifest.ts',
    'package.json',
    'README.md',
  ];

  const filteredFiles = filterExcludedFiles(files, parsedArgs.exclude);
  expect(filteredFiles).toEqual(['src/app.ts', 'package.json', 'README.md']);
});

test('exclude-files: should support short flag -e', () => {
  const parsedArgs = parseArgs(['-e', '*test*']);
  expect(parsedArgs.exclude).toEqual(['*test*']);

  const files = ['src/app.ts', 'src/app.test.ts', 'src/test-utils.ts', 'src/utils.ts'];

  const filteredFiles = filterExcludedFiles(files, parsedArgs.exclude);
  expect(filteredFiles).toEqual(['src/app.ts', 'src/utils.ts']);
});

test('exclude-files: should handle multiple exclude flags with different patterns', () => {
  const parsedArgs = parseArgs([
    '--exclude',
    '*manifest*',
    '--exclude',
    '*lock*',
    '--exclude',
    'dist/*',
  ]);
  expect(parsedArgs.exclude).toEqual(['*manifest*', '*lock*', 'dist/*']);

  const files = [
    'src/app.ts',
    'manifest.json',
    'package-lock.json',
    'dist/index.js',
    'dist/app.js',
    'src/manifest.ts',
    'package.json',
  ];

  const filteredFiles = filterExcludedFiles(files, parsedArgs.exclude);
  expect(filteredFiles).toEqual(['src/app.ts', 'package.json']);
});

test('exclude-files: real-world scenario - excluding build and manifest files', () => {
  const parsedArgs = parseArgs(['--exclude', 'dist/*,build/*,*manifest*,*lock*']);

  const files = [
    'src/index.ts',
    'src/utils.ts',
    'dist/index.js',
    'dist/app.js',
    'build/output.txt',
    'manifest.json',
    'package-lock.json',
    'yarn.lock',
    'package.json',
    '.env.manifest',
    'src/.manifest',
  ];

  const filteredFiles = filterExcludedFiles(files, parsedArgs.exclude);
  expect(filteredFiles).toEqual(['src/index.ts', 'src/utils.ts', 'package.json']);
});

test('exclude-files: diff requests only include non-excluded paths', async () => {
  const calls: string[][] = [];
  const service = createGitService({
    gitCommandRunner: async args => {
      calls.push(args);
      return { text: args.includes('--name-only') ? 'src/app.ts\n.env.local\n' : 'diff', truncated: false };
    },
  });

  await service.retrieveStagedChanges(null, null, ['.env*']);

  expect(calls).toContainEqual(['diff', '--staged', '-w', '--', 'src/app.ts']);
});

test('exclude-files: carries excluded staged paths alongside the analysed snapshot', async () => {
  const service = createGitService({
    gitCommandRunner: async args => {
      if (args.includes('--name-only')) return { text: 'src/app.ts\nsecrets.txt\n', truncated: false };
      if (args[0] === 'write-tree') return { text: 'tree\n', truncated: false };
      if (args[0] === 'ls-files') return { text: '100644 1111111111111111111111111111111111111111 0\tsrc/app.ts\0', truncated: false };
      return { text: 'diff', truncated: false };
    },
  });

  const staged = await service.retrieveStagedChanges(null, null, ['secrets.txt']);

  expect(staged?.excludedPaths).toEqual(['secrets.txt']);
});

test('exclude-files: parses quoted and NUL-separated file-list fixtures as real paths', async () => {
  const quotedPath = 'žluťoučký.txt';
  const nulPath = ' leading space.txt';
  const quotedNulPath = '"quoted name"';
  const calls: string[][] = [];
  const service = createGitService({
    gitCommandRunner: async args => {
      calls.push(args);
      if (args.includes('--name-only')) {
        return {
          text: '"\\305\\276lu\\305\\245ou\\304\\215k\\303\\275.txt"\n',
          truncated: false,
        };
      }
      if (args[0] === 'write-tree') return { text: 'tree\n', truncated: false };
      if (args[0] === 'ls-files') return { text: '', truncated: false };
      return { text: 'diff', truncated: false };
    },
  });

  const quoted = await service.retrieveStagedChanges(null, null, [quotedPath]);
  expect(quoted).toBeNull();
  expect(calls[0]).toEqual(['diff', '--staged', '--name-only', '-z']);

  const nulService = createGitService({
    gitCommandRunner: async args => {
      if (args.includes('--name-only')) {
        return { text: `${nulPath}\0${quotedNulPath}\0source.ts\0`, truncated: false };
      }
      if (args[0] === 'write-tree') return { text: 'tree\n', truncated: false };
      if (args[0] === 'ls-files') return { text: '', truncated: false };
      return { text: 'diff', truncated: false };
    },
  });

  const nul = await nulService.retrieveStagedChanges(null, null, [nulPath, quotedNulPath]);
  expect(nul?.stagedFiles).toEqual(['source.ts']);
});

test('exclude-files: refuses a truncated staged file list', async () => {
  const calls: string[][] = [];
  const service = createGitService({
    gitCommandRunner: async args => {
      calls.push(args);
      if (args.includes('--name-only')) return { text: 'source.ts\0', truncated: true };
      if (args[0] === 'write-tree') return { text: 'tree\n', truncated: false };
      if (args[0] === 'ls-files') return { text: '', truncated: false };
      return { text: 'diff', truncated: false };
    },
  });

  await expect(service.retrieveStagedChanges(null, null)).rejects.toThrow(
    'File list output was truncated. Reduce the change set, then try again.',
  );
  expect(calls).toEqual([['diff', '--staged', '--name-only', '-z']]);
});

test('exclude-files: keeps a truncated staged diff as a warning', async () => {
  const logs: string[] = [];
  const service = createGitService({
    gitCommandRunner: async args => {
      if (args.includes('--name-only')) return { text: 'source.ts\0', truncated: false };
      if (args[0] === 'write-tree') return { text: 'tree\n', truncated: false };
      if (args[0] === 'ls-files') {
        return { text: '100644 1111111111111111111111111111111111111111 0\tsource.ts\0', truncated: false };
      }
      return { text: 'diff', truncated: true };
    },
  });

  const staged = await service.retrieveStagedChanges(null, {
    log: function (_level, message): void {
      logs.push(message);
    },
  });

  expect(staged?.truncated).toBe(true);
  expect(logs).toContain('Diff output was truncated due to size limits.');
});

test('exclude-files: real GitService excludes Unicode paths and keeps newline paths usable', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-unicode-files-'));
  const excludedPath = 'žluťoučký.txt';
  const includedPath = 'notes\nnext.txt';
  try {
    runGitInRepository(repository, ['init', '-q']);
    runGitInRepository(repository, ['config', 'user.email', 'test@gcm.local']);
    runGitInRepository(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, excludedPath), 'secret\n');
    await writeFile(join(repository, includedPath), 'included\n');
    runGitInRepository(repository, ['add', '--', excludedPath, includedPath]);

    const service = createGitService({
      gitCommandRunner: args => spawnGitStream(['-C', repository, ...args]),
    });
    const staged = await service.retrieveStagedChanges(null, null, [excludedPath]);

    expect(staged?.stagedFiles).toEqual([includedPath]);
    expect(staged?.excludedPaths).toEqual([excludedPath]);
    expect(staged?.stagedDiff).toContain('included');
    expect(staged?.stagedDiff).not.toContain('secret');

    runGitInRepository(repository, ['commit', '-qm', 'Add special paths']);
    const hash = runGitInRepository(repository, ['rev-parse', 'HEAD']).trim();
    const committed = await service.retrieveStagedChanges(hash, null, [excludedPath]);
    expect(committed?.stagedFiles).toEqual([includedPath]);
    expect(committed?.excludedPaths).toEqual([excludedPath]);
    expect(committed?.stagedDiff).toContain('included');
    expect(committed?.stagedDiff).not.toContain('secret');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('exclude-files: real GitService hides excluded staged and commit diff content', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-exclude-files-'));
  try {
    runGitInRepository(repository, ['init', '-q']);
    runGitInRepository(repository, ['config', 'user.email', 'test@gcm.local']);
    runGitInRepository(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, 'source.ts'), 'export const value = 1;\n');
    await writeFile(join(repository, 'secrets.txt'), 'hunter2_should_never_leak\n');
    runGitInRepository(repository, ['add', 'source.ts', 'secrets.txt']);

    const service = createGitService({
      gitCommandRunner: args => spawnGitStream(['-C', repository, ...args]),
    });

    const staged = await service.retrieveStagedChanges(null, null, ['secrets.txt']);
    expect(staged?.stagedFiles).toEqual(['source.ts']);
    expect(staged?.stagedDiff).not.toContain('hunter2_should_never_leak');

    runGitInRepository(repository, ['commit', '-qm', 'Add staged files']);
    const hash = runGitInRepository(repository, ['rev-parse', 'HEAD']).trim();
    const committed = await service.retrieveStagedChanges(hash, null, ['secrets.txt']);
    expect(committed?.stagedFiles).toEqual(['source.ts']);
    expect(committed?.stagedDiff).not.toContain('hunter2_should_never_leak');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('exclude-files: a real commit includes excluded paths only after acknowledgement', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-exclude-commit-'));
  try {
    runGitInRepository(repository, ['init', '-q']);
    runGitInRepository(repository, ['config', 'user.email', 'test@gcm.local']);
    runGitInRepository(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, 'base.ts'), 'export const base = true;\n');
    runGitInRepository(repository, ['add', 'base.ts']);
    runGitInRepository(repository, ['commit', '-qm', 'chore: base']);
    await writeFile(join(repository, 'source.ts'), 'export const value = 1;\n');
    await writeFile(join(repository, 'secrets.txt'), 'hunter2_should_still_commit\n');
    runGitInRepository(repository, ['add', 'source.ts', 'secrets.txt']);

    const gitService = createGitService({
      gitCommandRunner: args => spawnGitStream(['-C', repository, ...args]),
    });
    const actions = createCommitActionService({ gitService, logger: { log: function () {} } });
    const staged = await gitService.retrieveStagedChanges(null, null, ['secrets.txt']);
    if (!staged?.snapshot) throw new Error('Expected staged snapshot');
    const inspection = await actions.inspect(null, staged.snapshot);
    const capability = { ...inspection.capability, excludedPaths: staged.excludedPaths };

    await expect(actions.apply(capability, 'feat: add source')).rejects.toThrow(
      'Explicit confirmation is required before committing excluded staged paths',
    );
    expect(runGitInRepository(repository, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');

    await actions.apply({ ...capability, exclusionsAcknowledged: true }, 'feat: add source');
    expect(runGitInRepository(repository, ['show', 'HEAD:secrets.txt'])).toBe(
      'hunter2_should_still_commit\n',
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
