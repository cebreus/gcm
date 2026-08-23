import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGeminiClient } from '../src/gemini-client';
import type { GeminiClient, GeminiResponse } from '../src/gemini-client';
import { parseCandidates } from '../src/gemini-client/parsers';
import type { Logger } from '../src/logger';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function geminiClientSuccessTest(): Promise<void> {
  let called = false;
  let requestedUrl = '';
  const origFetch = globalThis.fetch;
  async function fetchStub(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    requestedUrl = String(input);
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
      telemetryMeta: {},
      callOptions: { maxOutputTokens: 512, systemInstructions: 'instr' },
      modelOverride: '',
    });
    expect(called).toBe(true);
    expect(res?.text).toContain('BRANCH:');
    expect(res?.usage.promptTokens).toBe(10);
    expect(requestedUrl).toContain('/gemini-3.7-flash:generateContent');
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
    expect(stderr).toContain(
      `Refusing to write debug log ${JSON.stringify(debugPath)}: it is a symbolic link.`,
    );
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

test('gemini-client: caps debug bodies at UTF-8 character boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gcm-debug-utf8-body-'));
  const debugPath = join(directory, '.debug.log');
  const userContent = 'é漢😀tail';

  async function fetchStub(_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
    void _input;
    void _init;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  }

  try {
    const client = createGeminiClient({
      fetchImpl: fetchStub as typeof fetch,
      config: {
        DEBUG_API: true,
        DEBUG_FILE: debugPath,
        DEBUG_MAX_BODY_LOG_BYTES: 15,
      },
    });
    await client.callGemini({
      apiKey: 'fake-key',
      userContent,
      telemetryMeta: {},
      callOptions: {},
    });

    await Bun.sleep(10);
    const debugLog = await readFile(debugPath, 'utf8');
    expect(debugLog).toContain(`API REQUEST USER CONTENT (text):\n<<START>>\né漢...[TRUNCATED]`);
    expect(debugLog).not.toContain('\uFFFD');

    const surrogateDebugPath = join(directory, '.debug-surrogate.log');
    const surrogateClient = createGeminiClient({
      fetchImpl: fetchStub as typeof fetch,
      config: {
        DEBUG_API: true,
        DEBUG_FILE: surrogateDebugPath,
        DEBUG_MAX_BODY_LOG_BYTES: 12,
      },
    });
    await surrogateClient.callGemini({
      apiKey: 'fake-key',
      userContent,
      telemetryMeta: {},
      callOptions: {},
    });
    await Bun.sleep(10);
    const surrogateDebugLog = await readFile(surrogateDebugPath, 'utf8');
    expect(surrogateDebugLog).toContain(
      `API REQUEST USER CONTENT (text):\n<<START>>\né...[TRUNCATED]`,
    );
    expect(surrogateDebugLog).not.toContain('\uFFFD');
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
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      const generationConfig = isRecord(body) ? body.generationConfig : undefined;
      const maxOut = isRecord(generationConfig) ? generationConfig.maxOutputTokens : undefined;
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
      config: { MAX_OUTPUT_TOKENS: 256 },
    });
    const res = await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
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
  const warnings: string[] = [];
  async function fetchStub(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    void _input;
    callCount += 1;
    const requestBody: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    if (
      typeof requestBody === 'object' &&
      requestBody !== null &&
      'generationConfig' in requestBody
    ) {
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
    config: { MAX_OUTPUT_TOKENS: 65_536 },
    logger: {
      log: function (level, message): void {
        if (level === 'warn') warnings.push(message);
      },
    },
  });
  const result = await client.callGemini({
    apiKey: 'fake-key',
    userContent: 'hello',
    telemetryMeta: {},
    callOptions: { retryIfTruncated: true },
    modelOverride: 'gemini-3.7-flash',
  });

  expect(result?.truncated).toBe(true);
  expect(seenMaxOutput).toEqual([8192]);
  expect(warnings).toContain(
    "Gemini response was truncated because the model's output limit was reached.",
  );
}
test(
  'gemini-client: stops truncation retries at the selected model output limit',
  geminiClientTruncationRetryRespectsModelOutputLimitTest,
);

test('gemini-client: rejects invalid direct output-token overrides', async () => {
  const seen: number[] = [];
  async function fetchStub(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const body: unknown = JSON.parse(String(init?.body));
    if (typeof body === 'object' && body !== null && 'generationConfig' in body) {
      const generationConfig = body.generationConfig;
      if (
        typeof generationConfig === 'object' &&
        generationConfig !== null &&
        'maxOutputTokens' in generationConfig &&
        typeof generationConfig.maxOutputTokens === 'number'
      ) {
        seen.push(generationConfig.maxOutputTokens);
      }
    }
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '<<START>>ok<<END>>' }] } }] }),
    );
  }
  const client = createGeminiClient({
    config: { MAX_OUTPUT_TOKENS: 8192 },
    fetchImpl: fetchStub as typeof fetch,
  });

  for (const maxOutputTokens of [-1, 1.5]) {
    await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      telemetryMeta: {},
      callOptions: { maxOutputTokens },
      modelOverride: 'gemini-3.7-flash',
    });
  }

  expect(seen).toEqual([8192, 8192]);
});

test('gemini-client: rejects invalid truncation-retry token increments', async () => {
  const seen: number[] = [];
  let callCount = 0;
  async function fetchStub(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const body = JSON.parse(String(init?.body)) as {
      generationConfig: { maxOutputTokens: number };
    };
    seen.push(body.generationConfig.maxOutputTokens);
    callCount += 1;
    const text = callCount % 2 === 1 ? '<<START>>partial' : '<<START>>ok<<END>>';
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  }
  const client = createGeminiClient({
    config: { MAX_OUTPUT_TOKENS: 8192 },
    fetchImpl: fetchStub as typeof fetch,
  });

  for (const retryIfTruncatedIncreaseTokens of [-1, 1.5]) {
    await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      telemetryMeta: {},
      callOptions: {
        maxOutputTokens: 256,
        retryIfTruncated: true,
        retryIfTruncatedMaxRetries: 1,
        retryIfTruncatedIncreaseTokens,
      },
      modelOverride: 'gemini-3.7-flash',
    });
  }

  expect(seen).toEqual([256, 8192, 256, 8192]);
});

test('gemini-client: bounds invalid direct truncation-retry counts', async () => {
  const calls: number[] = [];

  for (const retryIfTruncatedMaxRetries of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    let callCount = 0;
    async function fetchStub(
      _input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> {
      callCount += 1;
      const text = callCount === 1 ? '<<START>>partial' : '<<START>>ok<<END>>';
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    }
    const client = createGeminiClient({
      config: { MAX_OUTPUT_TOKENS: 8192 },
      fetchImpl: fetchStub as typeof fetch,
    });
    await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      telemetryMeta: {},
      callOptions: {
        maxOutputTokens: 256,
        retryIfTruncated: true,
        retryIfTruncatedMaxRetries,
        retryIfTruncatedIncreaseTokens: 256,
      },
      modelOverride: 'gemini-3.7-flash',
    });
    calls.push(callCount);
  }

  expect(calls).toEqual([2, 2, 2]);
});

test('gemini-client: rejects invalid direct timeout values', async () => {
  const aborted: boolean[] = [];
  async function fetchStub(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
    await Bun.sleep(5);
    aborted.push(init?.signal?.aborted ?? false);
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '<<START>>ok<<END>>' }] } }] }),
    );
  }
  const client = createGeminiClient({
    config: { MAX_OUTPUT_TOKENS: 8192 },
    fetchImpl: fetchStub as typeof fetch,
  });

  for (const timeoutMs of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32]) {
    await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      telemetryMeta: {},
      callOptions: { timeoutMs },
    });
  }

  expect(aborted).toEqual([false, false, false, false, false, false]);
});

test('gemini-client: bounds retry config injected through its public factory', async () => {
  let calls = 0;
  async function fetchStub(): Promise<Response> {
    calls += 1;
    if (calls <= 5) throw new Error('network fail');
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '<<START>>ok<<END>>' }] } }] }),
    );
  }
  const client = createGeminiClient({
    config: {
      GEMINI_MAX_RETRIES: Number.POSITIVE_INFINITY,
      GEMINI_RETRY_BASE_MS: 1,
      GEMINI_RETRY_MAX_MS: 1,
    },
    fetchImpl: fetchStub as unknown as typeof fetch,
  });

  await expect(
    client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      telemetryMeta: {},
      callOptions: {},
    }),
  ).rejects.toThrow('network fail');
  expect(calls).toBe(4);
});

test('gemini-client: normalizes invalid injected temperatures', async () => {
  const temperatures: number[] = [];
  async function fetchStub(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const body = JSON.parse(String(init?.body)) as { generationConfig: { temperature: number } };
    temperatures.push(body.generationConfig.temperature);
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '<<START>>ok<<END>>' }] } }] }),
    );
  }
  for (const temperature of [-1, Number.POSITIVE_INFINITY]) {
    const client = createGeminiClient({
      config: { TEMP: temperature },
      fetchImpl: fetchStub as typeof fetch,
    });
    await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'hello',
      telemetryMeta: {},
      callOptions: {},
    });
  }
  expect(temperatures).toEqual([1, 1]);
});

test('gemini-client: normalizes an unsafe injected debug-body limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gcm-debug-invalid-limit-'));
  const debugPath = join(directory, '.debug.log');
  const tail = 'must-not-be-logged';
  async function fetchStub(): Promise<Response> {
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '<<START>>ok<<END>>' }] } }] }),
    );
  }
  try {
    const client = createGeminiClient({
      config: { DEBUG_API: true, DEBUG_FILE: debugPath, DEBUG_MAX_BODY_LOG_BYTES: -1 },
      fetchImpl: fetchStub as unknown as typeof fetch,
    });
    await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'x'.repeat(40_000) + tail,
      telemetryMeta: {},
      callOptions: {},
    });
    await Bun.sleep(10);
    const debugLog = await readFile(debugPath, 'utf8');
    expect(debugLog).toContain('[TRUNCATED]');
    expect(debugLog).not.toContain(tail);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gemini-client: preserves a valid debug-body limit above its default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gcm-debug-valid-limit-'));
  const debugPath = join(directory, '.debug.log');
  const tail = 'must-be-logged';
  async function fetchStub(): Promise<Response> {
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '<<START>>ok<<END>>' }] } }] }),
    );
  }
  try {
    const client = createGeminiClient({
      config: { DEBUG_API: true, DEBUG_FILE: debugPath, DEBUG_MAX_BODY_LOG_BYTES: 65_536 },
      fetchImpl: fetchStub as unknown as typeof fetch,
    });
    await client.callGemini({
      apiKey: 'fake-key',
      userContent: 'x'.repeat(40_000) + tail,
      telemetryMeta: {},
      callOptions: {},
    });
    await Bun.sleep(10);
    const debugLog = await readFile(debugPath, 'utf8');
    expect(debugLog).not.toContain('[TRUNCATED]');
    expect(debugLog).toContain(tail);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
