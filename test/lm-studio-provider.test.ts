import { expect, test } from 'bun:test';
import { createLmStudioProvider } from '../src/lm-studio-provider.js';
import { isLanguageModelApiError } from '../src/language-model-service.js';

function createGenerateParams(timeoutMs?: number) {
  return {
    promptContext: 'diff content',
    systemPrompt: 'system rules',
    reduceForRetry: async function () {
      return { mode: 'unreducible' as const };
    },
    meta: {},
    opts: { modelOverride: 'local-model', timeoutMs },
  };
}

test('LM Studio rejects a non-loopback server URL', async function () {
  await expect(createLmStudioProvider({ baseUrl: 'http://example.com:1234' })).rejects.toThrow(
    'LM Studio URL must use a loopback hostname',
  );
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
])('LM Studio rejects unsafe server URL %s', async function (baseUrl) {
  await expect(createLmStudioProvider({ baseUrl })).rejects.toThrow('Invalid LM Studio URL');
});

test('LM Studio discovers sorted text models and uses the active context length', async function () {
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
    const provider = await createLmStudioProvider({ baseUrl: server.url.origin });

    expect(provider.defaultModel).toBe('zeta');
    expect(await provider.listModels()).toEqual(['alpha', 'zeta']);
    expect(provider.getModelSpec('zeta')).toEqual({
      name: 'zeta',
      label: 'Zeta',
      maxInputTokens: 8_192,
      maxOutputTokens: 3_096,
    });
    expect(provider.getModelSpec('alpha')).toEqual({
      name: 'alpha',
      label: 'alpha',
      maxInputTokens: 8_192,
      maxOutputTokens: 1_024,
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio loads an explicit unloaded model, waits, and refreshes its context', async function () {
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
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
            loaded_instances: loaded ? [{ config: { context_length: 32_768 } }] : [],
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
      { method: 'GET', path: '/api/v1/models', authorization: 'Bearer local-token' },
    ]);
    expect(probe.defaultModel).toBe('preferred-model');

    requests.length = 0;
    const provider = await createLmStudioProvider({
      baseUrl: server.url.origin,
      model: 'preferred-model',
      token: 'local-token',
    });

    expect(requests).toEqual([
      { method: 'GET', path: '/api/v1/models', authorization: 'Bearer local-token' },
      { method: 'POST', path: '/api/v1/models/load', authorization: 'Bearer local-token' },
      { method: 'GET', path: '/api/v1/models', authorization: 'Bearer local-token' },
    ]);
    expect(provider.defaultModel).toBe('preferred-model');
    expect(provider.getModelSpec('preferred-model').maxInputTokens).toBe(32_768);

    requests.length = 0;
    await createLmStudioProvider({
      baseUrl: server.url.origin,
      model: 'preferred-model',
      token: 'local-token',
    });
    expect(requests).toEqual([
      { method: 'GET', path: '/api/v1/models', authorization: 'Bearer local-token' },
    ]);
  } finally {
    await server.stop(true);
  }
});

test('LM Studio prefers and loads Gemma when no model is explicitly configured', async function () {
  let loaded = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async function (request) {
      if (request.method === 'POST') {
        expect(await request.json()).toEqual({ model: 'gemma-4-e4b-it-mlx' });
        loaded = true;
        return Response.json({ type: 'llm', status: 'loaded' });
      }
      return Response.json({
        models: [
          {
            key: 'qwen3-4b-instruct-2507',
            type: 'llm',
            max_context_length: 8192,
            loaded_instances: [],
          },
          {
            key: 'gemma-4-e4b-it-mlx',
            type: 'llm',
            max_context_length: 131_072,
            loaded_instances: loaded ? [{ config: { context_length: 32_768 } }] : [],
          },
        ],
      });
    },
  });
  try {
    const provider = await createLmStudioProvider({ baseUrl: server.url.origin });
    expect(provider.defaultModel).toBe('gemma-4-e4b-it-mlx');
    expect(loaded).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test('LM Studio reports a visible fallback when preferred Gemma is unavailable', async function () {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json({
        models: [
          {
            key: 'qwen3-4b-instruct-2507',
            type: 'llm',
            max_context_length: 8_192,
            loaded_instances: [{ config: { context_length: 8_192 } }],
          },
        ],
      });
    },
  });
  try {
    const provider = await createLmStudioProvider({ baseUrl: server.url.origin });

    expect(provider.defaultModel).toBe('qwen3-4b-instruct-2507');
    expect(provider.selectionNotice).toBe(
      'gemma-4-e4b-it-mlx is unavailable; using qwen3-4b-instruct-2507',
    );
  } finally {
    await server.stop(true);
  }
});

test('LM Studio rejects an unavailable explicitly configured model', async function () {
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

test('LM Studio maps chat requests and responses without putting its token in the URL', async function () {
  const requests: Array<{ url: string; authorization: string | null; body?: unknown }> = [];
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
          models: [{ key: 'local-model', type: 'llm', max_context_length: 16_384 }],
        });
      }
      return Response.json({
        choices: [
          {
            message: {
              content:
                'COMMIT_MESSAGE: test: use LM Studio local-secret-token sk-abcdefghijklmnopqrstuvwxyz1234567890 token=opaque-value',
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
      temperature: 0.25,
    });
    const response = await provider.service.generate({
      ...createGenerateParams(),
      promptContext: 'diff local-secret-token',
      systemPrompt: 'rules local-secret-token',
    });

    expect(requests.every(request => !request.url.includes('local-secret-token'))).toBe(true);
    expect(requests[1]).toEqual({
      url: `${server.url.origin}/v1/chat/completions`,
      authorization: 'Bearer local-secret-token',
      body: {
        model: 'local-model',
        messages: [
          { role: 'system', content: 'rules [REDACTED-TOKEN]' },
          { role: 'user', content: 'diff [REDACTED-TOKEN]' },
        ],
        temperature: 0.25,
        max_tokens: 1_024,
        stream: false,
      },
    });
    expect(response).toEqual({
      text: 'COMMIT_MESSAGE: test: use LM Studio [REDACTED-TOKEN] [REDACTED-KEY] token=[REDACTED]',
      usage: { promptTokens: 0, outputTokens: 0 },
      truncated: true,
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio rejects malformed and duplicate discovery catalogues', async function () {
  let response: unknown = { invalid: [] };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json(response);
    },
  });
  try {
    await expect(createLmStudioProvider({ baseUrl: server.url.origin })).rejects.toMatchObject({
      name: 'LanguageModelApiError',
      message: 'Invalid LM Studio model catalogue',
    });
    response = {
      models: [
        { key: 'duplicate', type: 'llm', max_context_length: 8_192 },
        { key: 'duplicate', type: 'llm', max_context_length: 16_384 },
      ],
    };
    await expect(createLmStudioProvider({ baseUrl: server.url.origin })).rejects.toThrow(
      'Duplicate LM Studio model identifier',
    );
  } finally {
    await server.stop(true);
  }
});

test('LM Studio rejects secret-bearing catalogue metadata before it reaches provider state', async function () {
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

test('LM Studio normalizes a timeout while reading the response body', async function () {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [{ key: 'local-model', type: 'llm', max_context_length: 16_384 }],
        });
      }
      return new Response(
        new ReadableStream({
          start: function (controller) {
            controller.enqueue(new TextEncoder().encode('{"choices":'));
          },
        }),
      );
    },
  });
  try {
    const provider = await createLmStudioProvider({ baseUrl: server.url.origin });
    await expect(provider.service.generate(createGenerateParams(5))).rejects.toMatchObject({
      name: 'LanguageModelApiError',
      message: 'LM Studio request timed out',
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio refuses generation redirects before reaching their target', async function () {
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
          models: [{ key: 'local-model', type: 'llm', max_context_length: 16_384 }],
        });
      }
      return Response.redirect(target.url, 302);
    },
  });
  try {
    const provider = await createLmStudioProvider({ baseUrl: source.url.origin });
    await expect(provider.service.generate(createGenerateParams())).rejects.toMatchObject({
      name: 'LanguageModelApiError',
    });
    expect(redirectedRequests).toBe(0);
  } finally {
    await source.stop(true);
    await target.stop(true);
  }
});

test('LM Studio rejects oversized response bodies', async function () {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [{ key: 'local-model', type: 'llm', max_context_length: 16_384 }],
        });
      }
      return new Response('x'.repeat(1024 * 1024 + 1));
    },
  });
  try {
    const provider = await createLmStudioProvider({ baseUrl: server.url.origin });
    await expect(provider.service.generate(createGenerateParams())).rejects.toMatchObject({
      name: 'LanguageModelApiError',
      message: 'LM Studio response body is too large',
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio normalizes HTTP errors without leaking configured or response secrets', async function () {
  const token = 'private-local-token-value';
  const responseSecret = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
  const assignedSecret = 'password=hunter2';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [{ key: 'local-model', type: 'llm', max_context_length: 16_384 }],
        });
      }
      return new Response(
        JSON.stringify({
          error: {
            message: `failure ${token} ${responseSecret}`,
            password: 'hunter2',
            api_key: 'quoted-secret',
          },
        }) + '\u001b[2J',
        { status: 500 },
      );
    },
  });
  try {
    const provider = await createLmStudioProvider({ baseUrl: server.url.origin, token });
    let caught: unknown;
    try {
      await provider.service.generate(createGenerateParams());
    } catch (error) {
      caught = error;
    }

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

test('LM Studio rejects malformed API tokens before making a request', async function () {
  const token = 'secret\r\nforged: header';
  await expect(
    createLmStudioProvider({ baseUrl: 'http://127.0.0.1:1', token }),
  ).rejects.toMatchObject({
    name: 'LanguageModelApiError',
    message: 'Invalid LM Studio API token',
  });
});

test('LM Studio rejects invalid generation timeouts with a provider-owned error', async function () {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json({
        models: [{ key: 'local-model', type: 'llm', max_context_length: 16_384 }],
      });
    },
  });
  try {
    const provider = await createLmStudioProvider({ baseUrl: server.url.origin });
    await expect(
      provider.service.generate(createGenerateParams(Number.POSITIVE_INFINITY)),
    ).rejects.toMatchObject({
      name: 'LanguageModelApiError',
      message: 'Invalid LM Studio timeout',
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio normalizes generation timeouts', async function () {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [{ key: 'local-model', type: 'llm', max_context_length: 16_384 }],
        });
      }
      await Bun.sleep(100);
      return Response.json({});
    },
  });
  try {
    const provider = await createLmStudioProvider({ baseUrl: server.url.origin });
    await expect(provider.service.generate(createGenerateParams(5))).rejects.toMatchObject({
      name: 'LanguageModelApiError',
      message: 'LM Studio request timed out',
    });
  } finally {
    await server.stop(true);
  }
});

test.each([
  ['malformed JSON', new Response('{broken', { status: 200 })],
  ['malformed response', Response.json({ choices: [] })],
])('LM Studio normalizes %s', async function (_, generatedResponse) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [{ key: 'local-model', type: 'llm', max_context_length: 16_384 }],
        });
      }
      return generatedResponse.clone();
    },
  });
  try {
    const provider = await createLmStudioProvider({ baseUrl: server.url.origin });
    await expect(provider.service.generate(createGenerateParams())).rejects.toMatchObject({
      name: 'LanguageModelApiError',
    });
  } finally {
    await server.stop(true);
  }
});

test('LM Studio bounds truncation retries and uses caller context reduction', async function () {
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
      const userMessage = body.messages[1];
      if (!userMessage) throw new Error('Missing user message');
      userPrompts.push(userMessage.content);
      outputLimits.push(body.max_tokens);
      return Response.json({
        choices: [
          {
            message: { content: userPrompts.length === 1 ? 'partial' : 'complete' },
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
      maxOutputTokens: 1_024,
    });
    const response = await provider.service.generate({
      promptContext: 'large diff',
      promptParts: { prefix: '', diffHeading: '', diffBody: 'large diff', suffix: '' },
      summaryAttempted: false,
      systemPrompt: 'rules',
      reduceForRetry: async function () {
        return {
          mode: 'truncation',
          promptContext: 'smaller diff',
          promptParts: { prefix: '', diffHeading: '', diffBody: 'smaller diff', suffix: '' },
          summaryAttempted: false,
          summaryUsed: false,
        };
      },
      meta: {},
      opts: {
        modelOverride: 'local-model',
        retryIfTruncated: true,
        retryIfTruncatedMaxRetries: 1,
        retryIfTruncatedIncreaseTokens: 256,
      },
    });

    expect(userPrompts).toEqual(['large diff', 'smaller diff']);
    expect(outputLimits).toEqual([1_024, 1_280]);
    expect(response?.text).toBe('complete');
  } finally {
    await server.stop(true);
  }
});
