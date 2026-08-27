import { expect, test } from 'bun:test';
import { createGeminiProvider } from '../src/gemini-provider.js';

test('Gemini model discovery retries after failure and caches success', async function () {
  const originalKey = process.env.GOOGLE_GEMINI_API_KEY;
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  let calls = 0;
  try {
    const provider = createGeminiProvider({
      logger: { log: function () {} },
      service: {
        generate: async function () {
          return null;
        },
      },
      listModels: async function () {
        calls += 1;
        if (calls === 1) throw new Error('temporary failure');
        return [
          {
            name: 'gemini-test',
            label: 'Gemini test',
            limits: { kind: 'separate', maxInputTokens: 1_000, maxOutputTokens: 100 },
          },
        ];
      },
    });

    await expect(provider.models()).rejects.toThrow('temporary failure');
    await expect(provider.models()).resolves.toHaveLength(1);
    await expect(provider.models()).resolves.toHaveLength(1);
    expect(calls).toBe(2);
  } finally {
    if (originalKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
    else process.env.GOOGLE_GEMINI_API_KEY = originalKey;
  }
});
