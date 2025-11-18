import { test, expect } from 'bun:test';
import { parseGeminiOutput } from '../src/parser';
import type { Labels } from '../src/parser';

async function parserParseGeminiOutputTest(): Promise<void> {
  const sample =
    'branch: feat/add-thing\ncommit_message: feat(core): add thing\nPR_TITLE: feat(core): add thing\nPR_DESCRIPTION: Adds thing';
  const parsed: Labels = parseGeminiOutput(sample);
  expect(parsed.BRANCH).toBe('feat/add-thing');
  expect(parsed.COMMIT_MESSAGE).toContain('feat(core): add thing');

  // Missing fields should throw
  expect(() => parseGeminiOutput('PR_TITLE: no branch')).toThrow();
}
test('parser: parseGeminiOutput', parserParseGeminiOutputTest);
