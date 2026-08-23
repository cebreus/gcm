import { dlopen, read, type Pointer } from 'bun:ffi';
import { CONFIG } from '../../gcm.config.js';
import { createLogger } from '../logger.js';
import type { Logger, LoggerConfig, LogMetadata } from '../logger.js';
import { tryParseJSON, parseCandidates } from './parsers.js';
import { addJitterWithinCap, getRetryMsFromResponse } from './backoff.js';
import { buildRequestBody } from './requestBuilder.js';
import { GeminiApiError } from './errors.js';
import { unescapeNewlinesInText } from '../utils.js';
import { DEFAULT_MAX_DEBUG_LOG_BYTES, MAX_DEBUG_LOG_BYTES } from '../constants.js';
import { normalizeRetryConfig } from '../config-values.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  getEffectiveMaxOutputTokens,
  getModelSpec,
} from '../model-registry.js';

export interface GeminiUsage {
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface GeminiResponse {
  text: string;
  usage: GeminiUsage;
  // If true, the response appears truncated (missing <<END>> or had <<END_TRUNCATED>> marker).
  truncated?: boolean;
}

export interface GeminiCallOpts {
  timeoutMs?: number;
  systemInstructions?: string;
  maxOutputTokens?: number;
  // If true, the client will automatically retry when a truncated response is detected.
  retryIfTruncated?: boolean;
  // How many times to retry after a truncated response. Default: 1
  retryIfTruncatedMaxRetries?: number;
  // How many extra maxOutputTokens to add on each retry. Default: add CONFIG.MAX_OUTPUT_TOKENS
  retryIfTruncatedIncreaseTokens?: number;
}

export interface GeminiClient {
  callGemini: (params: {
    apiKey: string;
    userContent: string;
    telemetryMeta: LogMetadata;
    callOptions: GeminiCallOpts;
    modelOverride?: string;
  }) => Promise<GeminiResponse | null>;
}

interface GeminiClientOptions {
  config?: Partial<typeof CONFIG>;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

interface CallState {
  attempt: number;
  truncRetries: number;
  currentMaxOutputTokens: number;
}

interface CallSetup {
  opts: GeminiCallOpts;
  start: number;
  urlBase: string;
  truncMaxRetries: number;
  truncIncrease: number;
  maxOutputTokensLimit: number;
}

interface GeminiClientDeps {
  config: typeof CONFIG;
  logger: Logger;
  writeDebug: (label: string, data: unknown) => void;
  fetchImpl: typeof fetch;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

interface DebugFileApi {
  open(path: string, flags: number, mode: number): number;
  close(fileDescriptor: number): number;
  fchmod(fileDescriptor: number, mode: number): number;
  __error?(): Pointer;
  __errno_location?(): Pointer;
}

const DEBUG_FILE_MODE = 0o600;

function createDebugFileApi(): {
  api: DebugFileApi;
  noFollowFlag: number;
  nonBlockFlag: number;
  loopError: number;
} {
  if (process.platform === 'darwin') {
    return {
      api: dlopen('/usr/lib/libSystem.B.dylib', {
        open: { args: ['cstring', 'i32', 'i32'], returns: 'i32' },
        close: { args: ['i32'], returns: 'i32' },
        fchmod: { args: ['i32', 'i32'], returns: 'i32' },
        __error: { args: [], returns: 'ptr' },
      }).symbols as unknown as DebugFileApi,
      noFollowFlag: 0x100,
      nonBlockFlag: 0x4,
      loopError: 62,
    };
  }
  return {
    api: dlopen('libc.so.6', {
      open: { args: ['cstring', 'i32', 'i32'], returns: 'i32' },
      close: { args: ['i32'], returns: 'i32' },
      fchmod: { args: ['i32', 'i32'], returns: 'i32' },
      __errno_location: { args: [], returns: 'ptr' },
    }).symbols as unknown as DebugFileApi,
    noFollowFlag: 0x20_000,
    nonBlockFlag: 0x800,
    loopError: 40,
  };
}

function debugFileRefusal(path: string, reason: string): Error {
  return new Error(`Refusing to write debug log ${JSON.stringify(path)}: ${reason}.`);
}

async function openDebugWriter(
  path: string,
): Promise<ReturnType<ReturnType<typeof Bun.file>['writer']>> {
  const { api, noFollowFlag, nonBlockFlag, loopError } = createDebugFileApi();
  const fileDescriptor = api.open(
    path,
    0x1 | 0x200 | 0x8 | noFollowFlag | nonBlockFlag,
    DEBUG_FILE_MODE,
  );
  if (fileDescriptor < 0) {
    const errorPointer = process.platform === 'darwin' ? api.__error?.() : api.__errno_location?.();
    const errno = errorPointer === undefined ? -1 : read.i32(errorPointer);
    if (errno === loopError) throw debugFileRefusal(path, 'it is a symbolic link');
    throw debugFileRefusal(path, 'it could not be opened without following links');
  }

  try {
    const file = Bun.file(fileDescriptor);
    const stats = await file.stat();
    if (!stats.isFile()) throw debugFileRefusal(path, 'it is not a regular file');
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      throw debugFileRefusal(path, 'it is not owned by the current user');
    }
    if (api.fchmod(fileDescriptor, DEBUG_FILE_MODE) !== 0) {
      throw debugFileRefusal(path, 'its permissions could not be set to 0600');
    }
    return file.writer();
  } catch (error) {
    api.close(fileDescriptor);
    throw error;
  }
}

function shouldRetryClientError(error: unknown): boolean {
  if (error instanceof GeminiApiError) return false;
  const errStr = String(error);
  if (/invalid json|returned no text/i.test(errStr)) return false;
  return /aborted|network|fetch|timed?\s*out|econnreset|enotfound|eai_again/i.test(errStr);
}

function createDefaultLogger(): Logger {
  return createLogger(CONFIG as LoggerConfig);
}

function createDebugLogger(config: Partial<typeof CONFIG>): (label: string, data: unknown) => void {
  let writer: ReturnType<ReturnType<typeof Bun.file>['writer']> | null = null;
  const pending: string[] = [];

  if (config.DEBUG_API && config.DEBUG_FILE) {
    pending.push(`\n\n=== Debug session started: ${new Date().toISOString()} ===\n\n`);
    void openDebugWriter(config.DEBUG_FILE)
      .then(function (openedWriter) {
        writer = openedWriter;
        for (const entry of pending) writer.write(entry);
        pending.length = 0;
        void writer.flush();
      })
      .catch(function (error: unknown) {
        pending.length = 0;
        process.stderr.write('Failed to create debug logger: ' + String(error) + '\n');
      });
  }

  return function writeDebug(label: string, data: unknown): void {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${label}:\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n\n`;
    if (!writer) {
      if (config.DEBUG_API && config.DEBUG_FILE) pending.push(entry);
      return;
    }
    writer.write(entry);
    void writer.flush();
  };
}

function capDebugBody(data: unknown, maxLog: number): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxLog) return text;
  let end = maxLog;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end)) + '...[TRUNCATED]';
}

function logDebugRequest(params: {
  deps: GeminiClientDeps;
  attempt: number;
  reqUrl: string;
  body: unknown;
  bodyStr: string;
}): void {
  const { deps, attempt, reqUrl, body, bodyStr } = params;
  if (!deps.config.DEBUG_API) return;
  const maxLog = Number(deps.config.DEBUG_MAX_BODY_LOG_BYTES || DEFAULT_MAX_DEBUG_LOG_BYTES);
  const bodyPreview = capDebugBody(bodyStr, maxLog);
  deps.writeDebug('API REQUEST', {
    attempt,
    url: reqUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    bodyLength: bodyStr.length,
    body: bodyPreview,
  });
  deps.writeDebug(
    'API REQUEST BODY (pretty-printed)',
    capDebugBody(unescapeNewlinesInText(body), maxLog),
  );
  if (
    (body as { contents?: Array<{ parts?: Array<{ text?: string }> }> })?.contents?.[0]?.parts?.[0]
      ?.text
  ) {
    deps.writeDebug(
      'API REQUEST USER CONTENT (text)',
      capDebugBody(
        (body as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0].parts[0].text,
        maxLog,
      ),
    );
  }
}

function logDebugResponse(
  deps: GeminiClientDeps,
  attempt: number,
  res: Response,
  textRes: string,
): void {
  if (!deps.config.DEBUG_API) return;
  const maxLog = Number(deps.config.DEBUG_MAX_BODY_LOG_BYTES || DEFAULT_MAX_DEBUG_LOG_BYTES);
  const bodyPreview = capDebugBody(textRes, maxLog);
  deps.writeDebug('API RESPONSE', {
    attempt,
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    bodyLength: textRes.length,
    body: bodyPreview,
  });
  try {
    const jsonRes: unknown = JSON.parse(textRes);
    deps.writeDebug(
      'API RESPONSE BODY (pretty-printed)',
      capDebugBody(unescapeNewlinesInText(jsonRes), maxLog),
    );
  } catch {
    // Not JSON
  }
}

async function fetchWithTimeout(
  deps: GeminiClientDeps,
  params: { reqUrl: string; apiKey: string; bodyStr: string; timeoutMs: number },
): Promise<{ res: Response; textRes: string }> {
  const { reqUrl, apiKey, bodyStr, timeoutMs } = params;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await deps.fetchImpl(reqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: bodyStr,
      signal: controller.signal,
    });
    const textRes = await res.text();
    return { res, textRes };
  } finally {
    clearTimeout(timer);
  }
}

async function handleHttpFailure(
  deps: GeminiClientDeps,
  attempt: number,
  res: Response,
  textRes: string,
): Promise<'retry' | 'throw'> {
  const isRetryableStatus =
    res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
  if (isRetryableStatus && attempt <= deps.maxRetries) {
    const retryMs = getRetryMsFromResponse(textRes, deps.retryBaseMs, deps.retryMaxMs, attempt);
    deps.logger.log(
      'warn',
      'Gemini API returned ' +
        String(res.status) +
        '; retrying after ' +
        String(retryMs) +
        ' ms (attempt ' +
        String(attempt) +
        ')',
    );
    await Bun.sleep(retryMs);
    return 'retry';
  }
  deps.logger.log('error', 'Gemini API failed: ' + String(res.status), { text: textRes, attempt });
  throw new GeminiApiError('Gemini API failed: ' + String(res.status), {
    status: res.status,
    snippet: textRes.slice(0, 256),
  });
}

async function handleNetworkFailure(
  deps: GeminiClientDeps,
  attempt: number,
  err: unknown,
): Promise<boolean> {
  if (!(attempt <= deps.maxRetries && shouldRetryClientError(err))) return false;
  const backoff = Math.min(deps.retryMaxMs, deps.retryBaseMs * 2 ** (attempt - 1));
  deps.logger.log(
    'warn',
    'Network error calling Gemini; retrying (' +
      String(attempt) +
      '/' +
      String(deps.maxRetries) +
      ') after ' +
      String(backoff) +
      'ms',
    { error: String(err) },
  );
  await Bun.sleep(addJitterWithinCap(backoff, deps.retryMaxMs, 300));
  return true;
}

async function handleSuccessfulResponse(
  deps: GeminiClientDeps,
  params: {
    textRes: string;
    attempt: number;
    start: number;
    telemetryMeta: LogMetadata;
    opts: GeminiCallOpts;
    truncRetries: number;
    truncMaxRetries: number;
    truncIncrease: number;
    currentMaxOutputTokens: number;
    maxOutputTokensLimit: number;
  },
): Promise<{
  retry: boolean;
  response: GeminiResponse | null;
  truncRetries: number;
  currentMaxOutputTokens: number;
}> {
  const {
    textRes,
    attempt,
    start,
    telemetryMeta,
    opts,
    truncRetries,
    truncMaxRetries,
    truncIncrease,
    currentMaxOutputTokens,
  } = params;
  const json = tryParseJSON(deps.logger, textRes) as {
    promptFeedback?: { blockReason?: string };
    candidates?: unknown[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  deps.logger.log('debug', 'Gemini API call succeeded', {
    durationMs: Date.now() - start,
    attempt,
    status: 200,
    ...telemetryMeta,
  });
  if (
    json?.promptFeedback?.blockReason &&
    json.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED'
  ) {
    throw new GeminiApiError('Gemini blocked request: ' + json.promptFeedback.blockReason, {
      json,
    });
  }
  const parsed = parseCandidates(json, deps.logger) as
    (GeminiResponse & { truncated?: boolean }) | null;
  if (!parsed) throw new GeminiApiError('Gemini returned no text', { json });
  if (!(parsed.truncated && opts.retryIfTruncated && truncRetries < truncMaxRetries)) {
    return { retry: false, response: parsed, truncRetries, currentMaxOutputTokens };
  }
  const nextMaxOutputTokens = Math.min(
    currentMaxOutputTokens + truncIncrease,
    params.maxOutputTokensLimit,
  );
  if (nextMaxOutputTokens === currentMaxOutputTokens) {
    deps.logger.log(
      'warn',
      "Gemini response was truncated because the model's output limit was reached.",
    );
    return { retry: false, response: parsed, truncRetries, currentMaxOutputTokens };
  }
  const nextTruncRetries = truncRetries + 1;
  deps.logger.log(
    'warn',
    'Gemini response appeared truncated; retrying with higher maxOutputTokens (attempt ' +
      String(nextTruncRetries) +
      '/' +
      String(truncMaxRetries) +
      ')',
    { previousTextSnippet: parsed.text.slice(0, 256) },
  );
  await Bun.sleep(50);
  return {
    retry: true,
    response: null,
    truncRetries: nextTruncRetries,
    currentMaxOutputTokens: nextMaxOutputTokens,
  };
}

function getTruncationIncrease(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}

function getTruncationMaxRetries(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 0 || value > 10) return 1;
  return value;
}

function getTimeoutMs(value: number | undefined): number {
  if (value === undefined) return 60_000;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) return 60_000;
  return value;
}

function normalizeClientConfig(config: typeof CONFIG): typeof CONFIG {
  let temperature = config.TEMP;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) temperature = 1;

  let maxOutputTokens = config.MAX_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  }

  let maxDebugBodyLogBytes = config.DEBUG_MAX_BODY_LOG_BYTES;
  if (
    !Number.isSafeInteger(maxDebugBodyLogBytes) ||
    maxDebugBodyLogBytes <= 0 ||
    maxDebugBodyLogBytes > MAX_DEBUG_LOG_BYTES
  ) {
    maxDebugBodyLogBytes = DEFAULT_MAX_DEBUG_LOG_BYTES;
  }

  const retry = normalizeRetryConfig({
    maxRetries: config.GEMINI_MAX_RETRIES,
    retryBaseMs: config.GEMINI_RETRY_BASE_MS,
    retryMaxMs: config.GEMINI_RETRY_MAX_MS,
  });
  return {
    ...config,
    TEMP: temperature,
    MAX_OUTPUT_TOKENS: maxOutputTokens,
    DEBUG_MAX_BODY_LOG_BYTES: maxDebugBodyLogBytes,
    GEMINI_MAX_RETRIES: retry.maxRetries,
    GEMINI_RETRY_BASE_MS: retry.retryBaseMs,
    GEMINI_RETRY_MAX_MS: retry.retryMaxMs,
  };
}

function buildCallSetup(
  config: typeof CONFIG,
  callOptions: GeminiCallOpts,
  modelOverride?: string,
): CallSetup {
  const opts = callOptions || {};
  const activeModel = modelOverride || config.MODEL;
  const urlBase =
    'https://generativelanguage.googleapis.com/v1beta/models/' + activeModel + ':generateContent';
  const truncMaxRetries = getTruncationMaxRetries(opts.retryIfTruncatedMaxRetries);
  const truncIncrease = getTruncationIncrease(
    opts.retryIfTruncatedIncreaseTokens,
    getEffectiveMaxOutputTokens(activeModel, config.MAX_OUTPUT_TOKENS),
  );
  return {
    opts,
    start: Date.now(),
    urlBase,
    truncMaxRetries,
    truncIncrease,
    maxOutputTokensLimit: getModelSpec(activeModel).maxOutputTokens,
  };
}

async function applySuccessfulOutcome(params: {
  deps: GeminiClientDeps;
  textRes: string;
  telemetryMeta: LogMetadata;
  setup: CallSetup;
  state: CallState;
}): Promise<'retry' | GeminiResponse | null> {
  const { deps, textRes, telemetryMeta, setup, state } = params;
  const success = await handleSuccessfulResponse(deps, {
    textRes,
    attempt: state.attempt,
    start: setup.start,
    telemetryMeta,
    opts: setup.opts,
    truncRetries: state.truncRetries,
    truncMaxRetries: setup.truncMaxRetries,
    truncIncrease: setup.truncIncrease,
    currentMaxOutputTokens: state.currentMaxOutputTokens,
    maxOutputTokensLimit: setup.maxOutputTokensLimit,
  });
  state.truncRetries = success.truncRetries;
  state.currentMaxOutputTokens = success.currentMaxOutputTokens;
  if (success.retry) return 'retry';
  return success.response;
}

async function runCallAttempt(params: {
  deps: GeminiClientDeps;
  apiKey: string;
  userContent: string;
  telemetryMeta: LogMetadata;
  setup: CallSetup;
  state: CallState;
}): Promise<'retry' | GeminiResponse | null> {
  const { deps, apiKey, userContent, telemetryMeta, setup, state } = params;
  state.attempt += 1;
  const body = buildRequestBody(userContent, deps.config, {
    ...setup.opts,
    maxOutputTokens: state.currentMaxOutputTokens,
  });
  try {
    const timeoutMs = getTimeoutMs(setup.opts.timeoutMs);
    const bodyStr = JSON.stringify(body);
    logDebugRequest({ deps, attempt: state.attempt, reqUrl: setup.urlBase, body, bodyStr });
    const { res, textRes } = await fetchWithTimeout(deps, {
      reqUrl: setup.urlBase,
      apiKey,
      bodyStr,
      timeoutMs,
    });
    logDebugResponse(deps, state.attempt, res, textRes);
    if (res.ok) return applySuccessfulOutcome({ deps, textRes, telemetryMeta, setup, state });
    const httpOutcome = await handleHttpFailure(deps, state.attempt, res, textRes);
    if (httpOutcome === 'retry') return 'retry';
    return null;
  } catch (err) {
    if (await handleNetworkFailure(deps, state.attempt, err)) return 'retry';
    throw err;
  }
}

export function createGeminiClient(userOptions?: GeminiClientOptions): GeminiClient {
  const options = userOptions || {};
  const config = normalizeClientConfig({ ...CONFIG, ...options.config });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger || createLogger(config);
  const writeDebug = createDebugLogger(config);
  const deps: GeminiClientDeps = {
    config,
    logger,
    writeDebug,
    fetchImpl,
    maxRetries: config.GEMINI_MAX_RETRIES,
    retryBaseMs: config.GEMINI_RETRY_BASE_MS,
    retryMaxMs: config.GEMINI_RETRY_MAX_MS,
  };

  const callGemini = async ({
    apiKey,
    userContent,
    telemetryMeta,
    callOptions,
    modelOverride,
  }: {
    apiKey: string;
    userContent: string;
    telemetryMeta: LogMetadata;
    callOptions: GeminiCallOpts;
    modelOverride?: string;
  }): Promise<GeminiResponse | null> => {
    if (!apiKey) throw new Error('API key required');
    const setup = buildCallSetup(config, callOptions, modelOverride);
    const state: CallState = {
      attempt: 0,
      truncRetries: 0,
      currentMaxOutputTokens: getEffectiveMaxOutputTokens(
        modelOverride || config.MODEL,
        setup.opts.maxOutputTokens ?? config.MAX_OUTPUT_TOKENS,
      ),
    };

    for (;;) {
      const outcome = await runCallAttempt({
        deps,
        apiKey,
        userContent,
        telemetryMeta,
        setup,
        state,
      });
      if (outcome === 'retry') continue;
      return outcome;
    }
  };
  return { callGemini };
}

export { tryParseJSON, parseCandidates, getRetryMsFromResponse };
