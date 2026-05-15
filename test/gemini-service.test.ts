import { test, expect } from 'bun:test';
import { createGeminiService } from '../src/services/gemini-service';
import type { GeminiClient, GeminiResponse } from '../src/gemini-client';

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
    logger: { log: () => {}, flush: async () => {}, flushSync: () => {} } as any,
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
