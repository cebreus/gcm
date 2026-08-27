import { test, expect } from 'bun:test';
import { createGeminiService } from '../src/services/gemini-service';
import { createGeminiApiError } from '../src/gemini-client/errors';
import type { GeminiClient, GeminiResponse } from '../src/gemini-client';
import { createContextService } from '../src/services/context-service';
import type { PromptContextParts, RetryReductionResult } from '../src/services/context-service';
import type { Logger } from '../src/logger';

type RetryReductionInput = {
  promptParts: PromptContextParts;
  summaryAttempted: boolean;
};

type ReduceForRetry = (params: RetryReductionInput) => Promise<RetryReductionResult>;

const silentLogger: Logger = { log: () => undefined };
const noSleep = async function (): Promise<void> {
  await Promise.resolve();
};

async function geminiServiceReturnsTruncatedAtCapTest(): Promise<void> {
  let callCount = 0;
  const mockClient: GeminiClient = {
    async callGemini(): Promise<GeminiResponse> {
      callCount += 1;
      if (callCount === 1) {
        return {
          text: 'prefix <<START>>partial result...',
          usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 },
          truncated: true,
        };
      }
      return {
        text: 'prefix <<START>>full result<<END>>',
        usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 },
        truncated: false,
      };
    },
  };

  const service = createGeminiService({
    client: mockClient,
    logger: silentLogger,
    apiKey: 'fake',
  });
  const res = await service.generate({
    promptContext: 'ctx',
    systemPrompt: 'sys',
    reduceForRetry: async function () {
      return { mode: 'unreducible' };
    },
    meta: {},
    opts: {
      maxOutputTokensLimit: 8_192,
      modelOverride: 'gemini-3.1-pro-preview',
    },
  });
  expect(callCount).toBe(1);
  expect(res?.truncated).toBe(true);
}

test(
  'gemini-service: returns truncated output at the policy cap',
  geminiServiceReturnsTruncatedAtCapTest,
);

test('gemini-service: uses the configured output cap without speculative retry', async () => {
  const outputLimits: number[] = [];
  const service = createGeminiService({
    client: {
      callGemini: async function (params) {
        outputLimits.push(params.callOptions.maxOutputTokens ?? 0);
        return {
          text: outputLimits.length === 1 ? 'partial' : 'complete',
          usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 },
          truncated: outputLimits.length === 1,
        };
      },
    },
    logger: silentLogger,
    apiKey: 'fake',
    sleep: noSleep,
  });

  await service.generate({
    promptContext: 'ctx',
    systemPrompt: 'sys',
    reduceForRetry: async function () {
      return { mode: 'unreducible' };
    },
    meta: {},
    opts: {
      maxOutputTokensLimit: 8_192,
      modelOverride: 'gemini-3.1-pro-preview',
    },
  });

  expect(outputLimits).toEqual([8192]);
});

test('gemini-service: stops truncated output at the policy cap', async () => {
  let calls = 0;
  let reductions = 0;
  const service = createGeminiService({
    client: {
      callGemini: async function () {
        calls += 1;
        if (calls === 1) {
          return {
            text: 'partial',
            usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 },
            truncated: true,
          };
        }
        if (calls < 4) throw new Error('MAX_TOKENS');
        return {
          text: 'complete',
          usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 },
          truncated: false,
        };
      },
    },
    logger: silentLogger,
    apiKey: 'fake',
    sleep: noSleep,
  });

  const result = await service.generate({
    promptContext: 'ctx',
    systemPrompt: 'sys',
    reduceForRetry: async function () {
      reductions += 1;
      return {
        promptContext: `reduced ${reductions}`,
        promptParts: { prefix: '', diffHeading: '', diffBody: `reduced ${reductions}`, suffix: '' },
        mode: 'truncation',
        summaryAttempted: true,
        summaryUsed: false,
      };
    },
    meta: {},
    opts: {
      maxOutputTokensLimit: 8_192,
      modelOverride: 'gemini-3.1-pro-preview',
    },
  });

  expect(result?.text).toBe('partial');
  expect(result?.truncated).toBe(true);
  expect(reductions).toBe(0);
});

test('gemini-service: retry delegates context reduction to the call boundary', async () => {
  const promptParts: PromptContextParts = {
    prefix: 'Changed files:\n- src/service.ts\n\n',
    diffHeading: 'Diff:\n',
    diffBody: 'full diff',
    suffix: '\n\nAdditional user instructions: preserve this',
  };
  const reductions: Array<{
    promptParts: PromptContextParts;
    summaryAttempted: boolean;
  }> = [];
  const userContent: string[] = [];
  let calls = 0;
  const client: GeminiClient = {
    callGemini: async params => {
      calls += 1;
      userContent.push(params.userContent);
      if (calls === 1) throw new Error('MAX_TOKENS');
      return {
        text: 'result',
        usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 },
      };
    },
  };
  const service = createGeminiService({
    client,
    logger: silentLogger,
    apiKey: 'fake',
    sleep: noSleep,
  });

  await service.generate({
    promptContext: 'full context',
    promptParts,
    systemPrompt: 'system',
    meta: {},
    opts: { maxOutputTokensLimit: 8_192 },
    reduceForRetry: async (params: RetryReductionInput) => {
      reductions.push(params);
      return {
        promptContext: 'reduced context',
        promptParts: { prefix: '', diffHeading: '', diffBody: 'reduced context', suffix: '' },
        mode: 'truncation',
        summaryAttempted: true,
        summaryUsed: false,
      };
    },
  });

  expect(reductions).toEqual([{ promptParts, summaryAttempted: false }]);
  expect(userContent).toEqual([
    'Changed files:\n- src/service.ts\n\nDiff:\nfull diff\n\nAdditional user instructions: preserve this',
    'reduced context',
  ]);
});

test('gemini-service: keeps a construction summary and structured context on overflow retry', async () => {
  let summaryCalls = 0;
  const contextService = createContextService({
    summarizeLargeDiff: async () => {
      summaryCalls += 1;
      return { text: 'summary '.repeat(500), numHunks: 1, totalTruncated: 0 };
    },
  });
  const contextResult = await contextService.constructLLMPromptContext({
    diffContent: 'full diff '.repeat(2_000),
    promptSuffix: 'diff',
    maxAvailableTokens: 10_000,
    tokenBytesRatio: 1,
    stagedFiles: ['src/service.ts'],
    scopeSuggestions: ['service'],
    recentCommitSubjects: ['feat(service): preserve retry context'],
    logger: null,
    userHint: 'Keep this user instruction.',
  });
  const requests: string[] = [];
  let calls = 0;
  const service = createGeminiService({
    client: {
      callGemini: async params => {
        calls += 1;
        requests.push(params.userContent);
        if (calls === 1) throw new Error('MAX_TOKENS');
        return { text: 'result', usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 } };
      },
    },
    logger: silentLogger,
    apiKey: 'fake',
    sleep: noSleep,
  });

  await service.generate({
    promptContext: contextResult.promptContext,
    promptParts: contextResult.promptParts,
    summaryAttempted: contextResult.summaryAttempted,
    systemPrompt: 'system',
    meta: {},
    opts: { maxOutputTokensLimit: 8_192 },
    reduceForRetry: (params: RetryReductionInput) =>
      contextService.reduceForRetry({ ...params, stagedFiles: ['src/service.ts'] }),
  });

  expect(summaryCalls).toBe(1);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain('Changed files:\n- src/service.ts');
  expect(requests[1]).toContain('Scope candidates:\n- service');
  expect(requests[1]).toContain('Recent commit style examples for these files');
  expect(requests[1]).toContain('Additional user instructions: Keep this user instruction.');
});

test('gemini-service: retries after emptying a diff below an unreachable proportional target', async () => {
  const userHint = `Keep every part of this instruction. ${'detail '.repeat(200)}`;
  const promptParts: PromptContextParts = {
    prefix: 'Analyse the staged changes:\n\n',
    diffHeading: 'Diff:\n',
    diffBody: 'x'.repeat(40),
    suffix: `\n\nAdditional user instructions: ${userHint}\nPLEASE ADHERE TO THESE INSTRUCTIONS.`,
  };
  const requests: string[] = [];
  let calls = 0;
  const service = createGeminiService({
    client: {
      callGemini: async params => {
        calls += 1;
        requests.push(params.userContent);
        if (calls === 1) throw new Error('MAX_TOKENS');
        return { text: 'result', usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 } };
      },
    },
    logger: silentLogger,
    apiKey: 'fake',
    sleep: noSleep,
  });

  const initialPrompt =
    promptParts.prefix + promptParts.diffHeading + promptParts.diffBody + promptParts.suffix;
  await service.generate({
    promptContext: initialPrompt,
    promptParts,
    summaryAttempted: true,
    systemPrompt: 'system',
    meta: {},
    opts: { maxOutputTokensLimit: 8_192 },
    reduceForRetry: createContextService({
      summarizeLargeDiff: async function () {
        throw new Error('Summary was not expected');
      },
    }).reduceForRetry,
  });

  expect(promptParts.prefix.length + promptParts.suffix.length).toBeGreaterThan(
    Math.ceil(initialPrompt.length * 0.7),
  );
  expect(requests).toHaveLength(2);
  expect(requests[1].length).toBeLessThan(requests[0].length);
  expect(requests[1]).toBe(
    promptParts.prefix + 'Diff (input truncated to fit model context):\n' + promptParts.suffix,
  );
  expect(requests[1]).toContain(userHint);
});

test('gemini-service: retry mode selects its original delay and log message', async () => {
  for (const [mode, delay, message] of [
    ['summary', 200, 'switching to top-hunks summary and retrying'],
    ['truncation', 500, 'retrying with smaller input'],
  ] as const) {
    const delays: number[] = [];
    const messages: string[] = [];
    let calls = 0;
    const reduceForRetry: ReduceForRetry = async function () {
      const result: RetryReductionResult = {
        promptContext: 'retry context',
        promptParts: { prefix: '', diffHeading: '', diffBody: 'retry context', suffix: '' },
        mode,
        summaryAttempted: true,
        summaryUsed: mode === 'summary',
      };
      return result;
    };
    const service = createGeminiService({
      client: {
        callGemini: async () => {
          calls += 1;
          if (calls === 1) throw new Error('MAX_TOKENS');
          return { text: 'result', usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 } };
        },
      },
      logger: {
        log: (_level, logMessage) => messages.push(logMessage),
      },
      apiKey: 'fake',
      sleep: async milliseconds => {
        delays.push(milliseconds);
      },
    });

    await service.generate({
      promptContext: 'context',
      systemPrompt: 'system',
      meta: {},
      opts: { maxOutputTokensLimit: 8_192 },
      reduceForRetry,
    });

    expect(delays).toEqual([delay]);
    expect(messages).toContain(`Gemini returned MAX_TOKENS or no text; ${message}`);
  }
});

test('gemini-service: context overflow retry stays within the model output limit', async () => {
  const outputLimits: number[] = [];
  const service = createGeminiService({
    client: {
      callGemini: async function (params) {
        outputLimits.push(params.callOptions.maxOutputTokens ?? 0);
        if (outputLimits.length === 1) throw new Error('MAX_TOKENS');
        return { text: 'result', usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 } };
      },
    },
    logger: silentLogger,
    apiKey: 'fake',
    sleep: noSleep,
  });

  await service.generate({
    promptContext: 'context',
    systemPrompt: 'system',
    meta: {},
    opts: {
      maxOutputTokensLimit: 8_192,
      modelOverride: 'gemini-3.7-flash',
    },
    reduceForRetry: async function () {
      return {
        promptContext: 'smaller context',
        promptParts: { prefix: '', diffHeading: '', diffBody: 'smaller context', suffix: '' },
        mode: 'truncation',
        summaryAttempted: false,
        summaryUsed: false,
      };
    },
  });

  expect(outputLimits).toEqual([8192, 8192]);
});
test('gemini-service: normalizes provider errors', async () => {
  const service = createGeminiService({
    client: {
      callGemini: async function () {
        throw createGeminiApiError('quota', { status: 429 });
      },
    },
    logger: silentLogger,
    apiKey: 'fake',
  });

  await expect(
    service.generate({
      promptContext: 'prompt',
      systemPrompt: 'system',
      meta: {},
      opts: { maxOutputTokensLimit: 8_192 },
      reduceForRetry: async function () {
        throw new Error('not used');
      },
    }),
  ).rejects.toMatchObject({ name: 'LanguageModelApiError', metadata: { status: 429 } });
});
