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

test('Gemini model discovery keeps stable text models only', async function () {
  const originalKey = process.env.GOOGLE_GEMINI_API_KEY;
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  try {
    const model = function (name: string) {
      return {
        name: `models/${name}`,
        label: name,
        limits: { kind: 'separate' as const, maxInputTokens: 1_000, maxOutputTokens: 100 },
      };
    };
    const provider = createGeminiProvider({
      logger: { log: function () {} },
      service: {
        generate: async function () {
          return null;
        },
      },
      listModels: async function () {
        return [
          model('gemini-2.5-flash'),
          model('gemini-3.1-pro-preview'),
          model('gemini-3.7-flash'),
          model('gemini-nano-banana-2.1'),
          model('gemini-omni-1.1-flash'),
          model('gemini-3.5-transcribe'),
        ];
      },
    });

    expect(
      (await provider.models()).map(function (model) {
        return model.name;
      }),
    ).toEqual(['gemini-3.7-flash']);
  } finally {
    if (originalKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
    else process.env.GOOGLE_GEMINI_API_KEY = originalKey;
  }
});
