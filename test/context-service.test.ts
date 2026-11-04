import { expect, test } from 'bun:test';
import { createContextService } from '../src/services/context-service.js';

const partialSummaryNotice =
  'This summary is partial; use conservative wording when intent is ambiguous.';
const noSummary = async function () {
  throw new Error('Summary was not expected');
};

test('context-service: construction keeps the diff and the user hint in the prompt', async () => {
  const diffContent = 'Diff:\nrepeated heading\n\nAdditional user instructions: this is diff text';
  const result = await createContextService({
    summarizeLargeDiff: noSummary,
  }).constructLLMPromptContext({
    diffContent,
    promptSuffix: 'staged changes',
    maxAvailableTokens: 10_000,
    tokenBytesRatio: 1,
    stagedFiles: ['src/service.ts'],
    scopeSuggestions: ['service'],
    recentCommitSubjects: ['feat(service): retain context'],
    logger: null,
    userHint: 'Keep the user hint.',
  });

  expect(result.processedDiffContent).toBe(diffContent);
  expect(result.promptContext).toContain('Diff:\n' + diffContent);
  expect(result.promptContext).toContain('Keep the user hint.');
});

test('context-service: hard truncation keeps large hints and file lists within the token budget', async () => {
  const maxAvailableTokens = 1_200;
  const result = await createContextService({
    summarizeLargeDiff: async function () {
      return { text: 'summary '.repeat(1_000), numHunks: 1, totalTruncated: 0 };
    },
  }).constructLLMPromptContext({
    diffContent: 'diff',
    promptSuffix: 'staged changes',
    maxAvailableTokens,
    tokenBytesRatio: 1,
    stagedFiles: Array.from({ length: 8 }, (_, index) => `src/${'file-'.repeat(12)}${index}.ts`),
    scopeSuggestions: [],
    recentCommitSubjects: [],
    logger: null,
    userHint: 'hint '.repeat(1_000),
  });

  expect(result.tokens).toBeLessThanOrEqual(maxAvailableTokens);
});

test('context-service: hard truncation respects a UTF-8 byte budget', async () => {
  const maxAvailableTokens = 400;
  const result = await createContextService({
    summarizeLargeDiff: async function () {
      return { text: 'Žluťoučký 🚀 '.repeat(1_000), numHunks: 1, totalTruncated: 0 };
    },
  }).constructLLMPromptContext({
    diffContent: 'diff',
    promptSuffix: 'staged changes',
    maxAvailableTokens,
    tokenBytesRatio: 1,
    stagedFiles: ['src/žluťoučký.ts'],
    scopeSuggestions: [],
    recentCommitSubjects: [],
    logger: null,
    userHint: '🚀'.repeat(1_000),
  });

  expect(result.tokens).toBeLessThanOrEqual(maxAvailableTokens);
});

test('context service refuses an empty summary for a non-empty diff', async () => {
  const service = createContextService({
    summarizeLargeDiff: async function () {
      return { text: 'File changes summary:\n\n', numHunks: 0, totalTruncated: 0 };
    },
  });

  await expect(
    service.constructLLMPromptContext({
      diffContent: 'x'.repeat(100),
      promptSuffix: 'diff',
      maxAvailableTokens: 1,
      tokenBytesRatio: 1,
      stagedFiles: ['example.ts'],
      scopeSuggestions: [],
      logger: null,
      targetCommit: 'abc123',
    }),
  ).rejects.toThrow('Diff summary contains no evidence');
});

test('context service refuses a stats-only summary without content evidence', async () => {
  const service = createContextService({
    summarizeLargeDiff: async function () {
      return {
        text: 'File changes summary:\n example.ts | 2 +-',
        numHunks: 0,
        numSkippedFiles: 0,
        totalTruncated: 0,
      };
    },
  });

  await expect(
    service.constructLLMPromptContext({
      diffContent: 'changed content',
      promptSuffix: 'diff',
      maxAvailableTokens: 1,
      tokenBytesRatio: 1,
      stagedFiles: ['example.ts'],
      scopeSuggestions: [],
      logger: null,
    }),
  ).rejects.toThrow('Diff summary contains no evidence');
});
