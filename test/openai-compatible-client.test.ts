import { expect, test } from 'bun:test';
import { requestLanguageModelJson } from '../src/openai-compatible-client.js';
import { requestProviderText } from '../src/provider-http.js';

const retry = { maxRetries: 2, retryBaseMs: 10, retryMaxMs: 100 };

test('OpenAI-compatible transport retries transient HTTP failures', async function () {
  let calls = 0;
  const delays: number[] = [];
  const payload = await requestLanguageModelJson({
    providerLabel: 'Test provider',
    url: new URL('https://example.test/v1/models'),
    timeoutMs: 1_000,
    retry,
    sleep: async function (milliseconds) {
      delays.push(milliseconds);
    },
    fetchImpl: async function () {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          { error: { details: [{ '@type': 'RetryInfo', retryDelay: '0.02s' }] } },
          { status: 503, headers: { 'retry-after': '0.01' } },
        );
      }
      return Response.json({ ok: true });
    },
  });

  expect(payload).toEqual({ ok: true });
  expect(calls).toBe(2);
  expect(delays).toEqual([10]);
});

test('OpenAI-compatible transport retries network failures within its bound', async function () {
  let calls = 0;
  const payload = await requestLanguageModelJson({
    providerLabel: 'Test provider',
    url: new URL('https://example.test/v1/models'),
    timeoutMs: 1_000,
    retry,
    sleep: async function () {},
    fetchImpl: async function () {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return Response.json({ ok: true });
    },
  });

  expect(payload).toEqual({ ok: true });
  expect(calls).toBe(3);
});

test('OpenAI-compatible transport does not retry permanent HTTP failures', async function () {
  let calls = 0;
  await expect(
    requestLanguageModelJson({
      providerLabel: 'Test provider',
      url: new URL('https://example.test/v1/models'),
      timeoutMs: 1_000,
      retry,
      sleep: async function () {},
      fetchImpl: async function () {
        calls += 1;
        return Response.json({ error: 'bad request' }, { status: 400 });
      },
    }),
  ).rejects.toMatchObject({ message: 'Test provider request failed (400)' });
  expect(calls).toBe(1);
});

test('OpenAI-compatible transport does not retry ambiguous gateway failures for POST', async function () {
  let calls = 0;
  await expect(
    requestLanguageModelJson({
      providerLabel: 'Test provider',
      url: new URL('https://example.test/v1/chat/completions'),
      init: { method: 'POST' },
      timeoutMs: 1_000,
      retry,
      sleep: async function () {},
      fetchImpl: async function () {
        calls += 1;
        return Response.json({ error: 'gateway failed' }, { status: 504 });
      },
    }),
  ).rejects.toMatchObject({ message: 'Test provider request failed (504)' });
  expect(calls).toBe(1);
});

test('provider transport aborts during retry backoff', async function () {
  const controller = new AbortController();
  let calls = 0;
  const startedAt = performance.now();
  const operation = requestProviderText({
    url: new URL('https://example.test/v1/models'),
    init: { signal: controller.signal },
    timeoutMs: 5_000,
    retry: { maxRetries: 2, retryBaseMs: 1_000, retryMaxMs: 1_000 },
    retryNetworkErrors: true,
    fetchImpl: async function () {
      calls += 1;
      setTimeout(function () {
        controller.abort(new DOMException('cancelled', 'AbortError'));
      }, 0);
      return new Response('retry later', { status: 503 });
    },
  });

  await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(1);
  expect(performance.now() - startedAt).toBeLessThan(500);
});

test('provider transport combines caller cancellation with its timeout', async function () {
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  let receivedAborted = false;
  let receivedCallerSignal = false;
  await expect(
    requestProviderText({
      url: new URL('https://example.test/v1/models'),
      init: { signal: controller.signal },
      timeoutMs: 1_000,
      retry,
      retryNetworkErrors: true,
      fetchImpl: async function (_input, init) {
        const signal = init?.signal;
        receivedAborted = signal?.aborted ?? false;
        receivedCallerSignal = signal === controller.signal;
        if (signal?.aborted) throw signal.reason;
        return Response.json({ ok: true });
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(receivedCallerSignal).toBe(false);
  expect(receivedAborted).toBe(true);
});
