import { test, expect, mock } from 'bun:test';
import {
  estimateTokens,
  buildUserContent,
  buildFallbackStructured,
  parseAndDisplay,
} from '../src/runner-utils';
import type { Labels } from '../src/parser';

// --- Tests for estimateTokens ---
test('runner-utils: estimateTokens - should estimate tokens for various lengths', () => {
  const ratio = 4; // Simple ratio for testing
  expect(estimateTokens('', ratio)).toBe(0);
  expect(estimateTokens('hello', ratio)).toBe(2); // 5 bytes / 4 -> ceil(1.25) = 2
  expect(estimateTokens('a b c d', ratio)).toBe(2); // 7 bytes / 4 -> ceil(1.75) = 2
});

test('runner-utils: estimateTokens - should handle unicode characters', () => {
  const ratio = 4;
  // '你好' is 6 bytes
  expect(estimateTokens('你好', ratio)).toBe(2); // 6 bytes / 4 -> ceil(1.5) = 2
  // 'a你好b' is 8 bytes
  expect(estimateTokens('a你好b', ratio)).toBe(2); // 8 bytes / 4 -> ceil(2) = 2
});

// --- Tests for buildUserContent ---
test('runner-utils: buildUserContent - should build content without truncation note', () => {
  const result = buildUserContent({
    input: 'test diff',
    promptSuffix: 'test suffix',
    truncated: false,
  });
  expect(result).toContain('based on the following test suffix');
  expect(result).toContain('test diff');
  expect(result).not.toContain('Note: The diff was truncated');
});

test('runner-utils: buildUserContent - should add truncation note when truncated is true', () => {
  const result = buildUserContent({
    input: 'test diff',
    promptSuffix: 'test suffix',
    truncated: true,
  });
  expect(result).toContain('Note: The diff was truncated');
});

test('runner-utils: buildUserContent - should handle different prompt suffixes', () => {
    const result1 = buildUserContent({ input: 'd1', promptSuffix: 'diff', truncated: false });
    expect(result1).toContain('based on the following diff');

    const result2 = buildUserContent({ input: 'd2', promptSuffix: 'summary and truncated diff', truncated: false });
    expect(result2).toContain('based on the following summary and truncated diff');
});


// --- Tests for buildFallbackStructured ---
test('runner-utils: buildFallbackStructured - should handle a single file', () => {
  const result = buildFallbackStructured(['file1.ts']);
  expect(result.BRANCH).toBe('chore/update-1-files');
  expect(result.COMMIT_MESSAGE).toContain('chore: update 1 file');
  expect(result.COMMIT_MESSAGE).toContain('- file1.ts');
  expect(result.PR_TITLE).toBe('chore: update 1 file');
  expect(result.PR_DESCRIPTION).toContain('- file1.ts');
});

test('runner-utils: buildFallbackStructured - should handle multiple files', () => {
  const result = buildFallbackStructured(['file1.ts', 'file2.js']);
  expect(result.BRANCH).toBe('chore/update-2-files');
  expect(result.COMMIT_MESSAGE).toContain('chore: update 2 files');
  expect(result.COMMIT_MESSAGE).toContain('- file1.ts\n- file2.js');
});

test('runner-utils: buildFallbackStructured - should truncate file list over 12 files', () => {
  const files = Array.from({ length: 15 }, (_, i) => `file${i + 1}.ts`);
  const result = buildFallbackStructured(files);
  expect(result.COMMIT_MESSAGE).not.toContain('file13.ts');
  expect(result.PR_DESCRIPTION).toContain('(Truncated list if more files)');
});

// --- Tests for parseAndDisplay ---
const mockDisplayStructured = mock((labels: Labels) => {});
const mockDisplayRaw = mock((text: string) => {});
const mockLogger = { log: mock(() => {}) };

test('runner-utils: parseAndDisplay - should call displayStructured on success', () => {
    // This raw text is a simplified version of what the parser expects
    const rawText = 'BRANCH: feat/test\nCOMMIT_MESSAGE: feat(test): my commit\nPR_TITLE: My PR\nPR_DESCRIPTION: desc';
    const result = parseAndDisplay(rawText, mockDisplayStructured, mockDisplayRaw, mockLogger as any);

    expect(result.parsed).toBe(true);
    expect(mockDisplayStructured).toHaveBeenCalled();
    expect(mockDisplayStructured.mock.calls[0][0]).toEqual({
        BRANCH: 'feat/test',
        COMMIT_MESSAGE: 'feat(test): my commit',
        PR_TITLE: 'My PR',
        PR_DESCRIPTION: 'desc',
    });
    expect(mockDisplayRaw).not.toHaveBeenCalled();
    expect(mockLogger.log).not.toHaveBeenCalled();
});

test('runner-utils: parseAndDisplay - should call displayRaw on failure', () => {
    mockDisplayStructured.mockClear();
    const rawText = 'just some raw text without labels';
    const result = parseAndDisplay(rawText, mockDisplayStructured, mockDisplayRaw, mockLogger as any);

    expect(result.parsed).toBe(false);
    expect(mockDisplayRaw).toHaveBeenCalledWith(rawText);
    expect(mockLogger.log).toHaveBeenCalledWith('warn', 'Failed to parse gemini output; printing raw output', expect.any(Object));
    expect(mockDisplayStructured).not.toHaveBeenCalled();
});
