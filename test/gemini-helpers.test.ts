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
    flush: () => Promise.resolve(),
    flushSync: () => {
      /* ignore */
    },
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
  // fallback path (no details): returns exponential backoff
  const ms2 = getRetryMsFromResponse('{}', 1000, 60000, 2);
  // attempt=2 => base <= ms2 <= retryMax + jitter
  expect(ms2).toBeGreaterThanOrEqual(2000);
  expect(ms2).toBeLessThanOrEqual(61000);
}
test('gemini-helpers: getRetryMsFromResponse', geminiHelpersGetRetryMsFromResponseTest);
