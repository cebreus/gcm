import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli';
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
