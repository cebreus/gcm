import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { summarizeLargeDiff } from '../src/summarizer.js';
import { CONFIG } from '../gcm.config.js';

async function runGit(repository: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', '-C', repository, ...args], { stderr: 'pipe' });
  if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
}

async function readGit(repository: string, args: string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', repository, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
  return stdout;
}

test('repository summary keeps the default summarizeLargeDiff(files) contract', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-summary-'));
  const previousDirectory = process.cwd();
  try {
    await runGit(repository, ['init', '-q']);
    await runGit(repository, ['config', 'user.email', 'test@gcm.local']);
    await runGit(repository, ['config', 'user.name', 'GCM Test']);
    await Bun.write(join(repository, 'example.ts'), 'export const value = 1;\n');
    await runGit(repository, ['add', 'example.ts']);
    await runGit(repository, ['commit', '-qm', 'chore: base']);
    await Bun.write(join(repository, 'example.ts'), 'export const value = 2;\n');
    await runGit(repository, ['add', 'example.ts']);
    process.chdir(repository);

    const result = await summarizeLargeDiff(['example.ts']);

    expect(result.text).toContain('File: example.ts');
    expect(result.text).toContain('1 file changed');
  } finally {
    process.chdir(previousDirectory);
    await rm(repository, { recursive: true, force: true });
  }
});

test('repository summary keeps the injected summarizeLargeDiff(files, options) contract', async () => {
  const calls: Array<{ args: string[]; options?: Record<string, unknown> }> = [];
  const result = await summarizeLargeDiff(['example.ts'], {
    spawnStreamImpl: async function (args, options) {
      calls.push({ args, options });
      return { text: 'injected stat', truncated: false };
    },
    spawnLinesImpl: async function (args, options) {
      calls.push({ args, options });
      return { lines: ['@@ -1 +1 @@\n', '+injected\n'], truncated: false };
    },
  });

  expect(result.text).toContain('injected stat');
  expect(result.text).toContain('+injected');
  expect(calls).toEqual([
    {
      args: ['diff', '--staged', '-w', '--stat', '--stat-width=80', '--', ':(literal)example.ts'],
      options: { allowTruncated: true },
    },
    {
      args: ['diff', '--staged', '-w', '-U1', '--', ':(literal)example.ts'],
      options: { maxBytes: CONFIG.PER_FILE_BUFFER, allowTruncated: true },
    },
  ]);
});

test('repository summary owns config context and binary skip Git reads', async () => {
  const calls: string[][] = [];
  await summarizeLargeDiff(['gcm.config.ts', 'image.jpg'], {
    spawnStreamImpl: async function (args) {
      calls.push(args);
      return { text: '', truncated: false };
    },
    spawnLinesImpl: async function (args) {
      calls.push(args);
      return { lines: [], truncated: false };
    },
  });
  expect(calls).toEqual([
    [
      'diff',
      '--staged',
      '-w',
      '--stat',
      '--stat-width=80',
      '--',
      ':(literal)gcm.config.ts',
      ':(literal)image.jpg',
    ],
    ['diff', '--staged', '-w', '-U0', '--', ':(literal)gcm.config.ts'],
  ]);
});

test('repository summary bounds concurrent per-file Git reads', async () => {
  let active = 0;
  let peak = 0;
  const files = Array.from({ length: 12 }, function (_, index) {
    return `src/file-${index}.ts`;
  });

  await summarizeLargeDiff(files, {
    spawnStreamImpl: async function () {
      return { text: '', truncated: false };
    },
    spawnLinesImpl: async function () {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(1);
      active -= 1;
      return { lines: [], truncated: false };
    },
  });

  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
});

test('repository summary stops scheduling file reads after the first failure', async () => {
  let calls = 0;
  const files = Array.from({ length: 20 }, function (_, index) {
    return `src/file-${index}.ts`;
  });

  await expect(
    summarizeLargeDiff(files, {
      spawnStreamImpl: async function () {
        return { text: '', truncated: false };
      },
      spawnLinesImpl: async function (args) {
        calls += 1;
        if (args.at(-1) === `:(literal)${files[0]}`) throw new Error('read failed');
        await Bun.sleep(1);
        return { lines: [], truncated: false };
      },
    }),
  ).rejects.toThrow('read failed');
  await Bun.sleep(20);

  expect(calls).toBeLessThanOrEqual(8);
});

test('repository summary preserves staged-file error order', async () => {
  await expect(
    summarizeLargeDiff(['a.ts', 'b.ts'], {
      spawnStreamImpl: async function () {
        return { text: '', truncated: false };
      },
      spawnLinesImpl: async function (args) {
        const file = args.at(-1)?.replace(/^:\(literal\)/, '');
        await Bun.sleep(file === 'a.ts' ? 20 : 1);
        throw new Error(String(file));
      },
    }),
  ).rejects.toThrow('a.ts');
});

test('repository summary reads the target commit instead of the staged index', async () => {
  const calls: string[][] = [];
  await summarizeLargeDiff(['example.ts'], {
    targetCommit: 'abc123',
    spawnStreamImpl: async function (args) {
      calls.push(args);
      return { text: '1 file changed', truncated: false };
    },
    spawnLinesImpl: async function (args) {
      calls.push(args);
      return { lines: ['@@ -1 +1 @@', '+changed'], truncated: false };
    },
  });

  expect(calls).toEqual([
    [
      'show',
      '--first-parent',
      '--format=',
      '-w',
      '--stat',
      '--stat-width=80',
      'abc123',
      '--',
      ':(literal)example.ts',
    ],
    ['show', '--first-parent', '--format=', '-w', '-U1', 'abc123', '--', ':(literal)example.ts'],
  ]);
});

test('repository summary excludes dist from target stats and diff', async function () {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-summary-target-'));
  const previousDirectory = process.cwd();
  try {
    await runGit(repository, ['init', '-q']);
    await runGit(repository, ['config', 'user.email', 'test.local']);
    await runGit(repository, ['config', 'user.name', 'GCM Test']);
    await mkdir(join(repository, 'src'));
    await mkdir(join(repository, 'dist'));
    await Bun.write(join(repository, 'src/app.ts'), 'export const value = 1;\n');
    await Bun.write(join(repository, 'dist/gcm'), 'old build\n');
    await runGit(repository, ['add', '.']);
    await runGit(repository, ['commit', '-qm', 'chore: base']);
    await Bun.write(join(repository, 'src/app.ts'), 'export const value = 2;\n');
    await Bun.write(join(repository, 'dist/gcm'), 'DIST_MARKER\n');
    await runGit(repository, ['add', '.']);
    await runGit(repository, ['commit', '-qm', 'feat: change app']);
    const targetCommit = (await readGit(repository, ['rev-parse', 'HEAD'])).trim();
    process.chdir(repository);

    const result = await summarizeLargeDiff(['src/app.ts'], { targetCommit });

    expect(result.text).toContain('src/app.ts');
    expect(result.text).not.toContain('dist/gcm');
    expect(result.text).not.toContain('DIST_MARKER');
  } finally {
    process.chdir(previousDirectory);
    await rm(repository, { recursive: true, force: true });
  }
});

test('repository summary recognises Git binary markers without relying on extensions', async () => {
  const result = await summarizeLargeDiff(['asset'], {
    spawnStreamImpl: async function () {
      return { text: ' asset | Bin 0 -> 10 bytes', truncated: false };
    },
    spawnLinesImpl: async function () {
      return { lines: ['Binary files /dev/null and b/asset differ\n'], truncated: false };
    },
  });

  expect(result.numSkippedFiles).toBe(1);
  expect(result.text).toContain('asset');
});

test('repository summary reports truncated file statistics', async () => {
  const result = await summarizeLargeDiff(['example.ts'], {
    spawnStreamImpl: async function () {
      return { text: 'partial stats', truncated: true };
    },
    spawnLinesImpl: async function () {
      return { lines: ['@@ -1 +1 @@\n', '+complete diff\n'], truncated: false };
    },
  });

  expect(result.text).toContain('file statistics truncated by output limit');
});
