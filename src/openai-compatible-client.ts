import {
  createLanguageModelApiError,
  generateWithSemanticRetries,
  type LanguageModelGenerateParams,
  type LanguageModelResponse,
} from './language-model-service.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, type ModelSpec } from './model-registry.js';
import {
  redactSensitiveText,
  redactSensitiveTextForPrompt,
  stripTerminalControlSequences,
} from './utils.js';

const MAX_ERROR_SNIPPET_BYTES = 4_096;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

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

export async function requestLanguageModelJson(params: {
  providerLabel: string;
  url: URL;
  init?: RequestInit;
  timeoutMs: number;
  token?: string;
}): Promise<unknown> {
  const { providerLabel, url, init, timeoutMs, token } = params;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal });
  } catch (error) {
    const isTimeout =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw createLanguageModelApiError(
      isTimeout ? `${providerLabel} request timed out` : `${providerLabel} request failed`,
    );
  }
  let bytesRead = 0;
  let responseText: string;
  try {
    const body = response.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: function (chunk, controller) {
          bytesRead += chunk.byteLength;
          if (bytesRead > MAX_RESPONSE_BODY_BYTES) throw new Error('response body too large');
          controller.enqueue(chunk);
        },
      }),
    );
    responseText = await new Response(body).text();
  } catch (error) {
    if (signal.aborted) throw createLanguageModelApiError(`${providerLabel} request timed out`);
    const oversized = error instanceof Error && error.message === 'response body too large';
    throw createLanguageModelApiError(
      oversized
        ? `${providerLabel} response body is too large`
        : `${providerLabel} response body failed`,
    );
  }
  const redacted = sanitizeLanguageModelErrorText(responseText, token);
  const snippet = new TextDecoder().decode(
    new TextEncoder().encode(redacted).slice(0, MAX_ERROR_SNIPPET_BYTES),
  );
  if (!response.ok) {
    throw createLanguageModelApiError(`${providerLabel} request failed (${response.status})`, {
      status: response.status,
      snippet,
    });
  }
  try {
    return JSON.parse(responseText) as unknown;
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
  const initialMaxOutputTokens = Math.min(
    Number.isSafeInteger(options.maxOutputTokens) && Number(options.maxOutputTokens) > 0
      ? Number(options.maxOutputTokens)
      : DEFAULT_MAX_OUTPUT_TOKENS,
    model.maxOutputTokens,
  );
  return generateWithSemanticRetries({
    params,
    initialMaxOutputTokens,
    maxOutputTokensLimit: model.maxOutputTokens,
    defaultRetryLimit: 0,
    maximumRetryLimit: Number.MAX_SAFE_INTEGER,
    defaultTokenIncrease: 0,
    reduceInputOnTruncation: true,
    retryWhenOutputLimitUnchanged: true,
    generateOnce: async function (state) {
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
              { role: 'user', content: sanitizePromptText(state.promptContext, options.token) },
            ],
            temperature: options.temperature ?? 1,
            max_tokens: state.maxOutputTokens,
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
    },
  });
}
