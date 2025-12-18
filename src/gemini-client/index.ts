import { CONFIG } from '../../gcm.config.js';
import { createLogger } from '../logger.js';
import type { Logger, LoggerConfig, LogMetadata } from '../logger.js';
import { tryParseJSON, parseCandidates } from './parsers.js';
import { getRetryMsFromResponse } from './backoff.js';
import { buildRequestBody } from './requestBuilder.js';
import { GeminiApiError } from './errors.js';
import { unescapeNewlinesInText } from '../utils.js';
import { RETRYABLE_HTTP_CODES, DEFAULT_MAX_DEBUG_LOG_BYTES } from '../constants.js';

export interface GeminiUsage {
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface GeminiResponse {
  text: string;
  usage: GeminiUsage;
}

export interface GeminiCallOpts {
  timeoutMs?: number;
  systemInstructions?: string;
  maxOutputTokens?: number;
}

export interface GeminiClient {
  callGemini: (
    apiKey: string,
    userContent: string,
    enableThinking: boolean,
    telemetryMeta: LogMetadata,
    callOptions: GeminiCallOpts,
  ) => Promise<GeminiResponse | null>;
}

interface GeminiClientOptions {
  config?: Partial<typeof CONFIG>;
  fetchImpl?: typeof fetch;
  logger?: Logger;
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
      console.error('Failed to create debug logger:', e);
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

export function createGeminiClient(userOptions?: GeminiClientOptions): GeminiClient {
  const options = userOptions || {};
  const config = { ...CONFIG, ...options.config } as typeof CONFIG;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger || createLogger(config);
  const writeDebug = createDebugLogger(config);

  const maxRetries = config.GEMINI_MAX_RETRIES || 3;
  const retryBaseMs = config.GEMINI_RETRY_BASE_MS || 1000;
  const retryMaxMs = config.GEMINI_RETRY_MAX_MS || 60000;

  async function callGemini(
    apiKey: string,
    userContent: string,
    enableThinking: boolean,
    telemetryMeta: LogMetadata,
    callOptions: GeminiCallOpts,
  ): Promise<GeminiResponse | null> {
    const opts = callOptions || {};
    if (!apiKey) throw new Error('API key required');
    const body = buildRequestBody(userContent, config, opts, enableThinking);
    const start = Date.now();
    let attempt = 0;
    const urlBase =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      (config.MODEL_NAME || 'gemini-2.5-flash') +
      ':generateContent';
    for (;;) {
      attempt += 1;
      let controller: AbortController;
      let timer: NodeJS.Timeout | null = null;
      try {
        controller = new AbortController();
        const timeoutMs = typeof callOptions.timeoutMs === 'number' ? callOptions.timeoutMs : 60000;
        timer = setTimeout(() => {
          controller.abort();
        }, timeoutMs);
        const bodyStr = JSON.stringify(body);
        const reqUrl = urlBase + '?key=' + encodeURIComponent(apiKey);

        if (config.DEBUG_API) {
          const maxLog = Number(config.DEBUG_MAX_BODY_LOG_BYTES || DEFAULT_MAX_DEBUG_LOG_BYTES);
          const bodyPreview =
            bodyStr.length > maxLog ? bodyStr.slice(0, maxLog) + '...[TRUNCATED]' : bodyStr;

          // Log the compact version as before
          writeDebug('API REQUEST', {
            attempt,
            url: reqUrl,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            bodyLength: bodyStr.length,
            body: bodyPreview, // This logs the compact string
          });

          // Log the pretty-printed version of the full body
          const unescapedBody = unescapeNewlinesInText(body); // Use the helper
          writeDebug('API REQUEST BODY (pretty-printed)', unescapedBody);

          if (body?.contents?.[0]?.parts?.[0]?.text) {
            writeDebug('API REQUEST USER CONTENT (text)', body.contents[0].parts[0].text);
          }
        }

        const res = await fetchImpl(reqUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: bodyStr,
          signal: controller.signal,
        });
        const textRes = await res.text();

        if (config.DEBUG_API) {
          const maxLog = Number(config.DEBUG_MAX_BODY_LOG_BYTES || DEFAULT_MAX_DEBUG_LOG_BYTES);
          const bodyPreview =
            textRes.length > maxLog ? textRes.slice(0, maxLog) + '...[TRUNCATED]' : textRes;

          // Log the compact version as before
          writeDebug('API RESPONSE', {
            attempt,
            status: res.status,
            statusText: res.statusText,
            headers: Object.fromEntries(res.headers.entries()),
            bodyLength: textRes.length,
            body: bodyPreview,
          });

          // Log the pretty-printed version
          try {
            const jsonRes = JSON.parse(textRes);
            const unescapedJsonRes = unescapeNewlinesInText(jsonRes); // Use the helper
            writeDebug('API RESPONSE BODY (pretty-printed)', unescapedJsonRes);
          } catch {
            // Not a JSON response, do not log pretty-printed version
          }
        }
        if (res.ok) {
          const json = tryParseJSON(logger, textRes) as {
            promptFeedback?: { blockReason?: string };
            candidates?: unknown[];
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          };
          const durationMs = Date.now() - start;
          logger.log('debug', 'Gemini API call succeeded', {
            durationMs,
            attempt,
            status: res.status,
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
          const parsed = parseCandidates(json);
          if (parsed) return parsed;
          throw new GeminiApiError('Gemini returned no text', { json });
        }
        // handle HTTP errors
        if (RETRYABLE_HTTP_CODES.includes(res.status) && attempt <= maxRetries) {
          const retryMs = getRetryMsFromResponse(textRes, retryBaseMs, retryMaxMs, attempt);
          logger.log(
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
          continue;
        }
        logger.log('error', 'Gemini API failed: ' + String(res.status), {
          text: textRes,
          attempt,
        });
        throw new GeminiApiError('Gemini API failed: ' + String(res.status), {
          status: res.status,
          snippet: textRes.slice(0, 256),
        });
      } catch (err) {
        if (attempt <= maxRetries) {
          const backoff = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1));
          logger.log(
            'warn',
            'Network error calling Gemini; retrying (' +
              String(attempt) +
              '/' +
              String(maxRetries) +
              ') after ' +
              String(backoff) +
              'ms',
            { error: String(err) },
          );
          await Bun.sleep(backoff + Math.floor(Math.random() * 300));
          continue;
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  return { callGemini };
}

const defaultClient = createGeminiClient({ config: CONFIG, logger: createDefaultLogger() });
export const { callGemini } = defaultClient;

export { tryParseJSON, parseCandidates, getRetryMsFromResponse };
export default createGeminiClient;
