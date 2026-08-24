import { test, expect } from 'bun:test';
import { parseLanguageModelOutput } from '../src/parser';
import type { Labels } from '../src/parser';

test('parser: parseLanguageModelOutput - should parse basic output correctly', () => {
  const sample =
    'branch: feat/add-thing\ncommit_message: feat(core): add thing\nPR_TITLE: feat(core): add thing\nPR_DESCRIPTION: Adds thing';
  const parsed: Labels = parseLanguageModelOutput(sample);
  expect(parsed.BRANCH).toBe('feat/add-thing');
  expect(parsed.COMMIT_MESSAGE).toBe('feat(core): add thing');
  expect(parsed.PR_TITLE).toBe('feat(core): add thing');
  expect(parsed.PR_DESCRIPTION).toBe('Adds thing');
});

test('parser: parseLanguageModelOutput - should throw on missing required fields', () => {
  expect(() => parseLanguageModelOutput('PR_TITLE: no branch')).toThrow(
    'LLM output missing required BRANCH or COMMIT_MESSAGE fields',
  );
  expect(() => parseLanguageModelOutput('BRANCH: feat/test')).toThrow(
    'LLM output missing required BRANCH or COMMIT_MESSAGE fields',
  );
});

test('parser: parseLanguageModelOutput - should handle unicode characters in messages', () => {
  const sample =
    'BRANCH: feat/unicode\nCOMMIT_MESSAGE: feat: přidat podporu pro ěščřžýáíé\nPR_TITLE: feat: unicode\nPR_DESCRIPTION: Unicode characters test.';
  const parsed = parseLanguageModelOutput(sample);
  expect(parsed.COMMIT_MESSAGE).toBe('feat: přidat podporu pro ěščřžýáíé');
});

test('parser: parseLanguageModelOutput - should handle very long commit messages', () => {
  const words = Array(200).fill('word').join(' ');
  const longMessage = `feat: ${words}`;
  const sample = `BRANCH: feat/long-msg\nCOMMIT_MESSAGE: ${longMessage}\nPR_TITLE: Long message\nPR_DESCRIPTION: test`;
  const parsed = parseLanguageModelOutput(sample);
  expect(parsed.COMMIT_MESSAGE).toBe(longMessage);
});

test('parser: parseLanguageModelOutput - should format commit message with body text', () => {
  const longBody = `feat: add very long feature description that exceeds the sixty character limit for the first line of a commit message\n\nThis is the body of the commit message that contains a very long line that definitely exceeds the eighty character limit`;
  const sample = `BRANCH: feat/long-body\nCOMMIT_MESSAGE: ${longBody}\nPR_TITLE: Long body\nPR_DESCRIPTION: test`;
  const parsed = parseLanguageModelOutput(sample);
  expect(parsed.COMMIT_MESSAGE).toBe(longBody);
});

test('parser: parseLanguageModelOutput - should throw on empty required label values', () => {
  const sample = 'BRANCH: feat/empty\nCOMMIT_MESSAGE: \nPR_TITLE: empty\nPR_DESCRIPTION: ';
  expect(() => parseLanguageModelOutput(sample)).toThrow(
    'LLM output missing required BRANCH or COMMIT_MESSAGE fields',
  );

  const sample2 = 'BRANCH: \nCOMMIT_MESSAGE: feat: valid\nPR_TITLE: empty\nPR_DESCRIPTION: ';
  expect(() => parseLanguageModelOutput(sample2)).toThrow(
    'LLM output missing required BRANCH or COMMIT_MESSAGE fields',
  );
});

test('parser: parseLanguageModelOutput - should handle multiple colons in label lines', () => {
  const sample =
    'BRANCH: feat/colon:test\nCOMMIT_MESSAGE: feat: foo:bar:baz\nPR_TITLE: Foo bar\nPR_DESCRIPTION: desc';
  const parsed = parseLanguageModelOutput(sample);
  expect(parsed.BRANCH).toBe('feat/colon-test');
  expect(parsed.COMMIT_MESSAGE).toBe('feat: foo:bar:baz');
});

test('parser: parseLanguageModelOutput - should handle Windows line endings (\\r\\n)', () => {
  const sample =
    'BRANCH: feat/crlf\r\nCOMMIT_MESSAGE: feat: crlf\r\nPR_TITLE: CRLF\r\nPR_DESCRIPTION: CRLF test.';
  const parsed = parseLanguageModelOutput(sample);
  expect(parsed.BRANCH).toBe('feat/crlf');
  expect(parsed.COMMIT_MESSAGE).toBe('feat: crlf');
});

test('parser: parseLanguageModelOutput - should sanitize invalid branch names', () => {
  const invalidBranch = 'feat/invalid branch:name';
  const sample = `BRANCH: ${invalidBranch}\nCOMMIT_MESSAGE: feat: invalid branch\nPR_TITLE: Invalid branch\nPR_DESCRIPTION: desc`;
  const parsed = parseLanguageModelOutput(sample);
  expect(parsed.BRANCH).toBe('feat/invalid-branch-name');
});
