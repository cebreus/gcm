import { setTimeout as wait } from 'node:timers/promises';
import { retryDelayMs } from './retry-backoff.js';

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * Parses a provider base URL and refuses anything that could reach a host the
 * user did not configure: credentials in the URL, a query or fragment, and
 * plaintext HTTP to anything but a literal loopback authority. The raw
 * authority is checked alongside the parsed hostname so obfuscated loopback
 * forms such as `http://2130706433` are rejected rather than normalised.
 */
export function parseProviderBaseUrl(
  baseUrl: string,
  label: string,
  options: { allowHttps: boolean; loopbackError: string },
): URL {
  const invalid = (): Error => new Error(`Invalid ${label} URL`);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw invalid();
  }
  const overHttps = options.allowHttps && url.protocol === 'https:';
  if (!overHttps && url.protocol !== 'http:') throw invalid();
  if (url.username !== '' || url.password !== '') throw invalid();
  if (baseUrl.includes('?') || baseUrl.includes('#')) throw invalid();
  if (overHttps) return url;
  if (!LOOPBACK_HOSTNAMES.includes(url.hostname)) throw new Error(options.loopbackError);
  const authority = baseUrl.slice('http://'.length).split(/[/?#]/, 1)[0] ?? '';
  const rawHostname = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : (authority.split(':', 1)[0] ?? '');
  if (!LOOPBACK_HOSTNAMES.includes(rawHostname)) throw invalid();
  return url;
}

const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export async function readResponseBody(response: Response): Promise<string> {
  if (!response.body) return response.text();
  let bytesRead = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: function (chunk, controller): void {
        bytesRead += chunk.byteLength;
        if (bytesRead > MAX_RESPONSE_BODY_BYTES) throw new Error('response body too large');
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body).text();
}

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RetryPolicy {
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export interface ProviderHttpResult {
  response: Response;
  body: string;
  attempt: number;
}

function headerDelayMs(response: Response): number | null {
  const value = response.headers?.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function isRetryableStatus(status: number, method = 'GET'): boolean {
  if (status === 429 || status === 503) return true;
  if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') return false;
  return status === 502 || status === 504;
}

function mustStopNetworkRetry(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'TimeoutError' || error.name === 'AbortError' || /redirect/i.test(error.message)
  );
}

export async function requestProviderText(params: {
  url: URL;
  init?: RequestInit;
  timeoutMs: number;
  retry: RetryPolicy;
  retryNetworkErrors: boolean;
  fetchImpl?: ProviderFetch;
  sleep?: (milliseconds: number) => Promise<unknown>;
  onAttempt?(attempt: number): void;
  onResponse?(result: ProviderHttpResult): void;
  onRetry?(status: number, attempt: number, delayMs: number): void;
}): Promise<ProviderHttpResult> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs);
  const signal = params.init?.signal
    ? AbortSignal.any([params.init.signal, timeoutSignal])
    : timeoutSignal;
  const sleep =
    params.sleep ??
    function (milliseconds: number) {
      return wait(milliseconds, undefined, { signal });
    };

  for (let attempt = 1; ; attempt += 1) {
    params.onAttempt?.(attempt);
    let response: Response;
    try {
      response = await fetchImpl(params.url, {
        ...params.init,
        redirect: 'error',
        signal,
      });
    } catch (error) {
      const retry = params.retryNetworkErrors && !mustStopNetworkRetry(error);
      if (!retry || attempt > params.retry.maxRetries) throw error;
      const delayMs = retryDelayMs('', params.retry.retryBaseMs, params.retry.retryMaxMs, attempt);
      params.onRetry?.(0, attempt, delayMs);
      await sleep(delayMs);
      continue;
    }

    const body = await readResponseBody(response);
    const result = { response, body, attempt };
    params.onResponse?.(result);
    if (
      !isRetryableStatus(response.status, params.init?.method) ||
      attempt > params.retry.maxRetries
    ) {
      return result;
    }

    const fallbackMs = retryDelayMs(
      body,
      params.retry.retryBaseMs,
      params.retry.retryMaxMs,
      attempt,
    );
    const delayMs = Math.min(params.retry.retryMaxMs, headerDelayMs(response) ?? fallbackMs);
    params.onRetry?.(response.status, attempt, delayMs);
    await sleep(delayMs);
  }
}
