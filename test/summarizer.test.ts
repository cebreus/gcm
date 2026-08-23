import { test, expect } from 'bun:test';
import { summarizeLargeDiff } from '../src/summarizer.ts';
import type { SpawnGitStreamResult, SpawnGitLinesResult } from '../src/git-utils.ts';
import { CONFIG } from '../gcm.config.ts';

async function spawnStreamImpl(): Promise<SpawnGitStreamResult> {
  return { text: ' 2 files changed\n', truncated: false };
}

async function spawnLinesImpl(args: string[]): Promise<SpawnGitLinesResult> {
  const file = args[args.length - 1];
  if (file.endsWith('.js')) {
    return {
      lines: ['@@ -1,2 +1,2 @@\n', '+console.log("hi")\n', '-console.log("ho")\n'],
      truncated: false,
    };
  }
  return { lines: ['@@ -1 +1 @@\n', '+.foo{color: red}\n'], truncated: false };
}

async function summarizerBasicTest(): Promise<void> {
  const stagedFiles = ['src/foo.js', 'styles/main.css'];
  const res = await summarizeLargeDiff(stagedFiles, {
    spawnLinesImpl,
    spawnStreamImpl,
  });
  expect(res.text).toContain('File: src/foo.js');
  expect(res.text).toContain('File: styles/main.css');
  console.log('  summarizerBasicTest -> passed');
}
test('summarizer: basic', summarizerBasicTest);

async function summarizerBinarySkipTest(): Promise<void> {
  async function spawnStreamImpl2(): Promise<SpawnGitStreamResult> {
    return { text: ' 3 files changed\n', truncated: false };
  }

  // spawnLinesImpl defined above will only return lines for .js files — .jpg/.heic are skipped
  const stagedFiles = ['images/pic.jpg', 'images/photo.heic', 'src/foo.js'];
  const res = await summarizeLargeDiff(stagedFiles, {
    spawnLinesImpl,
    spawnStreamImpl: spawnStreamImpl2,
  });
  expect(res.text).toContain('Skipped binary files (content omitted):');
  expect(res.text).toContain('images/pic.jpg');
  expect(res.text).toContain('images/photo.heic');
  expect(res.text).toContain('File: src/foo.js');
  console.log('  summarizerBinarySkipTest -> passed');
}
test('summarizer: binary files are skipped and summarised concisely', summarizerBinarySkipTest);

async function summarizerLargeSkipGroupTest(): Promise<void> {
  async function spawnStreamImpl3(): Promise<SpawnGitStreamResult> {
    return { text: ' 25 files changed\n', truncated: false };
  }

  // Create a lot of skipped files in the same folder to verify the per-folder cap
  const many = [] as string[];
  for (let i = 0; i < 20; i++) many.push(`assets/photos/event/image_${i}.jpg`);
  for (let i = 0; i < 3; i++) many.push(`assets/icons/icon_${i}.png`);
  many.push('src/foo.js');

  const res = await summarizeLargeDiff(many, {
    spawnLinesImpl,
    spawnStreamImpl: spawnStreamImpl3,
  });

  // We expect the large folder to be shown with a cap of 15 and a "... and X more" line
  expect(res.text).toContain('assets/photos/event/ (showing 15 of 20)');
  expect(res.text).toMatch(/\.\.\. and 5 more/);
  // small folder should list all
  expect(res.text).toContain('assets/icons/');
  console.log('  summarizerLargeSkipGroupTest -> passed');
}
test('summarizer: large skip groups are limited per-folder', summarizerLargeSkipGroupTest);

test('summarizer: accepts GCM_MAX_HUNKS=0', async () => {
  const script = `
    import { summarizeLargeDiff } from './src/summarizer.ts';
    const result = await summarizeLargeDiff(['src/example.ts'], {
      spawnStreamImpl: async () => ({ text: ' 1 file changed\\n', truncated: false }),
      spawnLinesImpl: async () => ({
        lines: ['@@ -1 +1 @@\\n', '+const example = true;\\n'],
        truncated: false,
      }),
    });
    if (result.numHunks !== 1) process.exit(1);
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, GCM_MAX_HUNKS: '0' },
  });

  expect(await child.exited).toBe(0);
});

test('summarizer: caps Unicode output by UTF-8 bytes', async () => {
  const originalLimit = CONFIG.CHILD_PROCESS_MAX_BUFFER;
  CONFIG.CHILD_PROCESS_MAX_BUFFER = 180;
  try {
    const result = await summarizeLargeDiff(['a.ts'], {
      spawnStreamImpl: async function () {
        return { text: '', truncated: false };
      },
      spawnLinesImpl: async function () {
        return { lines: ['@@ -1 +1 @@\n', `+${'ě'.repeat(40)}\n`], truncated: false };
      },
    });

    expect(result.text).not.toContain('ě');
    expect(result.text).toContain('files truncated by per-file buffer');
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(90);
  } finally {
    CONFIG.CHILD_PROCESS_MAX_BUFFER = originalLimit;
  }
});
