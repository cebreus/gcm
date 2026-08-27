import { test, expect } from 'bun:test';
import { spawnGitStream } from '../src/git-utils';
import type { SpawnGitStreamResult } from '../src/git-utils';

async function gitUtilsTruncationTest(): Promise<void> {
  // Generate large output using bash to ensure it's large enough to exceed 1KB
  const args = [
    '-c',
    'for i in {1..500}; do echo "line-$i-with-some-padding-to-make-it-longer"; done',
  ];
  const maxBytes = 1024; // 1 KB cap
  const res: SpawnGitStreamResult = await spawnGitStream(args, {
    maxBytes,
    execName: 'bash',
    allowTruncated: true,
  });
  console.log('  got truncated:', res.truncated);
  console.log('  actual length:', res.text.length);
  expect(res.truncated).toBe(true);
  // We expect some content returned but truncated around maxBytes
  // Allow some buffer for incomplete lines
  expect(res.text.length).toBeLessThanOrEqual(maxBytes + 2048);
  expect(res.text).toContain('line-1');
}
test('git-utils: truncationTest', gitUtilsTruncationTest);
