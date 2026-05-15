import { test, expect } from 'bun:test';
import { createGeminiClient } from '../src/gemini-client';
import type { GeminiClient, GeminiResponse } from '../src/gemini-client';

async function geminiClientSuccessTest(): Promise<void> {
  let called = false;
  const origFetch = globalThis.fetch;
  async function fetchStub(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    void input;
    void _init;
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
    } as unknown as Response;
  }
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub as typeof fetch,
      config: { GEMINI_MAX_RETRIES: 3, GEMINI_RETRY_BASE_MS: 5, GEMINI_RETRY_MAX_MS: 100 },
    });
    const res: GeminiResponse | null = await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      enableThinking: false,
      telemetryMeta: {},
      callOptions: { maxOutputTokens: 512, systemInstructions: 'instr' },
    });
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
  async function fetchStub(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    void input;
    void _init;
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
      } as unknown as Response;
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
    } as unknown as Response;
  }
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub as typeof fetch,
      config: { GEMINI_MAX_RETRIES: 3, GEMINI_RETRY_BASE_MS: 5, GEMINI_RETRY_MAX_MS: 100 },
    });
    const res: GeminiResponse | null = await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      enableThinking: false,
      telemetryMeta: {},
      callOptions: { maxOutputTokens: 512 },
    });
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
  async function fetchStub(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    void input;
    void _init;
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
    } as unknown as Response;
  }
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub as typeof fetch,
      config: { GEMINI_MAX_RETRIES: 3, GEMINI_RETRY_BASE_MS: 5, GEMINI_RETRY_MAX_MS: 100 },
    });
    const res: GeminiResponse | null = await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      enableThinking: false,
      telemetryMeta: {},
      callOptions: { maxOutputTokens: 256 },
    });
    expect(res?.text).toContain('BRANCH');
    console.log('  networkErrorTest -> passed');
  } finally {
    globalThis.fetch = origFetch;
  }
}
test('gemini-client: networkErrorTest', geminiClientNetworkErrorTest);

async function geminiClientInvalidJsonTest(): Promise<void> {
  const origFetch = globalThis.fetch;
  let callCount = 0;
  async function fetchStub(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    void input;
    void _init;
    callCount += 1;
    return {
      ok: true,
      status: 200,
      text: async function (): Promise<string> {
        return 'this is not json';
      },
    } as unknown as Response;
  }
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub as typeof fetch,
      config: { GEMINI_MAX_RETRIES: 3, GEMINI_RETRY_BASE_MS: 5, GEMINI_RETRY_MAX_MS: 100 },
    });
    await expect(
      client.callGemini({
        apiKey: 'fake-key',
        userContent: 'hello',
        enableThinking: false,
        telemetryMeta: {},
        callOptions: { maxOutputTokens: 256 },
      }),
    ).rejects.toThrow();
    expect(callCount).toBe(1);
  } finally {
    globalThis.fetch = origFetch;
  }
}
test('gemini-client: invalidJsonTest', geminiClientInvalidJsonTest);

async function geminiClientTimeoutTest(): Promise<void> {
  const origFetch = globalThis.fetch;
  async function fetchStub(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    const _opts = _init as { signal?: AbortSignal };
    return (await new Promise(function (resolve, reject) {
      if (_opts?.signal) {
        _opts.signal.addEventListener('abort', function () {
          reject(new Error('Aborted')); // simulate AbortError
        });
      }
      // Do not resolve or reject otherwise (simulate a hang)
    })) as unknown as Response;
  }
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub as typeof fetch,
      config: { GEMINI_MAX_RETRIES: 3, GEMINI_RETRY_BASE_MS: 5, GEMINI_RETRY_MAX_MS: 100 },
    });
    await expect(
      client.callGemini({
        apiKey: 'fake-key',
        userContent: 'hello',
        enableThinking: false,
        telemetryMeta: {},
        callOptions: { maxOutputTokens: 256, timeoutMs: 5 },
      }),
    ).rejects.toThrow();
  } finally {
    globalThis.fetch = origFetch;
  }
}
test('gemini-client: timeoutTest', geminiClientTimeoutTest);

async function geminiClientTruncatedFlagMissingEndTest(): Promise<void> {
  const origFetch = globalThis.fetch;
  async function fetchStub(_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    void _input;
    void _init;
    return {
      ok: true,
      status: 200,
      text: async function (): Promise<string> {
        return JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'prefix <<START>>partial result...' }] } }],
        });
      },
    } as unknown as Response;
  }
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    const client: GeminiClient = createGeminiClient({ fetchImpl: fetchStub as typeof fetch });
    const res = await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      enableThinking: false,
      telemetryMeta: {},
      callOptions: { maxOutputTokens: 256 },
    });
    expect(res?.truncated).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
}
test('gemini-client: truncated flag when missing END', geminiClientTruncatedFlagMissingEndTest);

async function geminiClientTruncatedFlagEndTruncatedTest(): Promise<void> {
  const origFetch = globalThis.fetch;
  async function fetchStub(_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    void _input;
    void _init;
    return {
      ok: true,
      status: 200,
      text: async function (): Promise<string> {
        return JSON.stringify({
          candidates: [{ content: { parts: [{ text: '<<START>>partial<<END_TRUNCATED>>' }] } }],
        });
      },
    } as unknown as Response;
  }
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    const client: GeminiClient = createGeminiClient({ fetchImpl: fetchStub as typeof fetch });
    const res = await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      enableThinking: false,
      telemetryMeta: {},
      callOptions: { maxOutputTokens: 256 },
    });
    expect(res?.truncated).toBe(true);
  } finally {
    globalThis.fetch = origFetch;
  }
}
test(
  'gemini-client: truncated flag when END_TRUNCATED present',
  geminiClientTruncatedFlagEndTruncatedTest,
);

async function geminiClientRetryOnTruncatedTest(): Promise<void> {
  let callCount = 0;
  const seenMaxOutput: number[] = [];
  const origFetch = globalThis.fetch;
  async function fetchStub(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    void _input;
    callCount += 1;
    try {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const maxOut = (body?.generationConfig as any)?.maxOutputTokens;
      if (typeof maxOut === 'number') seenMaxOutput.push(maxOut);
    } catch {
      // ignore
    }

    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        text: async function (): Promise<string> {
          return JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'prefix <<START>>partial result...' }] } }],
          });
        },
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async function (): Promise<string> {
        return JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'prefix <<START>>full result<<END>>' }] } }],
        });
      },
    } as unknown as Response;
  }
  globalThis.fetch = fetchStub as typeof fetch;
  try {
    const client: GeminiClient = createGeminiClient({
      fetchImpl: fetchStub as typeof fetch,
      config: { MAX_OUTPUT_TOKENS: 256 } as any,
    });
    const res = await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      enableThinking: false,
      telemetryMeta: {},
      callOptions: {
        maxOutputTokens: 256,
        retryIfTruncated: true,
        retryIfTruncatedMaxRetries: 2,
        retryIfTruncatedIncreaseTokens: 100,
      },
    });
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(res?.truncated).toBeFalsy();
    expect(seenMaxOutput.length).toBeGreaterThanOrEqual(2);
    expect(seenMaxOutput[1]).toBeGreaterThan(seenMaxOutput[0]);
  } finally {
    globalThis.fetch = origFetch;
  }
}
test('gemini-client: retry on truncated response when enabled', geminiClientRetryOnTruncatedTest);
