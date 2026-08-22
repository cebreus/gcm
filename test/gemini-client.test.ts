import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGeminiClient } from '../src/gemini-client';
import type { GeminiClient, GeminiResponse } from '../src/gemini-client';
import { parseCandidates } from '../src/gemini-client/parsers';
import type { Logger } from '../src/logger';

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

test('gemini-client: refuses a symlinked debug log without touching its target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gcm-debug-log-'));
  const victim = join(directory, 'victim');
  const debugPath = join(directory, '.debug.log');
  const originalWrite = process.stderr.write;
  let stderr = '';
  try {
    await writeFile(victim, 'keep this content intact\n');
    await symlink(victim, debugPath);
    process.stderr.write = function (chunk: string | Uint8Array): boolean {
      stderr += String(chunk);
      return true;
    } as typeof process.stderr.write;

    createGeminiClient({ config: { DEBUG_API: true, DEBUG_FILE: debugPath } });

    await Bun.sleep(10);
    expect(await readFile(victim, 'utf8')).toBe('keep this content intact\n');
    expect(stderr).toContain(`Refusing to write debug log ${JSON.stringify(debugPath)}: it is a symbolic link.`);
  } finally {
    process.stderr.write = originalWrite;
    await rm(directory, { recursive: true, force: true });
  }
});

test('gemini-client: caps every debug body payload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gcm-debug-body-'));
  const debugPath = join(directory, '.debug.log');
  const requestTail = 'request-secret-tail';
  const responseTail = 'response-secret-tail';
  const userContent = 'a'.repeat(256) + requestTail;
  const responseText = JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ text: '<<START>>' + 'b'.repeat(256) + responseTail + '<<END>>' }],
        },
      },
    ],
  });

  async function fetchStub(_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    void _input;
    void _init;
    return new Response(responseText);
  }

  try {
    const client = createGeminiClient({
      fetchImpl: fetchStub as typeof fetch,
      config: {
        DEBUG_API: true,
        DEBUG_FILE: debugPath,
        DEBUG_MAX_BODY_LOG_BYTES: 64,
      },
    });
    await client.callGemini({
      apiKey: 'fake-key',
      userContent,
      enableThinking: false,
      telemetryMeta: {},
      callOptions: {},
    });

    await Bun.sleep(10);
    const debugLog = await readFile(debugPath, 'utf8');
    expect(debugLog).toContain('[TRUNCATED]');
    expect(debugLog).not.toContain(requestTail);
    expect(debugLog).not.toContain(responseTail);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

async function geminiClientTruncationRetryRespectsModelOutputLimitTest(): Promise<void> {
  let callCount = 0;
  const seenMaxOutput: number[] = [];
  async function fetchStub(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    void _input;
    callCount += 1;
    const requestBody: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    if (typeof requestBody === 'object' && requestBody !== null && 'generationConfig' in requestBody) {
      const generationConfig = requestBody.generationConfig;
      if (
        typeof generationConfig === 'object' &&
        generationConfig !== null &&
        'maxOutputTokens' in generationConfig &&
        typeof generationConfig.maxOutputTokens === 'number'
      ) {
        seenMaxOutput.push(generationConfig.maxOutputTokens);
      }
    }
    const responseText =
      callCount === 1 ? 'prefix <<START>>partial result...' : 'prefix <<START>>full result<<END>>';
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: responseText }] } }] }),
    );
  }

  const client = createGeminiClient({
    fetchImpl: fetchStub as typeof fetch,
    config: { MAX_OUTPUT_TOKENS: 8192 },
  });
  const result = await client.callGemini({
    apiKey: 'fake-key',
    userContent: 'hello',
    enableThinking: false,
    telemetryMeta: {},
    callOptions: { retryIfTruncated: true },
    modelOverride: 'gemini-3.7-flash',
  });

  expect(result?.truncated).toBeFalsy();
  expect(seenMaxOutput).toEqual([8192, 8192]);
}
test(
  'gemini-client: truncation retries stay within the selected model output limit',
  geminiClientTruncationRetryRespectsModelOutputLimitTest,
);

async function geminiClientRetriesMaxTokensWithoutMarkersTest(): Promise<void> {
  let callCount = 0;
  async function fetchStub(_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    void _input;
    void _init;
    callCount += 1;
    return {
      ok: true,
      status: 200,
      text: async function (): Promise<string> {
        return JSON.stringify({
          candidates: [
            {
              finishReason: callCount === 1 ? 'MAX_TOKENS' : 'STOP',
              content: { parts: [{ text: callCount === 1 ? 'partial result' : 'full result' }] },
            },
          ],
        });
      },
    } as unknown as Response;
  }

  const client = createGeminiClient({ fetchImpl: fetchStub as typeof fetch });
  const result = await client.callGemini({
    apiKey: 'fake-key',
    userContent: 'hello',
    enableThinking: false,
    telemetryMeta: {},
    callOptions: {
      maxOutputTokens: 256,
      retryIfTruncated: true,
      retryIfTruncatedMaxRetries: 1,
    },
  });

  expect(callCount).toBe(2);
  expect(result?.text).toBe('full result');
  expect(result?.truncated).toBe(false);
}
test(
  'gemini-client: retries MAX_TOKENS responses without response markers',
  geminiClientRetriesMaxTokensWithoutMarkersTest,
);

test('gemini-client: preserves MAX_TOKENS when marker parsing fails', () => {
  const logger: Logger = {
    log: function (): void {
      throw new Error('logger unavailable');
    },
  };

  const result = parseCandidates(
    {
      candidates: [
        {
          finishReason: 'MAX_TOKENS',
          content: { parts: [{ text: '<<START>>partial result' }] },
        },
      ],
    },
    logger,
  );

  expect(result?.truncated).toBe(true);
});
