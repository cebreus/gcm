import { expect, test } from 'bun:test';

import { loadConfig } from '../gcm.config.js';
import { createGeminiProvider } from '../src/gemini-provider.js';
import type { ModelSpec } from '../src/model-registry.js';

const MODELS: ModelSpec[] = [
  {
    name: 'models/gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    limits: {
      kind: 'separate',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 65_536,
    },
  },
];

function createGenerateParams(): Parameters<
  ReturnType<typeof createGeminiProvider>['service']['generate']
>[0] {
  return {
    promptContext: 'diff content',
    systemPrompt: 'system rules',
    meta: {},
    modelName: 'gemini-3.7-flash',
    maxOutputTokens: 8_192,
  };
}

test('Gemini generates over the OpenAI-compatible endpoint with bearer auth', async () => {
  const {
    env: { GOOGLE_GEMINI_API_KEY: originalKey },
  } = process;
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  const requests: Array<{
    url: string;
    authorization: string | null;
    body: unknown;
  }> = [];
  try {
    const provider = createGeminiProvider({
      config: loadConfig(process.env),
      logger: { log: function () {} },
      listModels: async function () {
        return MODELS;
      },
      fetchImpl: async function (input, init) {
        const headers = new Headers(init?.headers);
        requests.push({
          url: input instanceof Request ? input.url : input.toString(),
          authorization: headers.get('authorization'),
          body: JSON.parse(
            typeof init?.body === 'string' ? init.body : '',
          ) as unknown,
        });
        return Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'feat: ok' },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 3 },
        });
      },
    });

    const response = await provider.service.generate(createGenerateParams());

    expect(response).toEqual({
      text: 'feat: ok',
      usage: { promptTokens: 11, outputTokens: 3 },
      truncated: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
    expect(requests[0]?.authorization).toBe('Bearer test-key');
    expect(requests[0]?.body).toMatchObject({
      model: 'gemini-3.7-flash',
      max_tokens: 8_192,
      stream: false,
      messages: [
        { role: 'system', content: 'system rules' },
        { role: 'user', content: 'diff content' },
      ],
    });
  } finally {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_GEMINI_API_KEY;
    } else {
      process.env.GOOGLE_GEMINI_API_KEY = originalKey;
    }
  }
});

test('Gemini reports truncation when the model stops on length', async () => {
  const {
    env: { GOOGLE_GEMINI_API_KEY: originalKey },
  } = process;
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  try {
    const provider = createGeminiProvider({
      config: loadConfig(process.env),
      logger: { log: function () {} },
      listModels: async function () {
        return MODELS;
      },
      fetchImpl: async function () {
        return Response.json({
          choices: [
            {
              finish_reason: 'length',
              message: { role: 'assistant', content: 'feat: x' },
            },
          ],
          usage: {},
        });
      },
    });

    const response = await provider.service.generate(createGenerateParams());

    expect(response?.truncated).toBe(true);
  } finally {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_GEMINI_API_KEY;
    } else {
      process.env.GOOGLE_GEMINI_API_KEY = originalKey;
    }
  }
});

test('Gemini model discovery retries after failure and caches success', async () => {
  const {
    env: { GOOGLE_GEMINI_API_KEY: originalKey },
  } = process;
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  let calls = 0;
  try {
    const provider = createGeminiProvider({
      config: loadConfig(process.env),
      logger: { log: function () {} },
      service: {
        generate: async function () {
          return null;
        },
      },
      listModels: async function () {
        calls += 1;
        if (calls === 1) {
          throw new Error('temporary failure');
        }
        return [
          {
            name: 'gemini-test',
            label: 'Gemini test',
            limits: {
              kind: 'separate',
              maxInputTokens: 1_000,
              maxOutputTokens: 100,
            },
          },
        ];
      },
    });

    await expect(provider.models()).rejects.toThrow('temporary failure');
    await expect(provider.models()).resolves.toHaveLength(1);
    await expect(provider.models()).resolves.toHaveLength(1);
    expect(calls).toBe(2);
  } finally {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_GEMINI_API_KEY;
    } else {
      process.env.GOOGLE_GEMINI_API_KEY = originalKey;
    }
  }
});

test('Gemini model discovery keeps stable text models only', async () => {
  const {
    env: { GOOGLE_GEMINI_API_KEY: originalKey },
  } = process;
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  try {
    const model = function (name: string): ModelSpec {
      return {
        name: `models/${name}`,
        label: name,
        limits: {
          kind: 'separate' as const,
          maxInputTokens: 1_000,
          maxOutputTokens: 100,
        },
      };
    };
    const provider = createGeminiProvider({
      config: loadConfig(process.env),
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

    expect((await provider.models()).map((model) => model.name)).toEqual([
      'gemini-3.7-flash',
    ]);
  } finally {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_GEMINI_API_KEY;
    } else {
      process.env.GOOGLE_GEMINI_API_KEY = originalKey;
    }
  }
});

test('Gemini debug tracing never logs an unbounded response body', async () => {
  const {
    env: { GOOGLE_GEMINI_API_KEY: originalKey },
  } = process;
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  const logged: string[] = [];
  try {
    const provider = createGeminiProvider({
      config: loadConfig(process.env),
      logger: {
        log: function (
          _level: string,
          message: string,
          meta?: Record<string, unknown>,
        ) {
          if (message === 'Gemini API response') {
            logged.push(typeof meta?.body === 'string' ? meta.body : '');
          }
        },
      },
      debugApi: true,
      listModels: async function () {
        return MODELS;
      },
      fetchImpl: async function () {
        return new Response('x'.repeat(2 * 1024 * 1024), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await provider.service.generate(createGenerateParams()).catch(() => null);

    expect(logged).toHaveLength(1);
    expect(logged[0]?.length).toBeLessThanOrEqual(1024 * 1024);
  } finally {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_GEMINI_API_KEY;
    } else {
      process.env.GOOGLE_GEMINI_API_KEY = originalKey;
    }
  }
});

test.each(['length', 'max_tokens', 'MAX_TOKENS'])(
  'Gemini reports truncation for finish_reason %s',
  async (finishReason) => {
    const {
      env: { GOOGLE_GEMINI_API_KEY: originalKey },
    } = process;
    process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
    try {
      const provider = createGeminiProvider({
        config: loadConfig(process.env),
        logger: { log: function () {} },
        listModels: async function () {
          return MODELS;
        },
        fetchImpl: async function () {
          return Response.json({
            choices: [
              {
                finish_reason: finishReason,
                message: { role: 'assistant', content: 'feat: x' },
              },
            ],
            usage: {},
          });
        },
      });

      expect(
        (await provider.service.generate(createGenerateParams()))?.truncated,
      ).toBe(true);
    } finally {
      if (originalKey === undefined) {
        delete process.env.GOOGLE_GEMINI_API_KEY;
      } else {
        process.env.GOOGLE_GEMINI_API_KEY = originalKey;
      }
    }
  },
);
