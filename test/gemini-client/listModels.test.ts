import { afterEach, expect, test } from 'bun:test';

// test/list-models.test.ts installs a process-wide mock for listModels. The
// suite runs with `bun test --isolate` so that mock cannot reach this file.
const originalFetch = globalThis.fetch;

afterEach(function () {
  globalThis.fetch = originalFetch;
});

test('listModels: sends the API key only as a request header', async function () {
  const apiKey = 'AIzaFakeListModelsKey1234567890';
  let requestUrl = '';
  let requestHeaders = new Headers();
  globalThis.fetch = async function (input, init) {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }],
      }),
    );
  } as typeof fetch;

  const { listGeminiModels } = await import('../../src/gemini-client/listModels.js');

  await expect(listGeminiModels(apiKey)).resolves.toEqual(['models/gemini-test']);
  expect(requestUrl).not.toContain(apiKey);
  expect(requestUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  expect(requestHeaders.get('x-goog-api-key')).toBe(apiKey);
});

test('listModels: applies a request timeout', async function () {
  let signal: AbortSignal | null = null;
  globalThis.fetch = async function (_input, init) {
    signal = init?.signal ?? null;
    return new Response(JSON.stringify({ models: [] }));
  } as typeof fetch;

  const { listGeminiModels } = await import('../../src/gemini-client/listModels.js');
  await listGeminiModels('test-key');

  expect(signal).toBeInstanceOf(AbortSignal);
});
