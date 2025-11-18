import { test, expect } from 'bun:test';
import { createGeminiClient } from '../src/gemini-client';
import type { GeminiClient, GeminiResponse } from '../src/gemini-client';

async function geminiClientSuccessTest(): Promise<void> {
  let called = false;
  const origFetch = globalThis.fetch;
  async function fetchStub(_url: string, _opts: any): Promise<any> {
    called = true;
    return {
      ok: true,
      status: 200,
      text: async function (): Promise<string> {
        return JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: 'BRANCH: feat/test\nCOMMIT_MESSAGE: feat: test' }] },
              thinkingMetadata: { thinkingTokenCount: 2 },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15 },
        });
      },
    };
  }
  globalThis.fetch = fetchStub;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub,
      config: { GEMINI_MAX_RETRIES: 3, GEMINI_RETRY_BASE_MS: 5, GEMINI_RETRY_MAX_MS: 100 },
    });
    const res: GeminiResponse | null = await client.callGemini(
      'fake-key',
      'hello',
      false,
      {},
      { maxOutputTokens: 512, systemInstructions: 'instr' },
    );
    expect(called).toBe(true);
    expect(res?.text).toContain('BRANCH:');
    expect(res?.usage.promptTokens).toBe(10);
  } finally {
    globalThis.fetch = origFetch;
  }
}
test('gemini-client: successTest', geminiClientSuccessTest);

async function geminiClientRetryTest(): Promise<void> {
  let callCount = 0;
  const origFetch = globalThis.fetch;
  async function fetchStub(_url: string, _opts: any): Promise<any> {
    callCount = callCount + 1;
    if (callCount === 1) {
      return {
        ok: false,
        status: 429,
        text: async function (): Promise<string> {
          return JSON.stringify({
            error: { details: [{ '@type': 'RetryInfo', retryDelay: '0.01s' }] },
          });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      text: async function (): Promise<string> {
        return JSON.stringify({
          candidates: [
            { content: { parts: [{ text: 'BRANCH: feat/two\nCOMMIT_MESSAGE: feat: two' }] } },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
        });
      },
    };
  }
  globalThis.fetch = fetchStub;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub,
      config: { GEMINI_MAX_RETRIES: 3, GEMINI_RETRY_BASE_MS: 5, GEMINI_RETRY_MAX_MS: 100 },
    });
    const res: GeminiResponse | null = await client.callGemini(
      'fake-key',
      'hello',
      false,
      {},
      { maxOutputTokens: 512 },
    );
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(res?.text).toContain('BRANCH');
    console.log('  retryTest -> passed');
  } finally {
    globalThis.fetch = origFetch;
  }
}
test('gemini-client: retryTest', geminiClientRetryTest);

async function geminiClientNetworkErrorTest(): Promise<void> {
  let callCount = 0;
  const origFetch = globalThis.fetch;
  async function fetchStub(_url: string, _opts: any): Promise<any> {
    callCount = callCount + 1;
    if (callCount <= 3) throw new Error('network fail');
    return {
      ok: true,
      status: 200,
      text: async function (): Promise<string> {
        return JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'BRANCH: feat/recovered\nCOMMIT_MESSAGE: feat: recovered' }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 4 },
        });
      },
    };
  }
  globalThis.fetch = fetchStub;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub,
      config: { GEMINI_MAX_RETRIES: 3, GEMINI_RETRY_BASE_MS: 5, GEMINI_RETRY_MAX_MS: 100 },
    });
    const res: GeminiResponse | null = await client.callGemini(
      'fake-key',
      'hello',
      false,
      {},
      { maxOutputTokens: 256 },
    );
    expect(res?.text).toContain('BRANCH');
    console.log('  networkErrorTest -> passed');
  } finally {
    globalThis.fetch = origFetch;
  }
}
test('gemini-client: networkErrorTest', geminiClientNetworkErrorTest);

async function geminiClientInvalidJsonTest(): Promise<void> {
  const origFetch = globalThis.fetch;
  async function fetchStub(_url: string, _opts: any): Promise<any> {
    return {
      ok: true,
      status: 200,
      text: async function (): Promise<string> {
        return 'this is not json';
      },
    };
  }
  globalThis.fetch = fetchStub;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub,
      config: { GEMINI_MAX_RETRIES: 3, GEMINI_RETRY_BASE_MS: 5, GEMINI_RETRY_MAX_MS: 100 },
    });
    await expect(
      client.callGemini('fake-key', 'hello', false, {}, { maxOutputTokens: 256 }),
    ).rejects.toThrow();
  } finally {
    globalThis.fetch = origFetch;
  }
}
test('gemini-client: invalidJsonTest', geminiClientInvalidJsonTest);

async function geminiClientTimeoutTest(): Promise<void> {
  const origFetch = globalThis.fetch;
  async function fetchStub(_url: string, _opts: any): Promise<any> {
    return await new Promise(function (resolve, reject) {
      if (_opts?.signal) {
        _opts.signal.addEventListener('abort', function () {
          reject(new Error('Aborted')); // simulate AbortError
        });
      }
      // Do not resolve or reject otherwise (simulate a hang)
    });
  }
  globalThis.fetch = fetchStub;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub,
      config: { GEMINI_MAX_RETRIES: 3, GEMINI_RETRY_BASE_MS: 5, GEMINI_RETRY_MAX_MS: 100 },
    });
    await expect(
      client.callGemini('fake-key', 'hello', false, {}, { maxOutputTokens: 256, timeoutMs: 5 }),
    ).rejects.toThrow();
  } finally {
    globalThis.fetch = origFetch;
  }
}
test('gemini-client: timeoutTest', geminiClientTimeoutTest);
