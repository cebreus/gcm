import {
  createLanguageModelApiError,
  type LanguageModelGenerateParams,
  type LanguageModelResponse,
} from './language-model-service.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, type ModelSpec } from './model-registry.js';
import {
  redactSensitiveText,
  redactSensitiveTextForPrompt,
  stripTerminalControlSequences,
} from './utils.js';
import { CONFIG } from '../gcm.config.js';
import { requestProviderText, type ProviderFetch, type RetryPolicy } from './provider-http.js';

const MAX_ERROR_SNIPPET_BYTES = 4_096;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

export function sanitizeLanguageModelErrorText(text: string, token?: string): string {
  const withoutToken = token ? text.split(token).join('[REDACTED-TOKEN]') : text;
  return redactSensitiveText(stripTerminalControlSequences(withoutToken))
    .replace(/(["'](?:password|token|api[_-]?key)["']\s*:\s*)["'][^"']*["']/gi, '$1"[REDACTED]"')
    .replace(/\b(password|token|api[_-]?key)\s*[:=]\s*[^\s,}&]+/gi, '$1=[REDACTED]');
}

function sanitizePromptText(text: string, token?: string): string {
  const withoutToken = token ? text.split(token).join('[REDACTED-TOKEN]') : text;
  return redactSensitiveTextForPrompt(withoutToken);
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
  retry?: RetryPolicy;
  sleep?: (milliseconds: number) => Promise<unknown>;
  fetchImpl?: ProviderFetch;
}): Promise<unknown> {
  const { providerLabel, url, init, timeoutMs, token } = params;
  const retry = params.retry ?? {
    maxRetries: CONFIG.MAX_RETRIES,
    retryBaseMs: CONFIG.RETRY_BASE_MS,
    retryMaxMs: CONFIG.RETRY_MAX_MS,
  };
  let result;
  try {
    result = await requestProviderText({
      url,
      init,
      timeoutMs,
      retry,
      retryNetworkErrors: (init?.method ?? 'GET').toUpperCase() === 'GET',
      sleep: params.sleep,
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

export async function generateOpenAiCompatibleChat(options: {
  providerLabel: string;
  url: URL;
  token?: string;
  temperature?: number;
  maxOutputTokens?: number;
  modelName: string;
  model: ModelSpec;
  params: LanguageModelGenerateParams;
}): Promise<LanguageModelResponse | null> {
  const { providerLabel, model, modelName, params } = options;
  const requestedTimeout = params.opts?.timeoutMs;
  if (
    requestedTimeout !== undefined &&
    (!Number.isSafeInteger(requestedTimeout) ||
      requestedTimeout <= 0 ||
      requestedTimeout > 2_147_483_647)
  ) {
    throw createLanguageModelApiError(`Invalid ${providerLabel} timeout`);
  }
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  const configuredOutputCap =
    Number.isSafeInteger(options.maxOutputTokens) && Number(options.maxOutputTokens) > 0
      ? Number(options.maxOutputTokens)
      : DEFAULT_MAX_OUTPUT_TOKENS;
  const requestOutputCap =
    Number.isSafeInteger(params.opts?.maxOutputTokensLimit) &&
    Number(params.opts?.maxOutputTokensLimit) > 0
      ? Number(params.opts?.maxOutputTokensLimit)
      : configuredOutputCap;
  const authoritativeOutputCap =
    model.limits.kind === 'separate'
      ? Math.min(model.limits.maxOutputTokens, requestOutputCap)
      : Math.min(model.limits.contextWindowTokens, requestOutputCap);
  const maxOutputTokens = Math.min(configuredOutputCap, authoritativeOutputCap);
  const payload = await requestLanguageModelJson({
    providerLabel,
    url: options.url,
    timeoutMs: requestedTimeout ?? 60_000,
    token: options.token,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: sanitizePromptText(params.systemPrompt, options.token) },
          { role: 'user', content: sanitizePromptText(params.promptContext, options.token) },
        ],
        temperature: options.temperature ?? 1,
        max_tokens: maxOutputTokens,
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
  return {
    text: sanitizeLanguageModelErrorText(choice.message.content, options.token),
    usage: {
      promptTokens: readNonNegativeInteger(usage.prompt_tokens) ?? undefined,
      outputTokens: readNonNegativeInteger(usage.completion_tokens) ?? undefined,
    },
    truncated: choice.finish_reason === 'length',
  };
}
