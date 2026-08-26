import { expect, test } from 'bun:test';
import { createFreeLlmApiProvider } from '../src/freellmapi-provider.js';

test('createFreeLlmApiProvider rejects plaintext remote URLs', async function () {
  await expect(createFreeLlmApiProvider({ baseUrl: 'http://example.com/v1' })).rejects.toThrow(
    'FreeLLMAPI URL must use HTTPS or a loopback hostname',
  );
});

for (const baseUrl of [
  'ftp://example.com/v1',
  'http://user:password@127.0.0.1:3001',
  'http://127.0.0.1:3001?unsafe',
  'http://127.0.0.1:3001#unsafe',
  'http://2130706433:3001',
  'http://0177.0.0.1:3001',
]) {
  test(`createFreeLlmApiProvider rejects unsafe URL ${baseUrl}`, async function () {
    await expect(createFreeLlmApiProvider({ baseUrl })).rejects.toThrow();
  });
}

test('createFreeLlmApiProvider fetches models and generates text', async function () {
  let receivedAuthHeader = '';
  let receivedChatBody: Record<string, unknown> = {};

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async function (request) {
      receivedAuthHeader = request.headers.get('authorization') ?? '';
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return Response.json({
          object: 'list',
          data: [
            { id: 'gemini-2.5-flash', object: 'model' },
            { id: 'groq/llama-3.3-70b', object: 'model' },
          ],
        });
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        receivedChatBody = (await request.json()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-123',
          object: 'chat.completion',
          created: 1234567890,
          model: 'gemini-2.5-flash',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'COMMIT_MESSAGE: feat: add freellmapi provider',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 8,
            total_tokens: 23,
          },
        });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  try {
    const provider = await createFreeLlmApiProvider({
      baseUrl: server.url.origin,
      token: 'test-secret-token',
    });

    expect(provider.id).toBe('freellmapi');
    expect(provider.label).toBe('FreeLLMAPI');

    const models = await provider.listModels();
    expect(provider.defaultModel).toBe('auto');
    expect(models).toContain('auto');
    expect(models).toContain('gemini-2.5-flash');
    expect(models).toContain('groq/llama-3.3-70b');

    const response = await provider.service.generate({
      promptContext: 'Diff snippet',
      systemPrompt: 'System instructions',
      reduceForRetry: async () => ({ mode: 'unreducible' }),
      meta: { scope: 'test' },
    });

    expect(receivedAuthHeader).toBe('Bearer test-secret-token');
    expect(receivedChatBody.model).toBe('auto');
    expect(response?.text).toBe('COMMIT_MESSAGE: feat: add freellmapi provider');
    expect(response?.usage.promptTokens).toBe(15);
    expect(response?.usage.outputTokens).toBe(8);
  } finally {
    await server.stop(true);
  }
});

test('createFreeLlmApiProvider handles custom baseUrl endings', async function () {
  let chatCalled = false;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async function (request) {
      const url = new URL(request.url);

      if (
        request.method === 'GET' &&
        (url.pathname === '/v1/models' || url.pathname === '/models')
      ) {
        return Response.json({
          object: 'list',
          data: [{ id: 'gemini-2.5-flash', object: 'model' }],
        });
      }

      if (request.method === 'POST' && url.pathname === '/models/chat') {
        chatCalled = true;
        return Response.json({
          choices: [
            {
              message: { content: 'COMMIT_MESSAGE: feat: custom path chat' },
              finish_reason: 'stop',
            },
          ],
        });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  try {
    const provider = await createFreeLlmApiProvider({
      baseUrl: `${server.url.origin}/models/chat`,
    });

    const response = await provider.service.generate({
      promptContext: 'Diff snippet',
      systemPrompt: 'System instructions',
      reduceForRetry: async () => ({ mode: 'unreducible' }),
      meta: { scope: 'test' },
      opts: { modelOverride: 'gemini-2.5-flash' },
    });

    expect(chatCalled).toBe(true);
    expect(response?.text).toBe('COMMIT_MESSAGE: feat: custom path chat');
  } finally {
    await server.stop(true);
  }
});

test('createFreeLlmApiProvider preserves a custom base path', async function () {
  let chatCalled = false;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/proxy/models') {
        return Response.json({ data: [{ id: 'gemini-2.5-flash' }] });
      }
      if (request.method === 'POST' && url.pathname === '/proxy/chat/completions') {
        chatCalled = true;
        return Response.json({
          choices: [{ message: { content: 'COMMIT_MESSAGE: fix: preserve path' } }],
        });
      }
      return new Response('Not Found', { status: 404 });
    },
  });

  try {
    const provider = await createFreeLlmApiProvider({ baseUrl: `${server.url.origin}/proxy` });
    await provider.service.generate({
      promptContext: 'Diff snippet',
      systemPrompt: 'System instructions',
      reduceForRetry: async () => ({ mode: 'unreducible' }),
      meta: { scope: 'test' },
    });
    expect(chatCalled).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test('createFreeLlmApiProvider derives model discovery from a full chat endpoint', async function () {
  let modelPath = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        modelPath = url.pathname;
        return Response.json({ data: [{ id: 'gemini-2.5-flash' }] });
      }
      return Response.json({ choices: [{ message: { content: 'COMMIT_MESSAGE: fix: proxy' } }] });
    },
  });
  try {
    await createFreeLlmApiProvider({ baseUrl: `${server.url.origin}/proxy/v1/chat/completions` });
    expect(modelPath).toBe('/proxy/v1/models');
  } finally {
    await server.stop(true);
  }
});

test('createFreeLlmApiProvider excludes known non-text models', async function () {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json({
        data: [
          { id: 'gpt-4o' },
          { id: 'text-embedding-3-small' },
          { id: 'dall-e-3' },
          { id: 'whisper-1' },
          { id: 'custom-embed', type: 'embedding' },
        ],
      });
    },
  });
  try {
    const provider = await createFreeLlmApiProvider({ baseUrl: server.url.origin });
    expect(await provider.listModels()).toEqual(['auto', 'gpt-4o']);
  } finally {
    await server.stop(true);
  }
});

test('createFreeLlmApiProvider rejects unknown model overrides', async function () {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json({ data: [{ id: 'gpt-4o' }] });
    },
  });
  try {
    const provider = await createFreeLlmApiProvider({ baseUrl: server.url.origin });
    await expect(
      provider.service.generate({
        promptContext: 'Diff',
        systemPrompt: 'System',
        reduceForRetry: async () => ({ mode: 'unreducible' }),
        meta: { scope: 'test' },
        opts: { modelOverride: 'missing-model' },
      }),
    ).rejects.toThrow('Unknown FreeLLMAPI model');
  } finally {
    await server.stop(true);
  }
});

test('createFreeLlmApiProvider preserves authentication errors during endpoint fallback', async function () {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      return new Response('failure', {
        status: new URL(request.url).pathname === '/v1/models' ? 401 : 404,
      });
    },
  });
  try {
    await expect(createFreeLlmApiProvider({ baseUrl: server.url.origin })).rejects.toMatchObject({
      metadata: { status: 401 },
    });
  } finally {
    await server.stop(true);
  }
});

test('createFreeLlmApiProvider rejects secret-bearing catalogue metadata', async function () {
  const token = 'catalogue-secret-token';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json({ data: [{ id: `model-${token}` }] });
    },
  });
  try {
    await expect(createFreeLlmApiProvider({ baseUrl: server.url.origin, token })).rejects.toThrow(
      'Invalid FreeLLMAPI model metadata',
    );
  } finally {
    await server.stop(true);
  }
});

test('createFreeLlmApiProvider falls back only after a missing model endpoint', async function () {
  const requestedPaths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function (request) {
      const pathname = new URL(request.url).pathname;
      requestedPaths.push(pathname);
      if (pathname === '/v1/models') return new Response('missing', { status: 404 });
      return Response.json({ data: [{ id: 'gpt-4o' }] });
    },
  });
  try {
    const provider = await createFreeLlmApiProvider({ baseUrl: server.url.origin });
    expect(await provider.listModels()).toEqual(['auto', 'gpt-4o']);
    expect(requestedPaths).toEqual(['/v1/models', '/models']);
  } finally {
    await server.stop(true);
  }
});

test('createFreeLlmApiProvider rejects malformed catalogues', async function () {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json({ data: 'not-a-list' });
    },
  });
  try {
    await expect(createFreeLlmApiProvider({ baseUrl: server.url.origin })).rejects.toThrow(
      'FreeLLMAPI returned no compatible text models',
    );
  } finally {
    await server.stop(true);
  }
});
