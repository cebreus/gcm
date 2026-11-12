import { setTimeout as wait } from 'node:timers/promises';

import {
  BYTES_PER_KIBIBYTE,
  HTTP_STATUS_BAD_GATEWAY,
  HTTP_STATUS_GATEWAY_TIMEOUT,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  MILLISECONDS_PER_SECOND,
} from './constants.js';
import type { Logger } from './logger.js';
import { retryDelayMs } from './retry-backoff.js';
import {
  hasText,
  redactSensitiveText,
  redactSensitiveTextForPrompt,
} from './utils.js';

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
const MAX_RESPONSE_BODY_BYTES = BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;
const TRACE_BODY_KIBIBYTES = 32;
const MAX_TRACED_BODY_CHARS = TRACE_BODY_KIBIBYTES * BYTES_PER_KIBIBYTE;

function parseUrl(baseUrl: string, invalid: () => Error): URL {
  try {
    return new URL(baseUrl);
  } catch {
    throw invalid();
  }
}

function validateProviderUrlShape(
  baseUrl: string,
  url: URL,
  allowHttps: boolean,
  invalid: () => Error,
): boolean {
  const overHttps = allowHttps && url.protocol === 'https:';
  if (!overHttps && url.protocol !== 'http:') {
    throw invalid();
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid();
  }
  if (baseUrl.includes('?') || baseUrl.includes('#')) {
    throw invalid();
  }
  return overHttps;
}

function rawHttpHostname(baseUrl: string): string {
  const authority =
    baseUrl.slice('http://'.length).split(/(?:\/|\?|#)/v, 1)[0] ?? '';
  return authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : (authority.split(':', 1)[0] ?? '');
}

/** The raw authority is checked alongside the parsed hostname so obfuscated loopback forms such as `http://2130706433` are rejected rather than normalised. */
export function parseProviderBaseUrl(
  baseUrl: string,
  label: string,
  options: { allowHttps: boolean; loopbackError: string },
): URL {
  const invalid = (): Error => new Error(`Invalid ${label} URL`);
  const url = parseUrl(baseUrl, invalid);
  const overHttps = validateProviderUrlShape(
    baseUrl,
    url,
    options.allowHttps,
    invalid,
  );
  if (overHttps) {
    return url;
  }
  if (!LOOPBACK_HOSTNAMES.includes(url.hostname)) {
    throw new Error(options.loopbackError);
  }
  const rawHostname = rawHttpHostname(baseUrl);
  if (!LOOPBACK_HOSTNAMES.includes(rawHostname)) {
    throw invalid();
  }
  return url;
}

export class ResponseBodyTooLargeError extends Error {
  constructor(message = 'response body too large') {
    super(message);
  }
}

/** Matches how `fetch` reports its own deadline or a caller cancellation. */
export function isRequestTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

async function readResponseBody(response: Response): Promise<string> {
  if (response.body === null) {
    return await response.text();
  }
  let bytesRead = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller): void => {
        bytesRead += chunk.byteLength;
        if (bytesRead > MAX_RESPONSE_BODY_BYTES) {
          throw new ResponseBodyTooLargeError();
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return await new Response(body).text();
}

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// Redaction runs before truncation: slicing first can cut a secret short of
// the pattern that would have matched it and log the remainder verbatim.
function traceBody(body: string, token?: string): string {
  const withoutToken = hasText(token)
    ? body.replaceAll(token, '[REDACTED-TOKEN]')
    : body;
  return redactSensitiveText(redactSensitiveTextForPrompt(withoutToken)).slice(
    0,
    MAX_TRACED_BODY_CHARS,
  );
}

/** Logs request and response bodies, never headers: tokens travel there. A body may echo the token. */
export function withRequestTrace(
  logger: Logger,
  fetchImpl: ProviderFetch,
  label: string,
  token?: string,
): ProviderFetch {
  return async (input, init) => {
    logger.log('debug', `${label} API request`, {
      url: input instanceof Request ? input.url : String(input),
      body: traceBody(providerBodyText(init?.body), token),
    });
    const response = await fetchImpl(input, init);
    const body = await readResponseBody(response.clone())
      .then((text) => traceBody(text, token))
      .catch(() => '[response body too large]');
    logger.log('debug', `${label} API response`, {
      status: response.status,
      body,
    });
    return response;
  };
}

function providerBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return body === null || body === undefined ? '' : '[non-text body]';
}

interface RetryPolicy {
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

interface ProviderHttpResult {
  response: Response;
  body: string;
}

function headerDelayMs(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!hasText(value)) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * MILLISECONDS_PER_SECOND);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return null;
  }
  return Math.max(0, date - Date.now());
}

function isRetryableStatus(status: number, method = 'GET'): boolean {
  if (
    status === HTTP_STATUS_TOO_MANY_REQUESTS ||
    status === HTTP_STATUS_SERVICE_UNAVAILABLE
  ) {
    return true;
  }
  if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
    return false;
  }
  return (
    status === HTTP_STATUS_BAD_GATEWAY || status === HTTP_STATUS_GATEWAY_TIMEOUT
  );
}

function mustStopNetworkRetry(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return isRequestTimeout(error) || /redirect/iv.test(error.message);
}

interface FetchAttemptOptions {
  fetchImpl: ProviderFetch;
  url: URL;
  init?: RequestInit;
  signal: AbortSignal;
}

type FetchAttemptResult = { response: Response } | { error: unknown };

async function fetchProviderAttempt(
  options: FetchAttemptOptions,
): Promise<FetchAttemptResult> {
  try {
    return {
      response: await options.fetchImpl(options.url, {
        ...options.init,
        redirect: 'error',
        signal: options.signal,
      }),
    };
  } catch (error) {
    return { error };
  }
}

async function waitForNetworkRetry(
  params: Parameters<typeof requestProviderText>[0],
  error: unknown,
  attempt: number,
  sleep: (milliseconds: number) => Promise<unknown>,
): Promise<void> {
  const canRetry =
    params.retryNetworkErrors &&
    !mustStopNetworkRetry(error) &&
    attempt <= params.retry.maxRetries;
  if (!canRetry) {
    throw error instanceof Error
      ? error
      : new Error('Provider request failed', { cause: error });
  }
  const delayMs = retryDelayMs(
    '',
    params.retry.retryBaseMs,
    params.retry.retryMaxMs,
    attempt,
  );
  await sleep(delayMs);
}

interface ResponseRetryOptions {
  response: Response;
  body: string;
  retry: RetryPolicy;
  attempt: number;
  method?: string;
}

function responseRetryDelay(options: ResponseRetryOptions): number | null {
  const { response, body, retry, attempt, method } = options;
  if (
    !isRetryableStatus(response.status, method) ||
    attempt > retry.maxRetries
  ) {
    return null;
  }
  const fallbackMs = retryDelayMs(
    body,
    retry.retryBaseMs,
    retry.retryMaxMs,
    attempt,
  );
  return Math.min(retry.retryMaxMs, headerDelayMs(response) ?? fallbackMs);
}

export async function requestProviderText(params: {
  url: URL;
  init?: RequestInit;
  timeoutMs: number;
  retry: RetryPolicy;
  retryNetworkErrors: boolean;
  fetchImpl?: ProviderFetch;
  sleep?: (milliseconds: number) => Promise<unknown>;
}): Promise<ProviderHttpResult> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs);
  const signal =
    params.init?.signal !== undefined && params.init.signal !== null
      ? AbortSignal.any([params.init.signal, timeoutSignal])
      : timeoutSignal;
  const sleep =
    params.sleep ??
    (async (milliseconds: number) => {
      await wait(milliseconds, undefined, { signal });
    });

  for (let attempt = 1; ; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- retries require ordered network attempts
    const attemptResult = await fetchProviderAttempt({
      fetchImpl,
      url: params.url,
      init: params.init,
      signal,
    });
    if ('error' in attemptResult) {
      // eslint-disable-next-line no-await-in-loop -- retry backoff must finish before next attempt
      await waitForNetworkRetry(params, attemptResult.error, attempt, sleep);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- each response must be read before retry decision
    const body = await readResponseBody(attemptResult.response);
    const { response } = attemptResult;
    const result = { response, body };
    const delayMs = responseRetryDelay({
      response,
      body,
      retry: params.retry,
      attempt,
      method: params.init?.method,
    });
    if (delayMs === null) {
      return result;
    }
    // eslint-disable-next-line no-await-in-loop -- retry backoff must finish before next attempt
    await sleep(delayMs);
  }
}
