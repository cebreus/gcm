import type { Config } from '../gcm.config.js';
import {
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_NOT_FOUND,
} from './constants.js';
import {
  type LanguageModelApiError,
  type LanguageModelGenerateParams,
  type LanguageModelProvider,
  createLanguageModelApiError,
  isLanguageModelApiError,
  isLanguageModelName,
} from './language-model-service.js';
import type { Logger } from './logger.js';
import {
  type ModelSpec,
  collectSortedModels,
  readPositiveTokenCount,
  requireDistinctModels,
} from './model-registry.js';
import {
  generateOpenAiCompatibleChat,
  isHeaderSafeToken,
  rejectUnsafeModelMetadata,
  requestLanguageModelJson,
} from './openai-compatible-client.js';
import { parseProviderBaseUrl, withRequestTrace } from './provider-http.js';
import { isRecord } from './utils.js';

const DEFAULT_FREELLMAPI_MODEL = 'auto';
const MODEL_CATALOGUE_TIMEOUT_MS = 5_000;
const NON_CHAT_MODEL_PATTERN =
  /(?:^|[\/._\-])(?:dall-e|embed(?:ding)?|moderation|tts|whisper)(?:[\/._\-]|$)/iv;
const TRAILING_SLASH_PATTERN = /\/+$/v;
const NON_CHAT_MODEL_TYPES = new Set([
  'audio',
  'embedding',
  'image',
  'moderation',
  'rerank',
]);

function parseModelId(entry: unknown): string | null {
  if (typeof entry === 'string' && isLanguageModelName(entry)) {
    return entry;
  }
  if (!isRecord(entry)) {
    return null;
  }
  const rawId = entry.id ?? entry.name ?? entry.key;
  if (typeof rawId === 'string' && isLanguageModelName(rawId)) {
    return rawId;
  }
  return null;
}

function parseModel(entry: unknown): ModelSpec | null {
  const name = parseModelId(entry);
  if (name === null) {
    return null;
  }
  const record = isRecord(entry) ? entry : {};
  if (!isChatModelRecord(record, name)) {
    return null;
  }
  const label =
    [record.display_name, record.label].find(
      (value): value is string => typeof value === 'string',
    ) ?? name;
  if (!isLanguageModelName(label)) {
    return null;
  }
  const contextWindowTokens =
    readPositiveTokenCount(record.context_window) ??
    readPositiveTokenCount(record.context_length);
  if (contextWindowTokens === null) {
    return null;
  }
  return {
    name,
    label,
    limits: { kind: 'shared-context', contextWindowTokens },
  };
}

function isChatModelRecord(
  record: Record<string, unknown>,
  name: string,
): boolean {
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  if (record.available === false) {
    return false;
  }
  return !NON_CHAT_MODEL_TYPES.has(type) && !NON_CHAT_MODEL_PATTERN.test(name);
}

function resolveChatEndpoint(url: URL): URL {
  const pathname = url.pathname.replace(TRAILING_SLASH_PATTERN, '');
  if (
    pathname.endsWith('/chat/completions') ||
    pathname.endsWith('/chat') ||
    pathname.endsWith('/models/chat')
  ) {
    return url;
  }
  if (pathname !== '') {
    return new URL(`${pathname}/chat/completions`, url);
  }
  return new URL('/v1/chat/completions', url);
}

function resolveModelCandidates(url: URL): URL[] {
  const pathname = url.pathname.replace(TRAILING_SLASH_PATTERN, '');
  const candidates: URL[] = [];

  if (pathname.endsWith('/chat/completions')) {
    candidates.push(
      new URL(`${pathname.slice(0, -'/chat/completions'.length)}/models`, url),
    );
    candidates.push(new URL('/v1/models', url));
    candidates.push(new URL('/models', url));
  } else if (pathname.endsWith('/v1')) {
    candidates.push(new URL(`${pathname}/models`, url));
    candidates.push(new URL('/models', url));
  } else if (pathname.endsWith('/models/chat') || pathname.endsWith('/chat')) {
    candidates.push(new URL('/v1/models', url));
    candidates.push(new URL('/models', url));
  } else if (pathname !== '' && pathname !== '/') {
    candidates.push(new URL(`${pathname}/models`, url));
    candidates.push(new URL('/v1/models', url));
    candidates.push(new URL('/models', url));
  } else {
    candidates.push(new URL('/v1/models', url));
    candidates.push(new URL('/models', url));
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.href)) {
      return false;
    }
    seen.add(candidate.href);
    return true;
  });
}

function candidateCatalogueError(
  message: string,
  metadata: { kind?: 'no-models' } = {},
): LanguageModelApiError {
  return createLanguageModelApiError(message, {
    ...metadata,
    candidateFailure: true,
  });
}

async function discoverModels(
  url: URL,
  config: Config,
  token?: string,
): Promise<{ models: ModelSpec[] }> {
  const candidates = resolveModelCandidates(url);
  let lastError: unknown = null;

  for (const modelsUrl of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- model endpoints are ordered fallbacks and stop after first success
      const payload = await requestLanguageModelJson({
        providerLabel: 'FreeLLMAPI',
        url: modelsUrl,
        timeoutMs: MODEL_CATALOGUE_TIMEOUT_MS,
        token,
        init:
          token === undefined
            ? undefined
            : { headers: { authorization: `Bearer ${token}` } },
        config,
      });

      const rawList = readModelList(payload);

      for (const entry of rawList) {
        if (!isRecord(entry)) {
          continue;
        }
        rejectUnsafeModelMetadata(
          [entry.id, entry.name, entry.key, entry.label, entry.display_name],
          token,
          'Invalid FreeLLMAPI model metadata',
        );
      }

      const models = collectSortedModels(rawList, parseModel);

      requireDistinctModels(models, 'FreeLLMAPI', candidateCatalogueError);
      return { models };
    } catch (error) {
      if (isLanguageModelApiError(error)) {
        if (isCandidateFailure(error)) {
          lastError = error;
        } else {
          throw error;
        }
      } else {
        lastError = error;
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('FreeLLMAPI model discovery failed', { cause: lastError });
}

function isCandidateFailure(error: LanguageModelApiError): boolean {
  return (
    error.metadata.candidateFailure === true ||
    error.metadata.status === HTTP_STATUS_NOT_FOUND ||
    error.metadata.status === HTTP_STATUS_METHOD_NOT_ALLOWED
  );
}

function readModelList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isRecord(payload)) {
    return [];
  }
  if (Array.isArray(payload.data)) {
    return payload.data;
  }
  return Array.isArray(payload.models) ? payload.models : [];
}

export async function createFreeLlmApiProvider(options: {
  baseUrl: string;
  model?: string;
  token?: string;
  config: Config;
  logger?: Logger;
  debugApi?: boolean;
}): Promise<LanguageModelProvider> {
  const url = parseProviderBaseUrl(options.baseUrl, 'FreeLLMAPI', {
    allowHttps: true,
    loopbackError: 'FreeLLMAPI URL must use HTTPS or a loopback hostname',
  });
  if (options.token !== undefined && !isHeaderSafeToken(options.token)) {
    throw createLanguageModelApiError('Invalid FreeLLMAPI API token');
  }

  const { config } = options;
  const fetchImpl =
    options.logger !== undefined &&
    (options.debugApi === true || config.DEBUG_API)
      ? withRequestTrace(
          options.logger,
          globalThis.fetch,
          'FreeLLMAPI',
          options.token,
        )
      : undefined;
  const { models } = await discoverModels(url, config, options.token);

  if (
    options.model !== undefined &&
    !models.some((model) => model.name === options.model)
  ) {
    throw new Error('Configured FreeLLMAPI model is not available');
  }

  const byName = new Map(models.map((model) => [model.name, model]));

  const defaultModel = options.model ?? DEFAULT_FREELLMAPI_MODEL;
  if (!models.some((model) => model.name === defaultModel)) {
    throw createLanguageModelApiError(
      'FreeLLMAPI auto model is unavailable or lacks context metadata',
    );
  }

  async function generateWithModel(
    params: LanguageModelGenerateParams,
    modelName: string,
  ): ReturnType<typeof generateOpenAiCompatibleChat> {
    const model = byName.get(modelName);
    if (model === undefined) {
      throw new Error('Unknown FreeLLMAPI model');
    }

    return await generateOpenAiCompatibleChat({
      providerLabel: 'FreeLLMAPI',
      url: resolveChatEndpoint(url),
      token: options.token,
      params: { ...params, modelName },
      fetchImpl,
      config,
    });
  }

  async function generate(
    params: LanguageModelGenerateParams,
  ): ReturnType<typeof generateOpenAiCompatibleChat> {
    return await generateWithModel(params, params.modelName);
  }

  return {
    id: 'freellmapi',
    label: 'FreeLLMAPI',
    defaultModel,

    service: {
      generate,
    },
    models: async () => await Promise.resolve(models),
  };
}
