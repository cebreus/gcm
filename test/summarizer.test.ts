import { test, expect } from 'bun:test';
import { summarizeLargeDiff } from '../src/summarizer.ts';
import type { SpawnGitStreamResult, SpawnGitLinesResult } from '../src/git-utils.ts';

async function spawnStreamImpl(_args: string[]): Promise<SpawnGitStreamResult> {
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
