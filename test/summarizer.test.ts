import { test, expect } from 'bun:test';
import { summarizeDiff } from '../src/diff-summary.ts';
const policy = { enableHunkWeights: false, maxHunks: 40, maxOutputBytes: 1_000_000 };

function facts(file: string, lines: string[], truncated = false) {
  return { file, lines, truncated, skipped: false };
}

async function summarizerBasicTest(): Promise<void> {
  const res = summarizeDiff(
    ' 2 files changed\n',
    [
      facts('src/foo.js', ['@@ -1,2 +1,2 @@\n', '+console.log("hi")\n', '-console.log("ho")\n']),
      facts('styles/main.css', ['@@ -1 +1 @@\n', '+.foo{color: red}\n']),
    ],
    policy,
  );
  expect(res.text).toContain('File: src/foo.js');
  expect(res.text).toContain('File: styles/main.css');
  console.log('  summarizerBasicTest -> passed');
}
test('summarizer: basic', summarizerBasicTest);

async function summarizerBinarySkipTest(): Promise<void> {
  const res = summarizeDiff(
    ' 3 files changed\n',
    [
      { file: 'images/pic.jpg', lines: [], truncated: false, skipped: true },
      { file: 'images/photo.heic', lines: [], truncated: false, skipped: true },
      facts('src/foo.js', ['@@ -1 +1 @@\n', '+code\n']),
    ],
    policy,
  );
  expect(res.text).toContain('Skipped binary files (content omitted):');
  expect(res.text).toContain('images/pic.jpg');
  expect(res.text).toContain('images/photo.heic');
  expect(res.text).toContain('File: src/foo.js');
  console.log('  summarizerBinarySkipTest -> passed');
}
test('summarizer: binary files are skipped and summarised concisely', summarizerBinarySkipTest);

async function summarizerLargeSkipGroupTest(): Promise<void> {
  const many = [] as Array<ReturnType<typeof facts>>;
  for (let i = 0; i < 20; i++)
    many.push({
      file: `assets/photos/event/image_${i}.jpg`,
      lines: [],
      truncated: false,
      skipped: true,
    });
  for (let i = 0; i < 3; i++)
    many.push({ file: `assets/icons/icon_${i}.png`, lines: [], truncated: false, skipped: true });
  many.push(facts('src/foo.js', ['@@ -1 +1 @@\n', '+code\n']));
  const res = summarizeDiff(' 25 files changed\n', many, policy);

  // We expect the large folder to be shown with a cap of 15 and a "... and X more" line
  expect(res.text).toContain('assets/photos/event/ (showing 15 of 20)');
  expect(res.text).toMatch(/\.\.\. and 5 more/);
  // small folder should list all
  expect(res.text).toContain('assets/icons/');
  console.log('  summarizerLargeSkipGroupTest -> passed');
}
test('summarizer: large skip groups are limited per-folder', summarizerLargeSkipGroupTest);

test('summarizer: caps Unicode output by UTF-8 bytes', async () => {
  const result = summarizeDiff('', [facts('a.ts', ['@@ -1 +1 @@\n', `+${'ě'.repeat(40)}\n`])], {
    ...policy,
    maxOutputBytes: 90,
  });
  expect(result.text).not.toContain('ě');
  expect(result.text).toContain('files truncated by per-file buffer');
  expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(90);
});

test('summarizer: reports per-file truncation when every selected hunk fits', () => {
  const result = summarizeDiff(
    'one file changed',
    [facts('src/a.ts', ['@@ -1 +1 @@\n', '+value\n'], true)],
    policy,
  );
  expect(result.text).toContain('1 files truncated by per-file buffer');
});
