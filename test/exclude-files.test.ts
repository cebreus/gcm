import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli';
import { createCommitActionService } from '../src/commit-action-service';
import { spawnGitStream } from '../src/git-utils';
import { createGitService } from '../src/services/git-service';
import { shouldExcludeFile, filterExcludedFiles } from '../src/utils';

async function runGitInRepository(repository: string, args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: ['git', ...args],
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
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

test('exclude-files: excludes root and nested dist from staged and commit analysis by default', async () => {
  const calls: string[][] = [];
  const service = createGitService({
    gitCommandRunner: async args => {
      calls.push(args);
      if (args.includes('--name-only')) {
        return {
          text: 'src/app.ts\0dist/gcm\0packages/cli/dist/index.js\0',
          truncated: false,
        };
      }
      if (args[0] === 'write-tree') return { text: 'tree\n', truncated: false };
      if (args[0] === 'ls-files') {
        return {
          text: '100644 1111111111111111111111111111111111111111 0\tsrc/app.ts\0',
          truncated: false,
        };
      }
      return { text: 'diff', truncated: false };
    },
  });

  const staged = await service.retrieveStagedChanges(null, null);
  const committed = await service.retrieveStagedChanges('abc123', null);

  expect(staged?.stagedFiles).toEqual(['src/app.ts']);
  expect(staged?.excludedPaths).toEqual([]);
  expect(committed?.stagedFiles).toEqual(['src/app.ts']);
  expect(committed?.excludedPaths).toEqual([]);
  expect(calls).toContainEqual(['diff', '--staged', '-w', '--', ':(literal)src/app.ts']);
  expect(calls).toContainEqual([
    'show',
    '--first-parent',
    '-w',
    'abc123',
    '--',
    ':(literal)src/app.ts',
  ]);
});

test('exclude-files: diff requests only include non-excluded paths', async () => {
  const calls: string[][] = [];
  const service = createGitService({
    gitCommandRunner: async args => {
      calls.push(args);
      return {
        text: args.includes('--name-only') ? 'src/app.ts\n.env.local\n' : 'diff',
        truncated: false,
      };
    },
  });

  await service.retrieveStagedChanges(null, null, ['.env*']);

  expect(calls).toContainEqual(['diff', '--staged', '-w', '--', ':(literal)src/app.ts']);
});

test('exclude-files: carries excluded staged paths alongside the analysed snapshot', async () => {
  const service = createGitService({
    gitCommandRunner: async args => {
      if (args.includes('--name-only'))
        return { text: 'src/app.ts\nsecrets.txt\n', truncated: false };
      if (args[0] === 'write-tree') return { text: 'tree\n', truncated: false };
      if (args[0] === 'ls-files')
        return {
          text: '100644 1111111111111111111111111111111111111111 0\tsrc/app.ts\0',
          truncated: false,
        };
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
        return {
          text: '100644 1111111111111111111111111111111111111111 0\tsource.ts\0',
          truncated: false,
        };
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
    await runGitInRepository(repository, ['init', '-q']);
    await runGitInRepository(repository, ['config', 'user.email', 'test@gcm.local']);
    await runGitInRepository(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, excludedPath), 'secret\n');
    await writeFile(join(repository, includedPath), 'included\n');
    await runGitInRepository(repository, ['add', '--', excludedPath, includedPath]);

    const service = createGitService({
      gitCommandRunner: args => spawnGitStream(['-C', repository, ...args]),
    });
    const staged = await service.retrieveStagedChanges(null, null, [excludedPath]);

    expect(staged?.stagedFiles).toEqual([includedPath]);
    expect(staged?.excludedPaths).toEqual([excludedPath]);
    expect(staged?.stagedDiff).toContain('included');
    expect(staged?.stagedDiff).not.toContain('secret');

    await runGitInRepository(repository, ['commit', '-qm', 'Add special paths']);
    const hash = (await runGitInRepository(repository, ['rev-parse', 'HEAD'])).trim();
    const committed = await service.retrieveStagedChanges(hash, null, [excludedPath]);
    expect(committed?.stagedFiles).toEqual([includedPath]);
    expect(committed?.excludedPaths).toEqual([excludedPath]);
    expect(committed?.stagedDiff).toContain('included');
    expect(committed?.stagedDiff).not.toContain('secret');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('exclude-files: real GitService treats staged filenames as literal pathspecs', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-literal-pathspec-'));
  const magicPath = ':(exclude)*';
  try {
    await runGitInRepository(repository, ['init', '-q']);
    await writeFile(join(repository, 'source.ts'), 'ordinary content\n');
    await writeFile(join(repository, magicPath), 'magic filename content\n');
    await runGitInRepository(repository, [
      '--literal-pathspecs',
      'add',
      '--',
      'source.ts',
      magicPath,
    ]);

    const service = createGitService({
      gitCommandRunner: args => spawnGitStream(['-C', repository, ...args]),
    });
    const staged = await service.retrieveStagedChanges(null, null);

    expect(staged?.stagedFiles).toEqual([magicPath, 'source.ts']);
    expect(staged?.stagedDiff).toContain('ordinary content');
    expect(staged?.stagedDiff).toContain('magic filename content');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('exclude-files: real GitService reads root, ordinary, merge, octopus, and rename commits', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-commit-changes-'));
  const rootPath = 'žluťoučký.txt';
  const renamedPath = 'přejmenováno.txt';
  try {
    await runGitInRepository(repository, ['init', '-q', '-b', 'main']);
    await runGitInRepository(repository, ['config', 'user.email', 'test@gcm.local']);
    await runGitInRepository(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, rootPath), 'root\n');
    await runGitInRepository(repository, ['add', rootPath]);
    await runGitInRepository(repository, ['commit', '-qm', 'root']);
    const rootHash = (await runGitInRepository(repository, ['rev-parse', 'HEAD'])).trim();

    await runGitInRepository(repository, ['checkout', '-qb', 'feature']);
    await writeFile(join(repository, 'feature.txt'), 'feature\n');
    await runGitInRepository(repository, ['add', 'feature.txt']);
    await runGitInRepository(repository, ['commit', '-qm', 'feature']);
    await runGitInRepository(repository, ['checkout', 'main']);
    await writeFile(join(repository, 'main.txt'), 'main\n');
    await runGitInRepository(repository, ['add', 'main.txt']);
    await runGitInRepository(repository, ['commit', '-qm', 'ordinary']);
    const ordinaryHash = (await runGitInRepository(repository, ['rev-parse', 'HEAD'])).trim();
    await runGitInRepository(repository, ['merge', '--no-ff', 'feature', '-m', 'merge']);
    const mergeHash = (await runGitInRepository(repository, ['rev-parse', 'HEAD'])).trim();

    await runGitInRepository(repository, ['checkout', '-qb', 'octopus-a']);
    await writeFile(join(repository, 'a.txt'), 'a\n');
    await runGitInRepository(repository, ['add', 'a.txt']);
    await runGitInRepository(repository, ['commit', '-qm', 'a']);
    await runGitInRepository(repository, ['checkout', 'main']);
    await runGitInRepository(repository, ['checkout', '-qb', 'octopus-b']);
    await writeFile(join(repository, 'b.txt'), 'b\n');
    await runGitInRepository(repository, ['add', 'b.txt']);
    await runGitInRepository(repository, ['commit', '-qm', 'b']);
    await runGitInRepository(repository, ['checkout', 'main']);
    await runGitInRepository(repository, [
      'merge',
      '--no-ff',
      'octopus-a',
      'octopus-b',
      '-m',
      'octopus',
    ]);
    const octopusHash = (await runGitInRepository(repository, ['rev-parse', 'HEAD'])).trim();

    await runGitInRepository(repository, ['mv', rootPath, renamedPath]);
    await runGitInRepository(repository, ['commit', '-qm', 'rename']);
    const renameHash = (await runGitInRepository(repository, ['rev-parse', 'HEAD'])).trim();
    const service = createGitService({
      gitCommandRunner: args => spawnGitStream(['-C', repository, ...args]),
    });

    const rootResult = await service.retrieveStagedChanges(rootHash, null);
    const ordinaryResult = await service.retrieveStagedChanges(ordinaryHash, null);
    const mergeResult = await service.retrieveStagedChanges(mergeHash, null);
    const octopusResult = await service.retrieveStagedChanges(octopusHash, null);
    const renameResult = await service.retrieveStagedChanges(renameHash, null);
    if (!rootResult || !ordinaryResult || !mergeResult || !octopusResult || !renameResult) {
      throw new Error('Expected commit diffs');
    }
    expect(rootResult.stagedFiles).toEqual([rootPath]);
    expect(rootResult.stagedDiff).toContain('+root');
    expect(ordinaryResult.stagedFiles).toEqual(['main.txt']);
    expect(ordinaryResult.stagedDiff).toContain('+main');
    expect(mergeResult.stagedFiles).toEqual(['feature.txt']);
    expect(mergeResult.stagedDiff).toContain('+feature');
    expect(octopusResult.stagedFiles).toEqual(['a.txt', 'b.txt']);
    expect(octopusResult.stagedDiff).toContain('+a');
    expect(renameResult.stagedFiles).toEqual([renamedPath]);
    expect(renameResult.stagedDiff).toContain('+root');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('exclude-files: real GitService hides excluded staged and commit diff content', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-exclude-files-'));
  try {
    await runGitInRepository(repository, ['init', '-q']);
    await runGitInRepository(repository, ['config', 'user.email', 'test@gcm.local']);
    await runGitInRepository(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, 'source.ts'), 'export const value = 1;\n');
    await writeFile(join(repository, 'secrets.txt'), 'hunter2_should_never_leak\n');
    await runGitInRepository(repository, ['add', 'source.ts', 'secrets.txt']);

    const service = createGitService({
      gitCommandRunner: args => spawnGitStream(['-C', repository, ...args]),
    });

    const staged = await service.retrieveStagedChanges(null, null, ['secrets.txt']);
    expect(staged?.stagedFiles).toEqual(['source.ts']);
    expect(staged?.stagedDiff).not.toContain('hunter2_should_never_leak');

    await runGitInRepository(repository, ['commit', '-qm', 'Add staged files']);
    const hash = (await runGitInRepository(repository, ['rev-parse', 'HEAD'])).trim();
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
    await runGitInRepository(repository, ['init', '-q']);
    await runGitInRepository(repository, ['config', 'user.email', 'test@gcm.local']);
    await runGitInRepository(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, 'base.ts'), 'export const base = true;\n');
    await runGitInRepository(repository, ['add', 'base.ts']);
    await runGitInRepository(repository, ['commit', '-qm', 'chore: base']);
    await writeFile(join(repository, 'source.ts'), 'export const value = 1;\n');
    await writeFile(join(repository, 'secrets.txt'), 'hunter2_should_still_commit\n');
    await runGitInRepository(repository, ['add', 'source.ts', 'secrets.txt']);

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
    expect((await runGitInRepository(repository, ['rev-list', '--count', 'HEAD'])).trim()).toBe(
      '1',
    );

    await actions.apply({ ...capability, exclusionsAcknowledged: true }, 'feat: add source');
    expect(await runGitInRepository(repository, ['show', 'HEAD:secrets.txt'])).toBe(
      'hunter2_should_still_commit\n',
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
