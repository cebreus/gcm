import { dlopen, read, type Pointer } from 'bun:ffi';
import { CONFIG } from '../../gcm.config.js';
import { createLogger } from '../logger.js';
import type { Logger, LogMetadata } from '../logger.js';
import { tryParseJSON, parseCandidates } from './parsers.js';
import { retryDelayMs } from '../retry-backoff.js';
import { buildRequestBody } from './requestBuilder.js';
import { createGeminiApiError, isGeminiApiError } from './errors.js';
import { redactSensitiveText, unescapeNewlinesInText } from '../utils.js';
import { DEFAULT_MAX_DEBUG_LOG_BYTES, MAX_DEBUG_LOG_BYTES } from '../constants.js';
import { normalizeRetryConfig, stringOrDefault } from '../config-values.js';
import { requestProviderText } from '../provider-http.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, getEffectiveMaxOutputTokens } from '../model-registry.js';

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
  currentMaxOutputTokens: number;
}

interface CallSetup {
  opts: GeminiCallOpts;
  activeModel: string;
  start: number;
  urlBase: string;
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

export function getDebugOpenFlags(platform: typeof process.platform): {
  create: number;
  append: number;
} {
  return platform === 'darwin' ? { create: 0x200, append: 0x8 } : { create: 0x40, append: 0x400 };
}

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
  const flags = getDebugOpenFlags(process.platform);
  const fileDescriptor = api.open(
    path,
    0x1 | flags.create | flags.append | noFollowFlag | nonBlockFlag,
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

function reportDebugFlushError(error: unknown): void {
  process.stderr.write('Failed to flush debug log: ' + String(error) + '\n');
}

function flushDebugWriter(writer: ReturnType<ReturnType<typeof Bun.file>['writer']>): void {
  try {
    void Promise.resolve(writer.flush()).catch(reportDebugFlushError);
  } catch (error: unknown) {
    reportDebugFlushError(error);
  }
}

function createDebugLogger(config: Partial<typeof CONFIG>): (label: string, data: unknown) => void {
  let writer: ReturnType<ReturnType<typeof Bun.file>['writer']> | null = null;
  const pending: string[] = [];
  let disabled = false;

  if (config.DEBUG_API && config.DEBUG_FILE) {
    pending.push(`\n\n=== Debug session started: ${new Date().toISOString()} ===\n\n`);
    void openDebugWriter(config.DEBUG_FILE)
      .then(function (openedWriter) {
        writer = openedWriter;
        for (const entry of pending) void writer.write(entry);
        pending.length = 0;
        flushDebugWriter(writer);
      })
      .catch(function (error: unknown) {
        pending.length = 0;
        process.stderr.write('Failed to create debug logger: ' + String(error) + '\n');
        disabled = true;
      });
  }

  return function writeDebug(label: string, data: unknown): void {
    if (disabled) return;
    const timestamp = new Date().toISOString();
    const serialized =
      typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? String(data));
    const entry = `[${timestamp}] ${label}:\n${redactSensitiveText(serialized)}\n\n`;
    if (!writer) {
      if (config.DEBUG_API && config.DEBUG_FILE) pending.push(entry);
      return;
    }
    void writer.write(entry);
    flushDebugWriter(writer);
  };
}

function capDebugBody(data: unknown, maxLog: number): string {
  const serialized =
    typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? String(data));
  const text = redactSensitiveText(serialized);
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

function handleSuccessfulResponse(
  deps: GeminiClientDeps,
  params: {
    textRes: string;
    attempt: number;
    start: number;
    telemetryMeta: LogMetadata;
  },
): GeminiResponse {
  const { textRes, attempt, start, telemetryMeta } = params;
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
    throw createGeminiApiError('Gemini blocked request: ' + json.promptFeedback.blockReason, {
      json,
    });
  }
  const parsed = parseCandidates(json, deps.logger) as GeminiResponse | null;
  if (!parsed) throw createGeminiApiError('Gemini returned no text', { json });
  return parsed;
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
    maxRetries: config.MAX_RETRIES,
    retryBaseMs: config.RETRY_BASE_MS,
    retryMaxMs: config.RETRY_MAX_MS,
  });
  return {
    ...config,
    TEMP: temperature,
    MAX_OUTPUT_TOKENS: maxOutputTokens,
    DEBUG_MAX_BODY_LOG_BYTES: maxDebugBodyLogBytes,
    MAX_RETRIES: retry.maxRetries,
    RETRY_BASE_MS: retry.retryBaseMs,
    RETRY_MAX_MS: retry.retryMaxMs,
  };
}

function buildCallSetup(
  config: typeof CONFIG,
  callOptions: GeminiCallOpts,
  modelOverride?: string,
): CallSetup {
  const opts = callOptions;
  const activeModel = stringOrDefault(modelOverride, config.MODEL);
  const urlBase =
    'https://generativelanguage.googleapis.com/v1beta/models/' + activeModel + ':generateContent';
  return {
    opts,
    activeModel,
    start: Date.now(),
    urlBase,
  };
}

async function applySuccessfulOutcome(params: {
  deps: GeminiClientDeps;
  textRes: string;
  telemetryMeta: LogMetadata;
  setup: CallSetup;
  state: CallState;
}): Promise<GeminiResponse | null> {
  const { deps, textRes, telemetryMeta, setup, state } = params;
  return handleSuccessfulResponse(deps, {
    textRes,
    attempt: state.attempt,
    start: setup.start,
    telemetryMeta,
  });
}

async function runCallAttempt(params: {
  deps: GeminiClientDeps;
  apiKey: string;
  userContent: string;
  telemetryMeta: LogMetadata;
  setup: CallSetup;
  state: CallState;
}): Promise<GeminiResponse | null> {
  const { deps, apiKey, userContent, telemetryMeta, setup, state } = params;
  const body = buildRequestBody(userContent, deps.config, {
    ...setup.opts,
    maxOutputTokens: state.currentMaxOutputTokens,
  });
  const bodyStr = JSON.stringify(body);
  let result;
  try {
    result = await requestProviderText({
      url: new URL(setup.urlBase),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: bodyStr,
      },
      timeoutMs: getTimeoutMs(setup.opts.timeoutMs),
      retry: {
        maxRetries: deps.maxRetries,
        retryBaseMs: deps.retryBaseMs,
        retryMaxMs: deps.retryMaxMs,
      },
      retryNetworkErrors: false,
      fetchImpl: deps.fetchImpl,
      onAttempt: function (attempt) {
        state.attempt = attempt;
        logDebugRequest({ deps, attempt, reqUrl: setup.urlBase, body, bodyStr });
      },
      onResponse: function ({ response, body: responseBody, attempt }) {
        logDebugResponse(deps, attempt, response, responseBody);
      },
      onRetry: function (status, attempt, delayMs) {
        deps.logger.log(
          'warn',
          `Gemini API returned ${String(status)}; retrying after ${String(delayMs)} ms (attempt ${String(attempt)})`,
        );
      },
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && /abort|timeout/i.test(error.name + ' ' + error.message);
    const bodyTooLarge = error instanceof Error && error.message === 'response body too large';
    if (bodyTooLarge) {
      throw createGeminiApiError('Gemini response body is too large', { category: 'data' });
    }
    if (timedOut) {
      throw createGeminiApiError('Gemini request timed out', { category: 'timeout' });
    }
    throw createGeminiApiError('Gemini request failed', { category: 'network' });
  }
  if (!result.response.ok) {
    deps.logger.log('error', 'Gemini API failed: ' + String(result.response.status), {
      text: result.body,
      attempt: result.attempt,
    });
    throw createGeminiApiError('Gemini API failed: ' + String(result.response.status), {
      status: result.response.status,
      snippet: result.body.slice(0, 256),
    });
  }
  return applySuccessfulOutcome({ deps, textRes: result.body, telemetryMeta, setup, state });
}

export function createGeminiClient(userOptions?: GeminiClientOptions): GeminiClient {
  const options = userOptions ?? {};
  const config = normalizeClientConfig({ ...CONFIG, ...options.config });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? createLogger(config);
  const writeDebug = createDebugLogger(config);
  const deps: GeminiClientDeps = {
    config,
    logger,
    writeDebug,
    fetchImpl,
    maxRetries: config.MAX_RETRIES,
    retryBaseMs: config.RETRY_BASE_MS,
    retryMaxMs: config.RETRY_MAX_MS,
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
      currentMaxOutputTokens: getEffectiveMaxOutputTokens(
        setup.opts.maxOutputTokens ?? config.MAX_OUTPUT_TOKENS,
        Number.MAX_SAFE_INTEGER,
      ),
    };

    return runCallAttempt({ deps, apiKey, userContent, telemetryMeta, setup, state });
  };
  return { callGemini };
}

export { tryParseJSON, parseCandidates, retryDelayMs as getRetryMsFromResponse };
