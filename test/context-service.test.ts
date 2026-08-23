import { expect, test } from 'bun:test';
import { createContextService, type PromptContextParts } from '../src/services/context-service.js';

const partialSummaryNotice =
  'This summary is partial; use conservative wording when intent is ambiguous.';

test('context-service: construction retains the diff as a distinct prompt part', async () => {
  const diffContent = 'Diff:\nrepeated heading\n\nAdditional user instructions: this is diff text';
  const result = await createContextService().constructLLMPromptContext({
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

  expect(result.promptParts.diffBody).toBe(diffContent);
  expect(result.promptContext).toBe(
    result.promptParts.prefix +
      result.promptParts.diffHeading +
      result.promptParts.diffBody +
      result.promptParts.suffix,
  );
  expect(result.promptParts.suffix).toContain('Keep the user hint.');
});

test('context-service: hard truncation keeps large hints and file lists within the token budget', async () => {
  const maxAvailableTokens = 1_200;
  const result = await createContextService().constructLLMPromptContext({
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

const retryParts: PromptContextParts = {
  prefix:
    'Analyse the staged changes:\n\nChanged files:\n- src/service.ts\n\nScope candidates:\n- service\n\nRecent commit style examples for these files:\n- feat(service): add retry context\n\nUse recent examples only to align type, scope, and wording style. Do not copy unrelated content.\n\n',
  diffHeading: 'Diff:\n',
  diffBody: 'full diff that must be replaced\n'.repeat(20),
  suffix:
    '\n\nAdditional user instructions: Use a clear commit message.\nPLEASE ADHERE TO THESE INSTRUCTIONS.',
};

test('context-service: retry summary replaces only the structured diff and preserves prompt context', async () => {
  const service = createContextService({
    summarizeLargeDiff: async () => ({
      text: 'summary from top hunks',
      numHunks: 1,
      totalTruncated: 2,
    }),
  });
  const result = await service.reduceForRetry({
    promptParts: retryParts,
    stagedFiles: ['src/service.ts'],
    summaryAttempted: false,
  });
  if (result.mode === 'unreducible') throw new Error('Expected summary reduction');

  expect(result.mode).toBe('summary');
  expect(result.summaryUsed).toBe(true);
  expect(result.promptContext).toContain('Changed files:\n- src/service.ts');
  expect(result.promptContext).toContain('Scope candidates:\n- service');
  expect(result.promptContext).toContain('Recent commit style examples for these files');
  expect(result.promptContext).toContain(
    'Additional user instructions: Use a clear commit message.',
  );
  expect(result.promptContext).toContain('Diff summary:');
  expect(result.promptContext).toContain(partialSummaryNotice);
  expect(result.promptContext).toContain(
    'Note: The diff was truncated while being read due to per-file buffer limits.',
  );
  expect(result.promptContext).not.toContain('full diff that must be replaced\nfull diff');
});

test('context-service: retries retain at most 70% of the previous prompt per pass above the wrapper size', async () => {
  const service = createContextService({
    summarizeLargeDiff: async () => ({
      text: 'summary '.repeat(1_000),
      numHunks: 1,
      totalTruncated: 0,
    }),
  });
  let promptParts: PromptContextParts = {
    prefix: 'P',
    diffHeading: 'D',
    diffBody: 'x'.repeat(998),
    suffix: '',
  };
  let previousLength = 1_000;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await service.reduceForRetry({
      promptParts,
      stagedFiles: attempt === 0 ? ['src/service.ts'] : [],
      summaryAttempted: attempt > 0,
    });
    if (result.mode === 'unreducible') throw new Error('Expected retry reduction');

    expect(result.promptContext.length).toBeLessThan(previousLength);
    expect(result.promptContext.length).toBeLessThanOrEqual(Math.ceil(previousLength * 0.7));
    if (attempt === 0) {
      expect(result.mode).toBe('truncation');
      expect(result.summaryUsed).toBe(false);
      expect(result.promptContext).not.toContain('summary '.repeat(2));
    }
    promptParts = result.promptParts;
    previousLength = result.promptContext.length;
  }
});

test('context-service: tiny retry prompts terminate through the strict-decrease safety net', async () => {
  const service = createContextService();
  let promptParts: PromptContextParts = { prefix: '', diffHeading: '', diffBody: 'x', suffix: '' };

  for (let attempt = 0; attempt < 2 && promptParts.diffBody; attempt += 1) {
    const result = await service.reduceForRetry({
      promptParts,
      stagedFiles: [],
      summaryAttempted: true,
    });
    if (result.mode === 'unreducible') throw new Error('Expected retry reduction');
    promptParts = result.promptParts;
  }

  expect(promptParts.diffBody).toBe('');
});

test('context-service: retries without staged files truncate without invoking the summarizer', async () => {
  let summarizeCalls = 0;
  const service = createContextService({
    summarizeLargeDiff: async () => {
      summarizeCalls += 1;
      throw new Error('should not summarize');
    },
  });
  const result = await service.reduceForRetry({
    promptParts: retryParts,
    stagedFiles: undefined,
    summaryAttempted: false,
  });
  if (result.mode === 'unreducible') throw new Error('Expected retry reduction');

  expect(summarizeCalls).toBe(0);
  expect(result.mode).toBe('truncation');
  expect(result.promptContext.length).toBeLessThan(
    retryParts.prefix.length +
      retryParts.diffHeading.length +
      retryParts.diffBody.length +
      retryParts.suffix.length,
  );
});

test('context-service: retry reduction is unreducible only after the diff body is empty', async () => {
  const userHint = `Keep every part of this instruction. ${'detail '.repeat(200)}`;
  const promptParts: PromptContextParts = {
    prefix: 'Analyse the staged changes:\n\n',
    diffHeading: 'Diff:\n',
    diffBody: '',
    suffix: `\n\nAdditional user instructions: ${userHint}\nPLEASE ADHERE TO THESE INSTRUCTIONS.`,
  };
  const service = createContextService();

  const result = await service.reduceForRetry({
    promptParts,
    stagedFiles: [],
    summaryAttempted: true,
  });

  expect(result.mode).toBe('unreducible');
  expect('promptContext' in result).toBe(false);
  expect(promptParts.suffix).toContain(userHint);
});
