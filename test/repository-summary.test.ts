import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { summarizeLargeDiff } from '../src/summarizer.js';
import { CONFIG } from '../gcm.config.js';

async function runGit(repository: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', '-C', repository, ...args], { stderr: 'pipe' });
  if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
}

test('repository summary keeps the default summarizeLargeDiff(files) contract', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-summary-'));
  const previousDirectory = process.cwd();
  try {
    await runGit(repository, ['init', '-q']);
    await runGit(repository, ['config', 'user.email', 'test@gcm.local']);
    await runGit(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, 'example.ts'), 'export const value = 1;\n');
    await runGit(repository, ['add', 'example.ts']);
    await runGit(repository, ['commit', '-qm', 'chore: base']);
    await writeFile(join(repository, 'example.ts'), 'export const value = 2;\n');
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
    spawnStreamImpl: async function (args) {
      calls.push({ args });
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
    { args: ['diff', '--staged', '-w', '--stat', '--stat-width=80'] },
    {
      args: ['diff', '--staged', '-w', '-U1', '--', 'example.ts'],
      options: { maxBytes: CONFIG.PER_FILE_BUFFER },
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
    ['diff', '--staged', '-w', '--stat', '--stat-width=80'],
    ['diff', '--staged', '-w', '-U0', '--', 'gcm.config.ts'],
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
        if (args.at(-1) === files[0]) throw new Error('read failed');
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
        const file = args.at(-1);
        await Bun.sleep(file === 'a.ts' ? 20 : 1);
        throw new Error(String(file));
      },
    }),
  ).rejects.toThrow('a.ts');
});
