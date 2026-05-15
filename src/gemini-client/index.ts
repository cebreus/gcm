import { CONFIG } from '../../gcm.config.js';
import { createLogger } from '../logger.js';
import type { Logger, LoggerConfig, LogMetadata } from '../logger.js';
import { tryParseJSON, parseCandidates } from './parsers.js';
import { getRetryMsFromResponse } from './backoff.js';
import { buildRequestBody } from './requestBuilder.js';
import { GeminiApiError } from './errors.js';
import { unescapeNewlinesInText } from '../utils.js';
import { DEFAULT_MAX_DEBUG_LOG_BYTES } from '../constants.js';

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
    enableThinking: boolean;
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
  // Using Bun.file().writer() for debug logging
  // Note: Bun.FileSink is async for flush/end, but write can be queued.
  // We need to keep the writer open or open/close on demand?
  // Keeping it open is better for performance.
  let writer: ReturnType<ReturnType<typeof Bun.file>['writer']> | null = null;

  if (config.DEBUG_API && config.DEBUG_FILE) {
    try {
      const file = Bun.file(config.DEBUG_FILE);
      writer = file.writer();
      writer.write(`\n\n=== Debug session started: ${new Date().toISOString()} ===\n\n`);

      // Ensure we flush/close on exit
      // Note: Bun doesn't have a perfect equivalent to process.on('beforeExit') that guarantees async completion
      // but we can try best effort.
    } catch (e) {
      process.stderr.write('Failed to create debug logger: ' + String(e) + '\n');
    }
  }

  return function writeDebug(label: string, data: unknown): void {
    if (!writer) return;
    const timestamp = new Date().toISOString();
    writer.write(`[${timestamp}] ${label}:\n`);
    writer.write(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    writer.write('\n\n');
    // We don't await flush here to avoid slowing down the main flow, relying on Bun's buffering
    writer.flush();
  };
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
  const bodyPreview =
    bodyStr.length > maxLog ? bodyStr.slice(0, maxLog) + '...[TRUNCATED]' : bodyStr;
  deps.writeDebug('API REQUEST', {
    attempt,
    url: reqUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    bodyLength: bodyStr.length,
    body: bodyPreview,
  });
  deps.writeDebug('API REQUEST BODY (pretty-printed)', unescapeNewlinesInText(body));
  if (
    (body as { contents?: Array<{ parts?: Array<{ text?: string }> }> })?.contents?.[0]?.parts?.[0]
      ?.text
  ) {
    deps.writeDebug(
      'API REQUEST USER CONTENT (text)',
      (body as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0].parts[0].text,
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
  const bodyPreview =
    textRes.length > maxLog ? textRes.slice(0, maxLog) + '...[TRUNCATED]' : textRes;
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
    deps.writeDebug('API RESPONSE BODY (pretty-printed)', unescapeNewlinesInText(jsonRes));
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
  await Bun.sleep(backoff + Math.floor(Math.random() * 300));
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
    | (GeminiResponse & { truncated?: boolean })
    | null;
  if (!parsed) throw new GeminiApiError('Gemini returned no text', { json });
  if (!(parsed.truncated && opts.retryIfTruncated && truncRetries < truncMaxRetries)) {
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
    currentMaxOutputTokens: currentMaxOutputTokens + truncIncrease,
  };
}

function buildCallSetup(
  config: typeof CONFIG,
  callOptions: GeminiCallOpts,
  modelOverride?: string,
): CallSetup {
  const opts = callOptions || {};
  const activeModel = modelOverride || config.MODEL_NAME || 'gemini-2.5-flash';
  const urlBase =
    'https://generativelanguage.googleapis.com/v1beta/models/' + activeModel + ':generateContent';
  const truncMaxRetries =
    opts.retryIfTruncatedMaxRetries === undefined ? 1 : opts.retryIfTruncatedMaxRetries;
  const truncIncrease =
    opts.retryIfTruncatedIncreaseTokens === undefined
      ? config.MAX_OUTPUT_TOKENS
      : opts.retryIfTruncatedIncreaseTokens;
  return { opts, start: Date.now(), urlBase, truncMaxRetries, truncIncrease };
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
  enableThinking: boolean;
  telemetryMeta: LogMetadata;
  setup: CallSetup;
  state: CallState;
}): Promise<'retry' | GeminiResponse | null> {
  const { deps, apiKey, userContent, enableThinking, telemetryMeta, setup, state } = params;
  state.attempt += 1;
  const body = buildRequestBody(
    userContent,
    deps.config,
    { ...setup.opts, maxOutputTokens: state.currentMaxOutputTokens },
    enableThinking,
  );
  try {
    const timeoutMs = typeof setup.opts.timeoutMs === 'number' ? setup.opts.timeoutMs : 60000;
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
  const config: typeof CONFIG = { ...CONFIG, ...options.config };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger || createLogger(config);
  const writeDebug = createDebugLogger(config);
  const deps: GeminiClientDeps = {
    config,
    logger,
    writeDebug,
    fetchImpl,
    maxRetries: config.GEMINI_MAX_RETRIES || 3,
    retryBaseMs: config.GEMINI_RETRY_BASE_MS || 1000,
    retryMaxMs: config.GEMINI_RETRY_MAX_MS || 60000,
  };

  const callGemini = async ({
    apiKey,
    userContent,
    enableThinking,
    telemetryMeta,
    callOptions,
    modelOverride,
  }: {
    apiKey: string;
    userContent: string;
    enableThinking: boolean;
    telemetryMeta: LogMetadata;
    callOptions: GeminiCallOpts;
    modelOverride?: string;
  }): Promise<GeminiResponse | null> => {
    if (!apiKey) throw new Error('API key required');
    const setup = buildCallSetup(config, callOptions, modelOverride);
    const state: CallState = {
      attempt: 0,
      truncRetries: 0,
      currentMaxOutputTokens: setup.opts.maxOutputTokens || config.MAX_OUTPUT_TOKENS,
    };

    for (;;) {
      const outcome = await runCallAttempt({
        deps,
        apiKey,
        userContent,
        enableThinking,
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

const defaultClient = createGeminiClient({ config: CONFIG, logger: createDefaultLogger() });
export const { callGemini } = defaultClient;

export { tryParseJSON, parseCandidates, getRetryMsFromResponse };
export default createGeminiClient;
