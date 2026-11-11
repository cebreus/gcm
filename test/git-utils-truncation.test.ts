import { test, expect } from 'bun:test';
import { spawnGitLines, spawnGitStream } from '../src/git-utils';

const maxBytes = 1024;
const singleWrite = "head -c 4000 /dev/zero | tr '\\0' 'a'";
const singleWriteLines = "head -c 4000 /dev/zero | tr '\\0' 'a' | fold -w 99";
const pacedWrites = "for i in $(seq 1 40); do printf '%099d\\n' 0; done";

test('git-utils: a single oversized write keeps exactly the first maxBytes', async () => {
  const res = await spawnGitStream(['-c', singleWrite], {
    maxBytes,
    execName: 'bash',
    allowTruncated: true,
  });
  expect(res.truncated).toBe(true);
  expect(res.text.length).toBe(maxBytes);
});

test('git-utils: many small writes keep exactly the first maxBytes', async () => {
  const res = await spawnGitStream(['-c', pacedWrites], {
    maxBytes,
    execName: 'bash',
    allowTruncated: true,
  });
  expect(res.truncated).toBe(true);
  expect(res.text.length).toBe(maxBytes);
  expect(res.text.startsWith('0')).toBe(true);
});

test('git-utils: spawnGitLines returns lines from a single oversized write', async () => {
  const res = await spawnGitLines(['-c', singleWriteLines], {
    maxBytes,
    execName: 'bash',
    allowTruncated: true,
  });
  expect(res.truncated).toBe(true);
  expect(res.lines.length).toBeGreaterThan(0);
});

test('git-utils: draining (timeoutMs 0) keeps exactly the first maxBytes', async () => {
  const res = await spawnGitStream(['-c', singleWrite], {
    maxBytes,
    execName: 'bash',
    timeoutMs: 0,
    allowTruncated: true,
  });
  expect(res.truncated).toBe(true);
  expect(res.text.length).toBe(maxBytes);
});
