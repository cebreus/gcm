import { test, expect } from 'bun:test';
import { tryParseJSON, parseCandidates, getRetryMsFromResponse } from '../src/gemini-client';
import type { Logger } from '../src/logger';

async function geminiHelpersTryParseJSONTest(): Promise<void> {
  let logged = false;
  function loggerLog(): void {
    logged = true;
  }
  const logger: Logger = {
    log: loggerLog,
  };
  expect(() => tryParseJSON(logger, 'this is not json')).toThrow();
  expect(logged).toBe(true);
}
test('gemini-helpers: tryParseJSON', geminiHelpersTryParseJSONTest);

async function geminiHelpersParseCandidatesTest(): Promise<void> {
  const json = {
    candidates: [
      {
        content: {
          parts: [{ text: 'BRANCH: feat/test' }, { text: '\nCOMMIT_MESSAGE: feat: test' }],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 },
  };
  const parsed = parseCandidates(json);
  expect(parsed?.text).toContain('BRANCH: feat/test');
  expect(parsed?.usage.promptTokens).toBe(12);
  expect(parsed?.usage.outputTokens).toBe(34);
}
test('gemini-helpers: parseCandidates', geminiHelpersParseCandidatesTest);

async function geminiHelpersGetRetryMsFromResponseTest(): Promise<void> {
  const textRes = JSON.stringify({
    error: {
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.01s' }],
    },
  });
  const ms = getRetryMsFromResponse(textRes, 100, 1000, 1);
  expect(ms).toBeGreaterThanOrEqual(10);
  expect(ms).toBeLessThanOrEqual(11);
  const cappedMs = getRetryMsFromResponse(
    JSON.stringify({ error: { details: [{ retryInfo: { retryDelay: '86400s' } }] } }),
    1000,
    60000,
    1,
  );
  expect(cappedMs).toBe(60000);
  const negativeMs = getRetryMsFromResponse(
    JSON.stringify({ error: { details: [{ retryInfo: { retryDelay: '-10s' } }] } }),
    1000,
    60000,
    1,
  );
  expect(negativeMs).toBe(0);
  // fallback path (no details): returns exponential backoff
  const ms2 = getRetryMsFromResponse('{}', 1000, 60000, 2);
  // attempt=2 => base <= ms2 <= retryMax + jitter
  expect(ms2).toBeGreaterThanOrEqual(2000);
  expect(ms2).toBeLessThanOrEqual(60000);

  const originalRandom = Math.random;
  Math.random = function (): number {
    return 0.999;
  };
  try {
    expect(getRetryMsFromResponse('{}', 60000, 60000, 1)).toBe(60000);
  } finally {
    Math.random = originalRandom;
  }
}
test('gemini-helpers: getRetryMsFromResponse', geminiHelpersGetRetryMsFromResponseTest);

async function geminiHelpersParseCandidatesFencingTest(): Promise<void> {
  const json = {
    candidates: [
      {
        content: {
          parts: [{ text: '```json\n{"foo":"bar"}\n```' }],
        },
      },
    ],
  };
  const parsed = parseCandidates(json);
  expect(parsed?.text).toBe('{"foo":"bar"}');
}
test('gemini-helpers: parseCandidates strips code fences', geminiHelpersParseCandidatesFencingTest);

async function geminiHelpersParseCandidatesMarkersTest(): Promise<void> {
  let warned = false;
  const logger = {
    log: (_: any, message: string) => {
      if (message.includes('missing <<END>>')) warned = true;
    },
  } as unknown as Logger;

  const jsonComplete = {
    candidates: [
      {
        content: { parts: [{ text: 'prefix <<START>>the important part<<END>> suffix' }] },
      },
    ],
  };
  const parsedComplete = parseCandidates(jsonComplete, logger);
  expect(parsedComplete?.text).toBe('the important part');

  const jsonMissingEnd = {
    candidates: [
      {
        content: { parts: [{ text: 'prefix <<START>>partial result...' }] },
      },
    ],
  };
  const parsedMissing = parseCandidates(jsonMissingEnd, logger);
  expect(parsedMissing?.text).toBe('partial result...');
  expect(warned).toBe(true);
}
test(
  'gemini-helpers: parseCandidates markers and missing end warning',
  geminiHelpersParseCandidatesMarkersTest,
);
