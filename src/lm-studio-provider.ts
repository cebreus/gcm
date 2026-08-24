import {
  DEFAULT_LANGUAGE_MODEL_MAX_OUTPUT_TOKENS,
  createLanguageModelApiError,
  isLanguageModelName,
  type LanguageModelGenerateParams,
  type LanguageModelResponse,
  type LanguageModelProvider,
} from './language-model-service.js';
import type { ModelSpec } from './model-registry.js';
import {
  redactSensitiveText,
  redactSensitiveTextForPrompt,
  stripTerminalControlSequences,
} from './utils.js';

const PREFERRED_LM_STUDIO_MODEL = 'gemma-4-e4b-it-mlx';

const MAX_ERROR_SNIPPET_BYTES = 4_096;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const UNLOADED_MODEL_MAX_OUTPUT_TOKENS = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function parseModel(value: unknown): ModelSpec | null {
  if (!isRecord(value) || value.type !== 'llm' || !isLanguageModelName(value.key)) return null;
  const loadedContexts = Array.isArray(value.loaded_instances)
    ? value.loaded_instances
        .map(function (instance) {
          if (!isRecord(instance) || !isRecord(instance.config)) return null;
          return readPositiveInteger(instance.config.context_length);
        })
        .filter(function (context): context is number {
          return context !== null;
        })
    : [];
  const catalogContext = readPositiveInteger(value.max_context_length);
  const maxInputTokens =
    loadedContexts.length > 0
      ? Math.min(...loadedContexts)
      : Math.min(catalogContext ?? 8_192, 8_192);
  if (maxInputTokens <= 1_001) return null;
  const label = typeof value.display_name === 'string' ? value.display_name : value.key;
  if (!isLanguageModelName(label)) return null;
  const reservedInputTokens = Math.max(1, Math.min(4_096, maxInputTokens - 1_002));
  return {
    name: value.key,
    label,
    maxInputTokens,
    maxOutputTokens: Math.min(
      loadedContexts.length > 0
        ? Math.min(
            DEFAULT_LANGUAGE_MODEL_MAX_OUTPUT_TOKENS,
            maxInputTokens - 1_000 - reservedInputTokens,
          )
        : UNLOADED_MODEL_MAX_OUTPUT_TOKENS,
      maxInputTokens - 1_001,
    ),
  };
}

function parseBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Invalid LM Studio URL');
  }
  const authority = baseUrl.startsWith('http://')
    ? (baseUrl.slice('http://'.length).split(/[/?#]/, 1)[0] ?? '')
    : '';
  const rawHostname = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : (authority.split(':', 1)[0] ?? '');
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    baseUrl.includes('?') ||
    baseUrl.includes('#')
  ) {
    throw new Error('Invalid LM Studio URL');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('LM Studio URL must use a loopback hostname');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(rawHostname)) {
    throw new Error('Invalid LM Studio URL');
  }
  return url;
}

function sanitizeErrorText(text: string, token?: string): string {
  const withoutToken = token ? text.split(token).join('[REDACTED-TOKEN]') : text;
  return redactSensitiveText(stripTerminalControlSequences(withoutToken))
    .replace(/(["'](?:password|token|api[_-]?key)["']\s*:\s*)["'][^"']*["']/gi, '$1"[REDACTED]"')
    .replace(/\b(password|token|api[_-]?key)\s*[:=]\s*[^\s,}&]+/gi, '$1=[REDACTED]');
}

function sanitizePromptText(text: string, token?: string): string {
  const withoutToken = token ? text.split(token).join('[REDACTED-TOKEN]') : text;
  return redactSensitiveTextForPrompt(withoutToken);
}

async function requestJson(params: {
  url: URL;
  init?: RequestInit;
  timeoutMs: number;
  token?: string;
}): Promise<unknown> {
  const { url, init, timeoutMs, token } = params;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal,
    });
  } catch (error) {
    const isTimeout =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw createLanguageModelApiError(
      isTimeout ? 'LM Studio request timed out' : 'LM Studio request failed',
    );
  }
  let bytesRead = 0;
  let text: string;
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
    text = await new Response(body).text();
  } catch (error) {
    if (signal.aborted) {
      throw createLanguageModelApiError('LM Studio request timed out');
    }
    const oversized = error instanceof Error && error.message === 'response body too large';
    throw createLanguageModelApiError(
      oversized ? 'LM Studio response body is too large' : 'LM Studio response body failed',
    );
  }
  const redacted = sanitizeErrorText(text, token);
  const snippet = new TextDecoder().decode(
    new TextEncoder().encode(redacted).slice(0, MAX_ERROR_SNIPPET_BYTES),
  );
  if (!response.ok) {
    throw createLanguageModelApiError(`LM Studio request failed (${response.status})`, {
      status: response.status,
      snippet,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw createLanguageModelApiError('LM Studio returned malformed JSON', { snippet });
  }
}

async function discoverModels(
  url: URL,
  token?: string,
): Promise<{ models: ModelSpec[]; loadedModelIds: Set<string> }> {
  const payload = await requestJson({
    url: new URL('/api/v1/models', url),
    timeoutMs: 5_000,
    token,
    init: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw createLanguageModelApiError('Invalid LM Studio model catalogue');
  }
  for (const entry of payload.models) {
    if (!isRecord(entry) || entry.type !== 'llm') continue;
    for (const metadata of [entry.key, entry.display_name]) {
      if (typeof metadata === 'string' && sanitizeErrorText(metadata, token) !== metadata) {
        throw createLanguageModelApiError('Invalid LM Studio model metadata');
      }
    }
  }
  const loadedModelIds = new Set<string>();
  for (const entry of payload.models) {
    if (!isRecord(entry) || !isLanguageModelName(entry.key)) continue;
    if (
      Array.isArray(entry.loaded_instances) &&
      entry.loaded_instances.some(function (instance) {
        return (
          isRecord(instance) &&
          isRecord(instance.config) &&
          (readPositiveInteger(instance.config.context_length) ?? 0) > 1_001
        );
      })
    ) {
      loadedModelIds.add(entry.key);
    }
  }
  const models = payload.models
    .map(parseModel)
    .filter(function (model): model is ModelSpec {
      return model !== null;
    })
    .sort(function (left, right) {
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.name)) {
      throw createLanguageModelApiError('Duplicate LM Studio model identifier');
    }
    modelIds.add(model.name);
  }
  if (models.length === 0) {
    throw createLanguageModelApiError('LM Studio returned no compatible text models');
  }
  return { models, loadedModelIds };
}

export async function createLmStudioProvider(options: {
  baseUrl: string;
  model?: string;
  token?: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<LanguageModelProvider> {
  const url = parseBaseUrl(options.baseUrl);
  if (options.token && !/^[\x21-\x7E]+$/.test(options.token)) {
    throw createLanguageModelApiError('Invalid LM Studio API token');
  }
  let { models, loadedModelIds } = await discoverModels(url, options.token);
  if (
    options.model &&
    !models.some(function (model) {
      return model.name === options.model;
    })
  ) {
    throw new Error('Configured LM Studio model is not available');
  }
  async function loadModel(modelName: string): Promise<void> {
    if (loadedModelIds.has(modelName)) return;
    const headers = new Headers({ 'content-type': 'application/json' });
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    const loadResult = await requestJson({
      url: new URL('/api/v1/models/load', url),
      timeoutMs: 300_000,
      token: options.token,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: modelName }),
      },
    });
    if (!isRecord(loadResult) || loadResult.status !== 'loaded' || loadResult.type !== 'llm') {
      throw createLanguageModelApiError('Invalid LM Studio load response');
    }
    ({ models, loadedModelIds } = await discoverModels(url, options.token));
    if (!loadedModelIds.has(modelName)) {
      throw createLanguageModelApiError('LM Studio model did not report loaded state');
    }
  }
  let selectedModel =
    options.model ??
    models.find(function (model) {
      return model.name === PREFERRED_LM_STUDIO_MODEL;
    })?.name;
  let selectionNotice: string | undefined;
  if (selectedModel) {
    try {
      await loadModel(selectedModel);
    } catch (error) {
      if (options.model) throw error;
      selectionNotice = `${PREFERRED_LM_STUDIO_MODEL} could not be loaded`;
      selectedModel = undefined;
    }
  }
  const firstModel = models[0];
  if (!firstModel)
    throw createLanguageModelApiError('LM Studio returned no compatible text models');
  const byName = new Map(
    models.map(function (model) {
      return [model.name, model];
    }),
  );
  const defaultModel =
    selectedModel ??
    models.find(function (model) {
      return loadedModelIds.has(model.name);
    })?.name ??
    firstModel.name;
  if (!options.model && defaultModel !== PREFERRED_LM_STUDIO_MODEL) {
    selectionNotice = `${selectionNotice ?? `${PREFERRED_LM_STUDIO_MODEL} is unavailable`}; using ${defaultModel}`;
  }
  if (!byName.has(defaultModel)) throw new Error('Configured LM Studio model is not available');

  async function generate(params: LanguageModelGenerateParams): Promise<LanguageModelResponse> {
    const modelName = params.opts?.modelOverride ?? defaultModel;
    const model = byName.get(modelName);
    if (!model) throw new Error('Unknown LM Studio model');
    const requestedTimeout = params.opts?.timeoutMs;
    if (
      requestedTimeout !== undefined &&
      (!Number.isSafeInteger(requestedTimeout) ||
        requestedTimeout <= 0 ||
        requestedTimeout > 2_147_483_647)
    ) {
      throw createLanguageModelApiError('Invalid LM Studio timeout');
    }
    const headers = new Headers({ 'content-type': 'application/json' });
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    const maxRetries =
      Number.isSafeInteger(params.opts?.retryIfTruncatedMaxRetries) &&
      Number(params.opts?.retryIfTruncatedMaxRetries) >= 0
        ? Number(params.opts?.retryIfTruncatedMaxRetries)
        : 0;
    const increase =
      Number.isSafeInteger(params.opts?.retryIfTruncatedIncreaseTokens) &&
      Number(params.opts?.retryIfTruncatedIncreaseTokens) > 0
        ? Number(params.opts?.retryIfTruncatedIncreaseTokens)
        : 0;
    let retries = 0;
    let promptContext = params.promptContext;
    let promptParts = params.promptParts ?? {
      prefix: '',
      diffHeading: '',
      diffBody: params.promptContext,
      suffix: '',
    };
    let summaryAttempted = params.summaryAttempted ?? false;
    let maxOutputTokens = Math.min(
      Number.isSafeInteger(options.maxOutputTokens) && Number(options.maxOutputTokens) > 0
        ? Number(options.maxOutputTokens)
        : DEFAULT_LANGUAGE_MODEL_MAX_OUTPUT_TOKENS,
      model.maxOutputTokens,
    );
    for (;;) {
      const payload = await requestJson({
        url: new URL('/v1/chat/completions', url),
        timeoutMs: requestedTimeout ?? 60_000,
        token: options.token,
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: 'system', content: sanitizePromptText(params.systemPrompt, options.token) },
              { role: 'user', content: sanitizePromptText(promptContext, options.token) },
            ],
            temperature: options.temperature ?? 1,
            max_tokens: maxOutputTokens,
            stream: false,
          }),
        },
      });
      if (!isRecord(payload) || !Array.isArray(payload.choices)) {
        throw createLanguageModelApiError('Invalid LM Studio response');
      }
      const choices: unknown[] = payload.choices;
      const choice = choices[0];
      if (
        !isRecord(choice) ||
        !isRecord(choice.message) ||
        typeof choice.message.content !== 'string'
      ) {
        throw createLanguageModelApiError('Invalid LM Studio response');
      }
      const usage = isRecord(payload.usage) ? payload.usage : {};
      const result = {
        text: sanitizeErrorText(choice.message.content, options.token),
        usage: {
          promptTokens: readNonNegativeInteger(usage.prompt_tokens) ?? undefined,
          outputTokens: readNonNegativeInteger(usage.completion_tokens) ?? undefined,
        },
        truncated: choice.finish_reason === 'length',
      };
      if (!(result.truncated && params.opts?.retryIfTruncated && retries < maxRetries)) {
        return result;
      }
      const reduction = await params.reduceForRetry({ promptParts, summaryAttempted });
      if (reduction.mode === 'unreducible') return result;
      retries += 1;
      promptContext = reduction.promptContext;
      promptParts = reduction.promptParts;
      summaryAttempted = reduction.summaryAttempted;
      maxOutputTokens = Math.min(model.maxOutputTokens, maxOutputTokens + increase);
    }
  }

  return {
    id: 'lm-studio',
    label: 'LM Studio',
    selectionNotice,
    defaultModel,
    fallbackModels: models,
    service: {
      generate,
    },
    listModels: async function () {
      return models.map(function (model) {
        return model.name;
      });
    },
    getModelSpec: function (modelName) {
      const model = byName.get(modelName);
      if (!model) throw new Error('Unknown LM Studio model');
      return model;
    },
  };
}
