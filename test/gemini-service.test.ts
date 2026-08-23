import { test, expect } from 'bun:test';
import { createGeminiService } from '../src/services/gemini-service';
import type { GeminiClient, GeminiResponse } from '../src/gemini-client';
import { createContextService } from '../src/services/context-service';
import type { ContextService, PromptContextParts } from '../src/services/context-service';

async function geminiServiceRetryOnTruncatedTest(): Promise<void> {
  let callCount = 0;
  const mockClient: Partial<GeminiClient> = {
    async callGemini(params: any) {
      callCount += 1;
      // Simulate client-side automatic retry when opts.retryIfTruncated is true
      if (callCount === 1) {
        if (params?.callOptions?.retryIfTruncated) {
          // pretend the client retried internally and returned a full result
          callCount += 1;
          return {
            text: 'prefix <<START>>full result<<END>>',
            usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 },
            truncated: false,
          } as unknown as GeminiResponse & { truncated?: boolean };
        }
        return {
          text: 'prefix <<START>>partial result...',
          usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 },
          truncated: true,
        } as unknown as GeminiResponse & { truncated?: boolean };
      }
      return {
        text: 'prefix <<START>>full result<<END>>',
        usage: { promptTokens: 1, outputTokens: 1, thinkingTokens: 0 },
        truncated: false,
      } as unknown as GeminiResponse & { truncated?: boolean };
    },
  };

  const service = createGeminiService({
    client: mockClient as GeminiClient,
    logger: { log: () => {} } as any,
    apiKey: 'fake',
  });
  const res = await service.callGeminiAPI({
    promptContext: 'ctx',
    systemPrompt: 'sys',
    stagedFiles: [],
    meta: {},
    opts: {
      retryIfTruncated: true,
      retryIfTruncatedMaxRetries: 2,
      retryIfTruncatedIncreaseTokens: 100,
    },
  });
  expect(callCount).toBeGreaterThanOrEqual(2);
  expect(res?.truncated).toBeFalsy();
}

test('gemini-service: retry passthrough on truncated responses', geminiServiceRetryOnTruncatedTest);

test('gemini-service: retry delegates context reduction to ContextService', async () => {
  const promptParts: PromptContextParts = {
    prefix: 'Changed files:\n- src/service.ts\n\n',
    diffHeading: 'Diff:\n',
    diffBody: 'full diff',
    suffix: '\n\nAdditional user instructions: preserve this',
  };
  const reductions: Array<{
    promptParts: PromptContextParts;
    stagedFiles?: string[];
    summaryAttempted: boolean;
  }> = [];
  const contextService: ContextService = {
    constructLLMPromptContext: async () => ({
      promptContext: '',
      promptParts,
      processedDiffContent: '',
      tokens: 0,
    }),
    reduceForRetry: async params => {
      reductions.push(params);
      return {
        promptContext: 'reduced context',
        promptParts: { prefix: '', diffHeading: '', diffBody: 'reduced context', suffix: '' },
        mode: 'truncation',
        summaryAttempted: true,
        summaryUsed: false,
      };
    },
  };
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
    logger: { log: () => {} },
    apiKey: 'fake',
    contextService,
  });

  await service.callGeminiAPI({
    promptContext: 'full context',
    promptParts,
    systemPrompt: 'system',
    stagedFiles: ['src/service.ts'],
    meta: {},
  });

  expect(reductions).toEqual([
    { promptParts, stagedFiles: ['src/service.ts'], summaryAttempted: false },
  ]);
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
    logger: { log: () => {} },
    apiKey: 'fake',
    contextService,
    sleep: async () => {},
  });

  await service.callGeminiAPI({
    promptContext: contextResult.promptContext,
    promptParts: contextResult.promptParts,
    summaryAttempted: contextResult.summaryAttempted,
    systemPrompt: 'system',
    stagedFiles: ['src/service.ts'],
    meta: {},
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
    logger: { log: () => {} },
    apiKey: 'fake',
    contextService: createContextService(),
    sleep: async () => {},
  });

  const initialPrompt =
    promptParts.prefix + promptParts.diffHeading + promptParts.diffBody + promptParts.suffix;
  await service.callGeminiAPI({
    promptContext: initialPrompt,
    promptParts,
    summaryAttempted: true,
    systemPrompt: 'system',
    stagedFiles: [],
    meta: {},
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
    ['truncation', 500, 'retrying with smaller input and lower maxOutputTokens'],
  ] as const) {
    const delays: number[] = [];
    const messages: string[] = [];
    let calls = 0;
    const contextService: ContextService = {
      constructLLMPromptContext: async () => ({
        promptContext: '',
        promptParts: { prefix: '', diffHeading: '', diffBody: '', suffix: '' },
        processedDiffContent: '',
        tokens: 0,
      }),
      reduceForRetry: async () => ({
        promptContext: 'retry context',
        promptParts: { prefix: '', diffHeading: '', diffBody: 'retry context', suffix: '' },
        mode,
        summaryAttempted: true,
        summaryUsed: mode === 'summary',
      }),
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
      contextService,
      sleep: async milliseconds => {
        delays.push(milliseconds);
      },
    });

    await service.callGeminiAPI({
      promptContext: 'context',
      systemPrompt: 'system',
      stagedFiles: ['src/service.ts'],
      meta: {},
    });

    expect(delays).toEqual([delay]);
    expect(messages).toContain(`Gemini returned MAX_TOKENS or no text; ${message}`);
  }
});
