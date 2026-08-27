import { afterEach, expect, test } from 'bun:test';

const originalFetch = globalThis.fetch;

afterEach(function () {
  globalThis.fetch = originalFetch;
});

test('listModels: returns validated metadata and sends the API key only as a header', async function () {
  const apiKey = 'AIzaFakeListModelsKey1234567890';
  let requestUrl = '';
  let requestHeaders = new Headers();
  globalThis.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return Response.json({
      models: [
        {
          name: 'models/gemini-test',
          displayName: 'Gemini Test',
          supportedGenerationMethods: ['generateContent'],
          inputTokenLimit: 1_000_000,
          outputTokenLimit: 8_192,
        },
      ],
    });
  } as unknown as typeof fetch;

  const { listGeminiModels } = await import('../../src/gemini-client/listModels.js');

  await expect(listGeminiModels(apiKey)).resolves.toEqual([
    {
      name: 'models/gemini-test',
      label: 'Gemini Test',
      limits: { kind: 'separate' as const, maxInputTokens: 1_000_000, maxOutputTokens: 8_192 },
    },
  ]);
  expect(requestUrl).not.toContain(apiKey);
  expect(requestUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  expect(requestHeaders.get('x-goog-api-key')).toBe(apiKey);
});

test('listModels: maps request cancellation to its timeout error', async function () {
  let signal: AbortSignal | null = null;
  globalThis.fetch = async function (_input: RequestInfo | URL, init?: RequestInit) {
    signal = init?.signal ?? null;
    throw new DOMException('Aborted', 'AbortError');
  } as unknown as typeof fetch;

  const { listGeminiModels } = await import('../../src/gemini-client/listModels.js');
  await expect(listGeminiModels('test-key')).rejects.toThrow('Gemini model discovery timed out');

  expect(signal).toBeInstanceOf(AbortSignal);
});

test('listModels: follows pagination and skips malformed model limits', async function () {
  const urls: string[] = [];
  globalThis.fetch = async function (input: RequestInfo | URL) {
    const url = String(input);
    urls.push(url);
    if (!url.includes('pageToken=')) {
      return Response.json({
        models: [
          {
            name: 'models/gemini-first',
            supportedGenerationMethods: ['generateContent'],
            inputTokenLimit: 1_000_000,
            outputTokenLimit: 8_192,
          },
        ],
        nextPageToken: 'next token',
      });
    }
    return Response.json({
      models: [
        {
          name: 'models/gemini-second',
          supportedGenerationMethods: ['generateContent'],
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
        },
        {
          name: 'models/gemini-invalid',
          supportedGenerationMethods: ['generateContent'],
          inputTokenLimit: 100,
          outputTokenLimit: 0,
        },
      ],
    });
  } as typeof fetch;

  const { listGeminiModels } = await import('../../src/gemini-client/listModels.js');
  const models = await listGeminiModels('test-key');

  expect(models.map(model => model.name)).toEqual(['models/gemini-first', 'models/gemini-second']);
  expect(urls).toEqual([
    'https://generativelanguage.googleapis.com/v1beta/models',
    'https://generativelanguage.googleapis.com/v1beta/models?pageToken=next+token',
  ]);
});

test('listModels: rejects an oversized response body', async function () {
  globalThis.fetch = async function () {
    return new Response('{"models":[' + '"x"'.repeat(400_000) + ']}');
  } as unknown as typeof fetch;

  const { listGeminiModels } = await import('../../src/gemini-client/listModels.js');
  await expect(listGeminiModels('test-key')).rejects.toThrow('response body is too large');
});
