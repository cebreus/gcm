import { expect, test } from 'bun:test';

import { loadConfig } from '../gcm.config.js';
import { isLanguageModelApiError } from '../src/language-model-service.js';
import { createLmStudioProvider as createLmStudioProviderWithConfig } from '../src/lm-studio-provider.js';

const CONFIG = loadConfig({});

async function createLmStudioProvider(
  options: Omit<
    Parameters<typeof createLmStudioProviderWithConfig>[0],
    'config'
  >,
): Promise<Awaited<ReturnType<typeof createLmStudioProviderWithConfig>>> {
  return await createLmStudioProviderWithConfig({ ...options, config: CONFIG });
}

function createGenerateParams(): Parameters<
  Awaited<ReturnType<typeof createLmStudioProvider>>['service']['generate']
>[0] {
  return {
    promptContext: 'diff content',
    systemPrompt: 'system rules',
    meta: {},
    modelName: 'local-model',
    maxOutputTokens: 8_192,
  };
}

test('LM Studio rejects a non-loopback server URL', async () => {
  await expect(
    createLmStudioProvider({ baseUrl: 'http://example.com:1234' }),
  ).rejects.toThrow('LM Studio URL must use a loopback hostname');
});

test.each([
  'https://127.0.0.1:1234',
  'http://user:password@127.0.0.1:1234',
  'http://127.0.0.1:1234?mode=unsafe',
  'http://127.0.0.1:1234#fragment',
  'http://127.0.0.1:1234?',
  'http://127.0.0.1:1234#',
  'http://2130706433:1234',
  'http://0177.0.0.1:1234',
])('LM Studio rejects unsafe server URL %s', async (baseUrl) => {
  await expect(createLmStudioProvider({ baseUrl })).rejects.toThrow(
    'Invalid LM Studio URL',
  );
});

test('LM Studio discovers sorted text models and uses the active context length', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json({
        models: [
          { key: 'embed', type: 'embedding', max_context_length: 4096 },
          {
            key: 'zeta',
            type: 'llm',
            display_name: 'Zeta',
            max_context_length: 32_768,
            loaded_instances: [
              { config: { context_length: 16_384 } },
              { config: { context_length: 8_192 } },
            ],
          },
          { key: 'alpha', type: 'llm', max_context_length: 16_384 },
        ],
      });
    },
  });
  try {
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
    });

    expect(provider.defaultModel).toBe('zeta');
    expect((await provider.models()).map((model) => model.name)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(
      (await provider.models()).find((model) => model.name === 'zeta'),
    ).toEqual({
      name: 'zeta',
      label: 'Zeta',
      limits: { kind: 'shared-context' as const, contextWindowTokens: 8_192 },
    });
    expect(
      (await provider.models()).find((model) => model.name === 'alpha'),
    ).toEqual({
      name: 'alpha',
      label: 'alpha',
      limits: { kind: 'shared-context' as const, contextWindowTokens: 16_384 },
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio loads an explicit unloaded model, waits, and refreshes its context', async () => {
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
  }> = [];
  let loaded = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async function (request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get('authorization'),
      });
      if (request.method === 'POST') {
        expect(await request.json()).toEqual({ model: 'preferred-model' });
        loaded = true;
        return Response.json({
          type: 'llm',
          instance_id: 'preferred-model',
          status: 'loaded',
          load_time_seconds: 1,
        });
      }
      return Response.json({
        models: [
          {
            key: 'preferred-model',
            type: 'llm',
            max_context_length: 32_768,
            loaded_instances: loaded
              ? [{ config: { context_length: 32_768 } }]
              : [],
          },
        ],
      });
    },
  });
  try {
    const probe = await createLmStudioProvider({
      baseUrl: server.url.origin,
      model: 'preferred-model',
      token: 'local-token',
      probeOnly: true,
    });
    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/api/v1/models',
        authorization: 'Bearer local-token',
      },
    ]);
    expect(probe.defaultModel).toBe('preferred-model');

    requests.length = 0;
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
      model: 'preferred-model',
      token: 'local-token',
    });

    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/api/v1/models',
        authorization: 'Bearer local-token',
      },
      {
        method: 'POST',
        path: '/api/v1/models/load',
        authorization: 'Bearer local-token',
      },
      {
        method: 'GET',
        path: '/api/v1/models',
        authorization: 'Bearer local-token',
      },
    ]);
    expect(provider.defaultModel).toBe('preferred-model');
    expect(
      (await provider.models()).find(
        (model) => model.name === 'preferred-model',
      )?.limits,
    ).toEqual({ kind: 'shared-context', contextWindowTokens: 32_768 });

    requests.length = 0;
    await createLmStudioProvider({
      baseUrl: server.url.origin,
      model: 'preferred-model',
      token: 'local-token',
    });
    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/api/v1/models',
        authorization: 'Bearer local-token',
      },
    ]);
  } finally {
    await server.stop(true);
  }
});

function catalogueServer(
  models: Array<{ key: string; loaded: boolean }>,
  loadStatus = 200,
): { server: ReturnType<typeof Bun.serve>; posts: unknown[] } {
  const posts: unknown[] = [];
  const loadedKeys = new Set(models.filter((m) => m.loaded).map((m) => m.key));
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async function (request) {
      if (request.method === 'POST') {
        const body = (await request.json()) as { model: string };
        posts.push(body);
        if (loadStatus !== 200) {
          return Response.json(
            { error: 'load failed' },
            { status: loadStatus },
          );
        }
        loadedKeys.add(body.model);
        return Response.json({ type: 'llm', status: 'loaded' });
      }
      return Response.json({
        models: models.map((m) => ({
          key: m.key,
          type: 'llm',
          max_context_length: 8_192,
          loaded_instances: loadedKeys.has(m.key)
            ? [{ config: { context_length: 8_192 } }]
            : [],
        })),
      });
    },
  });
  return { server, posts };
}

test('LM Studio defaults to the already loaded model without a load request', async () => {
  const { server, posts } = catalogueServer([
    { key: 'alpha', loaded: false },
    { key: 'beta', loaded: true },
  ]);
  try {
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
    });
    expect(provider.defaultModel).toBe('beta');
    expect(posts).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test('LM Studio loads the first catalogue model when none is loaded', async () => {
  const { server, posts } = catalogueServer([
    { key: 'beta', loaded: false },
    { key: 'alpha', loaded: false },
  ]);
  try {
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
    });
    expect(provider.defaultModel).toBe('alpha');
    expect(posts).toEqual([{ model: 'alpha' }]);
  } finally {
    await server.stop(true);
  }
});

test('LM Studio surfaces the load error of the first catalogue model', async () => {
  const { server } = catalogueServer([{ key: 'alpha', loaded: false }], 500);
  try {
    await expect(
      createLmStudioProvider({ baseUrl: server.url.origin }),
    ).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});

test('LM Studio gives no preference to Gemma over a loaded model', async () => {
  const { server, posts } = catalogueServer([
    { key: 'gemma-4-e4b-it-mlx', loaded: false },
    { key: 'qwen', loaded: true },
  ]);
  try {
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
    });
    expect(provider.defaultModel).toBe('qwen');
    expect(posts).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test('LM Studio rejects an unavailable explicitly configured model', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json({
        models: [{ key: 'available', type: 'llm', max_context_length: 8_192 }],
      });
    },
  });
  try {
    await expect(
      createLmStudioProvider({ baseUrl: server.url.origin, model: 'missing' }),
    ).rejects.toThrow('Configured LM Studio model is not available');
  } finally {
    await server.stop(true);
  }
});

test('LM Studio maps chat requests and responses without putting its token in the URL', async () => {
  const requests: Array<{
    url: string;
    authorization: string | null;
    body?: unknown;
  }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async function (request) {
      requests.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        body: request.method === 'POST' ? await request.json() : undefined,
      });
      if (request.method === 'GET') {
        return Response.json({
          models: [
            {
              key: 'local-model',
              type: 'llm',
              max_context_length: 16_384,
              loaded_instances: [{ config: { context_length: 16_384 } }],
            },
          ],
        });
      }
      return Response.json({
        choices: [
          {
            message: {
              content:
                'test: use LM Studio local-secret-token sk-abcdefghijklmnopqrstuvwxyz1234567890 token=opaque-value',
            },
            finish_reason: 'length',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    },
  });
  try {
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
      token: 'local-secret-token',
    });
    const response = await provider.service.generate({
      ...createGenerateParams(),
      promptContext: 'diff local-secret-token',
      systemPrompt: 'rules local-secret-token',
    });

    expect(
      requests.every((request) => !request.url.includes('local-secret-token')),
    ).toBe(true);
    expect(requests[1]).toEqual({
      url: `${server.url.origin}/v1/chat/completions`,
      authorization: 'Bearer local-secret-token',
      body: {
        model: 'local-model',
        messages: [
          { role: 'system', content: 'rules [REDACTED-TOKEN]' },
          { role: 'user', content: 'diff [REDACTED-TOKEN]' },
        ],
        temperature: CONFIG.TEMP,
        max_tokens: 8_192,
        stream: false,
      },
    });
    expect(response).toEqual({
      text: 'test: use LM Studio [REDACTED-TOKEN] [REDACTED-KEY] token=opaque-value',
      usage: { promptTokens: 0, outputTokens: 0 },
      truncated: true,
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio rejects malformed and duplicate discovery catalogues', async () => {
  let response: unknown = { invalid: [] };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json(response);
    },
  });
  try {
    await expect(
      createLmStudioProvider({ baseUrl: server.url.origin }),
    ).rejects.toMatchObject({
      name: 'LanguageModelApiError',
      message: 'Invalid LM Studio model catalogue',
    });
    response = {
      models: [
        { key: 'duplicate', type: 'llm', max_context_length: 8_192 },
        { key: 'duplicate', type: 'llm', max_context_length: 16_384 },
      ],
    };
    await expect(
      createLmStudioProvider({ baseUrl: server.url.origin }),
    ).rejects.toThrow('Duplicate LM Studio model identifier');
  } finally {
    await server.stop(true);
  }
});

test('LM Studio rejects secret-bearing catalogue metadata before it reaches provider state', async () => {
  const token = 'private-local-token-value';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json({
        models: [
          {
            key: token,
            display_name: 'sk-abcdefghijklmnopqrstuvwxyz1234567890',
            type: 'llm',
            max_context_length: 8_192,
          },
        ],
      });
    },
  });
  try {
    await expect(
      createLmStudioProvider({ baseUrl: server.url.origin, token }),
    ).rejects.toMatchObject({
      name: 'LanguageModelApiError',
      message: 'Invalid LM Studio model metadata',
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio refuses generation redirects before reaching their target', async () => {
  let redirectedRequests = 0;
  const target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      redirectedRequests += 1;
      return Response.json({});
    },
  });
  const source = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [
            {
              key: 'local-model',
              type: 'llm',
              max_context_length: 16_384,
              loaded_instances: [{ config: { context_length: 16_384 } }],
            },
          ],
        });
      }
      return Response.redirect(target.url, 302);
    },
  });
  try {
    const provider = await createLmStudioProvider({
      baseUrl: source.url.origin,
    });
    await expect(
      provider.service.generate(createGenerateParams()),
    ).rejects.toMatchObject({
      name: 'LanguageModelApiError',
    });
    expect(redirectedRequests).toBe(0);
  } finally {
    await source.stop(true);
    await target.stop(true);
  }
});

test('LM Studio rejects oversized response bodies', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [
            {
              key: 'local-model',
              type: 'llm',
              max_context_length: 16_384,
              loaded_instances: [{ config: { context_length: 16_384 } }],
            },
          ],
        });
      }
      return new Response('x'.repeat(1024 * 1024 + 1));
    },
  });
  try {
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
    });
    await expect(
      provider.service.generate(createGenerateParams()),
    ).rejects.toMatchObject({
      name: 'LanguageModelApiError',
      message: 'LM Studio response body is too large',
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio normalizes HTTP errors without leaking configured or response secrets', async () => {
  const token = 'private-local-token-value';
  const responseSecret = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
  const assignedSecret = 'password=hunter2';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [
            {
              key: 'local-model',
              type: 'llm',
              max_context_length: 16_384,
              loaded_instances: [{ config: { context_length: 16_384 } }],
            },
          ],
        });
      }
      return new Response(
        `${JSON.stringify({
          error: {
            message: `failure ${token} ${responseSecret}`,
            password: 'hunter2',
            api_key: 'quoted-secret',
          },
        })}\u001b[2J`,
        { status: 500 },
      );
    },
  });
  try {
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
      token,
    });
    const caught: unknown = await provider.service
      .generate(createGenerateParams())
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(isLanguageModelApiError(caught)).toBe(true);
    const visible = JSON.stringify(caught);
    expect(visible).not.toContain(token);
    expect(visible).not.toContain(responseSecret);
    expect(visible).not.toContain(assignedSecret.replace('password=', ''));
    expect(visible).not.toContain('quoted-secret');
    expect(visible).not.toContain('\u001b');
  } finally {
    await server.stop(true);
  }
});

test('LM Studio rejects malformed API tokens before making a request', async () => {
  const token = 'secret\r\nforged: header';
  await expect(
    createLmStudioProvider({ baseUrl: 'http://127.0.0.1:1', token }),
  ).rejects.toMatchObject({
    name: 'LanguageModelApiError',
    message: 'Invalid LM Studio API token',
  });
});

test.each([
  ['malformed JSON', new Response('{broken', { status: 200 })],
  ['malformed response', Response.json({ choices: [] })],
])('LM Studio normalizes %s', async (_, generatedResponse) => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [
            {
              key: 'local-model',
              type: 'llm',
              max_context_length: 16_384,
              loaded_instances: [{ config: { context_length: 16_384 } }],
            },
          ],
        });
      }
      return generatedResponse.clone();
    },
  });
  try {
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
    });
    await expect(
      provider.service.generate(createGenerateParams()),
    ).rejects.toMatchObject({
      name: 'LanguageModelApiError',
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio returns truncated output without speculative retry', async () => {
  const userPrompts: string[] = [];
  const outputLimits: number[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [
            {
              key: 'local-model',
              type: 'llm',
              max_context_length: 16_384,
              loaded_instances: [{ config: { context_length: 16_384 } }],
            },
          ],
        });
      }
      const body = (await request.json()) as {
        messages: Array<{ content: string }>;
        max_tokens: number;
      };
      const {
        messages: [, userMessage],
      } = body;
      userPrompts.push(userMessage.content);
      outputLimits.push(body.max_tokens);
      return Response.json({
        choices: [
          {
            message: {
              content: userPrompts.length === 1 ? 'partial' : 'complete',
            },
            finish_reason: userPrompts.length === 1 ? 'length' : 'stop',
          },
        ],
        usage: {},
      });
    },
  });
  try {
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
    });
    const response = await provider.service.generate({
      promptContext: 'large diff',
      systemPrompt: 'rules',
      meta: {},
      modelName: 'local-model',
      maxOutputTokens: 1_024,
    });

    expect(userPrompts).toEqual(['large diff']);
    expect(outputLimits).toEqual([1_024]);
    expect(response?.text).toBe('partial');
    expect(response?.truncated).toBe(true);
  } finally {
    await server.stop(true);
  }
});

const TRACE_SECRET = `ghp_${'a1B2'.repeat(9)}`;

async function collectLmStudioTrace(options: {
  debugApi?: boolean;
  configDebug?: boolean;
}): Promise<Array<{ message: string; meta?: Record<string, unknown> }>> {
  const entries: Array<{ message: string; meta?: Record<string, unknown> }> =
    [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [
            {
              key: 'local-model',
              type: 'llm',
              max_context_length: 8_192,
              loaded_instances: [{ config: { context_length: 8_192 } }],
            },
          ],
        });
      }
      return Response.json({
        choices: [
          {
            message: { content: `feat: ${TRACE_SECRET}` },
            finish_reason: 'stop',
          },
        ],
        usage: {},
      });
    },
  });
  try {
    const provider = await createLmStudioProviderWithConfig({
      baseUrl: server.url.origin,
      config: { ...CONFIG, DEBUG_API: options.configDebug === true },
      debugApi: options.debugApi,
      logger: {
        log: function (
          _level: string,
          message: string,
          meta?: Record<string, unknown>,
        ) {
          entries.push({ message, meta });
        },
      },
    });
    await provider.service.generate({
      ...createGenerateParams(),
      promptContext: `diff ${TRACE_SECRET}`,
    });
  } finally {
    await server.stop(true);
  }
  return entries;
}

test.each([
  ['debugApi flag', { debugApi: true }],
  ['config.DEBUG_API', { configDebug: true }],
])(
  'LM Studio traces redacted request and response with %s',
  async (_name, options) => {
    const entries = await collectLmStudioTrace(options);

    expect(entries.map((entry) => entry.message)).toEqual([
      'LM Studio API request',
      'LM Studio API response',
    ]);
    expect(String(entries[0]?.meta?.body)).toContain('diff ');
    expect(entries[1]?.meta?.status).toBe(200);
    expect(JSON.stringify(entries)).not.toContain(TRACE_SECRET);
  },
);

test('LM Studio logs no trace when debug is off', async () => {
  expect(await collectLmStudioTrace({})).toEqual([]);
});
