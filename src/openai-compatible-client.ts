import {
  createLanguageModelApiError,
  type LanguageModelGenerateParams,
  type LanguageModelResponse,
} from './language-model-service.js';
import { isRecord, redactSensitiveTextForPrompt, sanitizeTerminalText } from './utils.js';
import type { Config } from '../gcm.config.js';
import { requestProviderText, type ProviderFetch } from './provider-http.js';

const MAX_ERROR_SNIPPET_BYTES = 4_096;

function readNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function redactToken(text: string, token?: string): string {
  return token ? text.split(token).join('[REDACTED-TOKEN]') : text;
}

export function isHeaderSafeToken(token: string): boolean {
  return /^[\x21-\x7E]+$/.test(token);
}

function sanitizeLanguageModelErrorText(text: string, token?: string): string {
  return sanitizeTerminalText(redactToken(text, token))
    .replace(/(["'](?:password|token|api[_-]?key)["']\s*:\s*)["'][^"']*["']/gi, '$1"[REDACTED]"')
    .replace(/\b(password|token|api[_-]?key)\s*[:=]\s*[^\s,}&]+/gi, '$1=[REDACTED]');
}

export function rejectUnsafeModelMetadata(
  values: unknown[],
  token: string | undefined,
  message: string,
): void {
  for (const value of values) {
    if (typeof value === 'string' && sanitizeLanguageModelErrorText(value, token) !== value) {
      throw createLanguageModelApiError(message);
    }
  }
}

function requestFailureMessage(providerLabel: string, error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `${providerLabel} request timed out`;
    }
    if (error.message === 'response body too large') {
      return `${providerLabel} response body is too large`;
    }
  }
  return `${providerLabel} request failed`;
}

export async function requestLanguageModelJson(params: {
  providerLabel: string;
  url: URL;
  init?: RequestInit;
  timeoutMs: number;
  token?: string;
  fetchImpl?: ProviderFetch;
  config: Pick<Config, 'MAX_RETRIES' | 'RETRY_BASE_MS' | 'RETRY_MAX_MS'>;
}): Promise<unknown> {
  const { providerLabel, url, init, timeoutMs, token } = params;
  let result;
  try {
    result = await requestProviderText({
      url,
      init,
      timeoutMs,
      retry: {
        maxRetries: params.config.MAX_RETRIES,
        retryBaseMs: params.config.RETRY_BASE_MS,
        retryMaxMs: params.config.RETRY_MAX_MS,
      },
      retryNetworkErrors: (init?.method ?? 'GET').toUpperCase() === 'GET',
      fetchImpl: params.fetchImpl,
    });
  } catch (error) {
    throw createLanguageModelApiError(requestFailureMessage(providerLabel, error));
  }
  const redacted = sanitizeLanguageModelErrorText(result.body, token);
  const snippet = new TextDecoder().decode(
    new TextEncoder().encode(redacted).slice(0, MAX_ERROR_SNIPPET_BYTES),
  );
  if (!result.response.ok) {
    throw createLanguageModelApiError(
      `${providerLabel} request failed (${result.response.status})`,
      { status: result.response.status, snippet },
    );
  }
  try {
    return JSON.parse(result.body) as unknown;
  } catch {
    throw createLanguageModelApiError(`${providerLabel} returned malformed JSON`, { snippet });
  }
}

// Providers disagree on the marker for hitting the output cap: OpenAI sends
// 'length', Gemini's compatible layer can send 'MAX_TOKENS'. Servers that send
// no marker at all are covered by the token count instead, because a reply that
// spent the entire cap was almost certainly cut off.
const TRUNCATION_FINISH_REASONS = new Set(['length', 'max_tokens']);

function isTruncatedFinishReason(value: unknown): boolean {
  return typeof value === 'string' && TRUNCATION_FINISH_REASONS.has(value.toLowerCase());
}

export async function generateOpenAiCompatibleChat(options: {
  providerLabel: string;
  url: URL;
  token?: string;
  params: LanguageModelGenerateParams;
  fetchImpl?: ProviderFetch;
  config: Pick<Config, 'TEMP' | 'MAX_RETRIES' | 'RETRY_BASE_MS' | 'RETRY_MAX_MS'>;
}): Promise<LanguageModelResponse | null> {
  const { providerLabel, params } = options;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  const payload = await requestLanguageModelJson({
    providerLabel,
    url: options.url,
    timeoutMs: 60_000,
    token: options.token,
    fetchImpl: options.fetchImpl,
    config: options.config,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: params.modelName,
        messages: [
          {
            role: 'system',
            content: redactSensitiveTextForPrompt(redactToken(params.systemPrompt, options.token)),
          },
          {
            role: 'user',
            content: redactSensitiveTextForPrompt(redactToken(params.promptContext, options.token)),
          },
        ],
        temperature: options.config.TEMP,
        max_tokens: params.maxOutputTokens,
        stream: false,
      }),
    },
  });
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw createLanguageModelApiError(`Invalid ${providerLabel} response`);
  }
  const choices: unknown[] = payload.choices;
  const choice = choices[0];
  if (
    !isRecord(choice) ||
    !isRecord(choice.message) ||
    typeof choice.message.content !== 'string'
  ) {
    throw createLanguageModelApiError(`Invalid ${providerLabel} response`);
  }
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const outputTokens = readNonNegativeInteger(usage.completion_tokens);
  const spentWholeOutputCap = outputTokens !== null && outputTokens >= params.maxOutputTokens;
  return {
    text: sanitizeLanguageModelErrorText(choice.message.content, options.token),
    usage: {
      promptTokens: readNonNegativeInteger(usage.prompt_tokens) ?? undefined,
      outputTokens: outputTokens ?? undefined,
    },
    truncated: isTruncatedFinishReason(choice.finish_reason) || spentWholeOutputCap,
  };
}
