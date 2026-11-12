import { expect, test } from 'bun:test';

import { retryDelayMs } from '../src/retry-backoff';

test('retryDelayMs doubles from the base per attempt', () => {
  expect([1, 2, 3, 4].map((a) => retryDelayMs('', 100, 10_000, a))).toEqual([
    100, 200, 400, 800,
  ]);
});

test('retryDelayMs caps the exponential delay', () => {
  expect(retryDelayMs('', 100, 500, 4)).toBe(500);
});

test('retryDelayMs prefers a provider delay, capped', () => {
  const body = JSON.stringify({ error: { details: [{ retryDelay: '2s' }] } });
  expect(retryDelayMs(body, 100, 10_000, 1)).toBe(2000);
  expect(retryDelayMs(body, 100, 1000, 1)).toBe(1000);
});
