import { test, expect } from 'bun:test';
import { parseGeminiOutput } from '../src/parser';
import type { Labels } from '../src/parser';

test('parser: parseGeminiOutput - should parse basic output correctly', () => {
  const sample =
    'branch: feat/add-thing\ncommit_message: feat(core): add thing\nPR_TITLE: feat(core): add thing\nPR_DESCRIPTION: Adds thing';
  const parsed: Labels = parseGeminiOutput(sample);
  expect(parsed.BRANCH).toBe('feat/add-thing');
  expect(parsed.COMMIT_MESSAGE).toBe('feat(core): add thing');
  expect(parsed.PR_TITLE).toBe('feat(core): add thing');
  expect(parsed.PR_DESCRIPTION).toBe('Adds thing');
});

test('parser: parseGeminiOutput - should throw on missing required fields', () => {
  expect(() => parseGeminiOutput('PR_TITLE: no branch')).toThrow(
    'LLM output missing required BRANCH or COMMIT_MESSAGE fields',
  );
  expect(() => parseGeminiOutput('BRANCH: feat/test')).toThrow(
    'LLM output missing required BRANCH or COMMIT_MESSAGE fields',
  );
});

test('parser: parseGeminiOutput - should handle unicode characters in messages', () => {
  const sample =
    'BRANCH: feat/unicode\nCOMMIT_MESSAGE: feat: přidat podporu pro ěščřžýáíé\nPR_TITLE: feat: unicode\nPR_DESCRIPTION: Unicode characters test.';
  const parsed = parseGeminiOutput(sample);
  expect(parsed.COMMIT_MESSAGE).toBe('feat: přidat podporu pro ěščřžýáíé');
});

test('parser: parseGeminiOutput - should handle very long commit messages', () => {
  // Create a long message with words so it can be wrapped properly
  const words = Array(200).fill('word').join(' '); // Create text with 200 words
  const longMessage = `feat: ${words}`;
  const sample = `BRANCH: feat/long-msg\nCOMMIT_MESSAGE: ${longMessage}\nPR_TITLE: Long message\nPR_DESCRIPTION: test`;
  const parsed = parseGeminiOutput(sample);
  // Formatting should wrap the message
  const lines = parsed.COMMIT_MESSAGE.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      expect(lines[i].length).toBeLessThanOrEqual(60);
    } else if (lines[i].trim().length > 0) {
      expect(lines[i].length).toBeLessThanOrEqual(80);
    }
  }
});

test('parser: parseGeminiOutput - should format commit message with body text', () => {
  const longBody = `feat: add very long feature description that exceeds the sixty character limit for the first line of a commit message\n\nThis is the body of the commit message that contains a very long line that definitely exceeds the eighty character limit and should be wrapped appropriately`;
  const sample = `BRANCH: feat/long-body\nCOMMIT_MESSAGE: ${longBody}\nPR_TITLE: Long body\nPR_DESCRIPTION: test`;
  const parsed = parseGeminiOutput(sample);
  const lines = parsed.COMMIT_MESSAGE.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      // First line max 60
      expect(lines[i].length).toBeLessThanOrEqual(60);
    } else if (lines[i].trim().length > 0) {
      // Body lines max 80
      expect(lines[i].length).toBeLessThanOrEqual(80);
    }
  }
});

test('parser: parseGeminiOutput - should throw on empty required label values', () => {
  const sample = 'BRANCH: feat/empty\nCOMMIT_MESSAGE: \nPR_TITLE: empty\nPR_DESCRIPTION: ';
  expect(() => parseGeminiOutput(sample)).toThrow(
    'LLM output missing required BRANCH or COMMIT_MESSAGE fields',
  );

  const sample2 = 'BRANCH: \nCOMMIT_MESSAGE: feat: valid\nPR_TITLE: empty\nPR_DESCRIPTION: ';
  expect(() => parseGeminiOutput(sample2)).toThrow(
    'LLM output missing required BRANCH or COMMIT_MESSAGE fields',
  );
});

test('parser: parseGeminiOutput - should handle multiple colons in label lines', () => {
  const sample =
    'BRANCH: feat/colon:test\nCOMMIT_MESSAGE: feat: foo:bar:baz\nPR_TITLE: Foo bar\nPR_DESCRIPTION: desc';
  const parsed = parseGeminiOutput(sample);
  expect(parsed.BRANCH).toBe('feat/colon:test');
  expect(parsed.COMMIT_MESSAGE).toBe('feat: foo:bar:baz');
});

test('parser: parseGeminiOutput - should handle Windows line endings (\\r\\n)', () => {
  const sample =
    'BRANCH: feat/crlf\r\nCOMMIT_MESSAGE: feat: crlf\r\nPR_TITLE: CRLF\r\nPR_DESCRIPTION: CRLF test.';
  const parsed = parseGeminiOutput(sample);
  expect(parsed.BRANCH).toBe('feat/crlf');
  expect(parsed.COMMIT_MESSAGE).toBe('feat: crlf');
});

test('parser: parseGeminiOutput - should not strictly enforce branch name format (only validate)', () => {
  const invalidBranch = 'feat/invalid branch name';
  const sample = `BRANCH: ${invalidBranch}\nCOMMIT_MESSAGE: feat: invalid branch\nPR_TITLE: Invalid branch\nPR_DESCRIPTION: desc`;
  const parsed = parseGeminiOutput(sample);
  expect(parsed.BRANCH).toBe(invalidBranch);
  // The function validates but does not throw, so this test ensures it doesn't break.
});
