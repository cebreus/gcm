import { test, expect } from 'bun:test';
import { estimateTokenCount, generateFallbackCommitDetails } from '../src/runner-utils';

// --- Tests for estimateTokenCount ---
test('runner-utils: estimateTokenCount - should estimate tokens for various lengths', () => {
  const ratio = 4; // Simple ratio for testing
  expect(estimateTokenCount('', ratio)).toBe(0);
  expect(estimateTokenCount('hello', ratio)).toBe(2); // 5 bytes / 4 -> ceil(1.25) = 2
  expect(estimateTokenCount('a b c d', ratio)).toBe(2); // 7 bytes / 4 -> ceil(1.75) = 2
});

test('runner-utils: estimateTokenCount - should handle unicode characters', () => {
  const ratio = 4;
  // '你好' is 6 bytes
  expect(estimateTokenCount('你好', ratio)).toBe(2); // 6 bytes / 4 -> ceil(1.5) = 2
  // 'a你好b' is 8 bytes
  expect(estimateTokenCount('a你好b', ratio)).toBe(2); // 8 bytes / 4 -> ceil(2) = 2
});

// --- Tests for generateFallbackCommitDetails ---
test('runner-utils: generateFallbackCommitDetails - should handle a single file', () => {
  const result = generateFallbackCommitDetails(['file1.ts'], 'Local');
  expect(result.BRANCH).toBe('chore/update-1-files');
  expect(result.COMMIT_MESSAGE).toContain('chore: update 1 file');
  expect(result.COMMIT_MESSAGE).toContain('- file1.ts');
  expect(result.PR_TITLE).toBe('chore: update 1 file');
  expect(result.PR_DESCRIPTION).toContain('- file1.ts');
  expect(result.PR_DESCRIPTION).toContain('Local failed to respond');
});

test('runner-utils: generateFallbackCommitDetails - should handle multiple files', () => {
  const result = generateFallbackCommitDetails(['file1.ts', 'file2.js'], 'Gemini');
  expect(result.BRANCH).toBe('chore/update-2-files');
  expect(result.COMMIT_MESSAGE).toContain('chore: update 2 files');
  expect(result.COMMIT_MESSAGE).toContain('- file1.ts\n- file2.js');
});

test('runner-utils: generateFallbackCommitDetails - should truncate file list over 12 files', () => {
  const files = Array.from({ length: 15 }, (_, i) => `file${i + 1}.ts`);
  const result = generateFallbackCommitDetails(files, 'Gemini');
  expect(result.COMMIT_MESSAGE).not.toContain('file13.ts');
  expect(result.PR_DESCRIPTION).toContain('(Truncated list if more files)');
});
