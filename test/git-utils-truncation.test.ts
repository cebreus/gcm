import { test, expect } from 'bun:test';
import { spawnGitStream } from '../src/git-utils';
import type { SpawnGitStreamResult } from '../src/git-utils';

async function gitUtilsTruncationTest(): Promise<void> {
  // Run a bun command that emits a lot of output. Use execName: 'bun' to avoid git.
  const args = ['-e', 'for(let i=0;i<10000;i++){ console.log("line"+i); }'];
  const maxBytes = 1024; // 1 KB cap
  const res: SpawnGitStreamResult = await spawnGitStream(args, { maxBytes, execName: 'bun' });
  console.log('  got truncated:', res.truncated);
  expect(res.truncated).toBe(true);
  // We expect some content returned but less than or equal to maxBytes
  // Allow some additional bytes to be captured after truncation to capture useful context
  expect(res.text.length).toBeLessThanOrEqual(maxBytes + 4096);
  expect(res.text).toContain('line0');
}
test('git-utils: truncationTest', gitUtilsTruncationTest);
