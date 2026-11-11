import {
  createLanguageModelApiError,
  isModelUnavailableError,
  isLanguageModelApiError,
  isLanguageModelName,
  type LanguageModelGenerateParams,
  type LanguageModelProvider,
} from './language-model-service.js';
import {
  generateOpenAiCompatibleChat,
  isHeaderSafeToken,
  rejectUnsafeModelMetadata,
  requestLanguageModelJson,
} from './openai-compatible-client.js';
import type { Config } from '../gcm.config.js';
import { isRecord } from './utils.js';
import {
  canUseFallbackModel,
  collectSortedModels,
  readPositiveTokenCount,
  requireDistinctModels,
  type ModelSpec,
} from './model-registry.js';
import type { Logger } from './logger.js';
import { parseProviderBaseUrl, withRequestTrace } from './provider-http.js';

const DEFAULT_FREELLMAPI_MODEL = 'auto';
const FALLBACK_FROM_MODEL = 'free-router';
const FALLBACK_TO_MODEL = 'kilo-auto';

function parseModelId(entry: unknown): string | null {
  if (typeof entry === 'string' && isLanguageModelName(entry)) return entry;
  if (!isRecord(entry)) return null;
  const rawId = entry.id ?? entry.name ?? entry.key;
  if (typeof rawId === 'string' && isLanguageModelName(rawId)) return rawId;
  return null;
}

function parseModel(entry: unknown): ModelSpec | null {
  const name = parseModelId(entry);
  if (!name) return null;
  const record = isRecord(entry) ? entry : {};
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  if (record.available === false) return null;
  if (['audio', 'embedding', 'image', 'moderation', 'rerank'].includes(type)) return null;
  if (/(^|[/._-])(dall-e|embed(?:ding)?|moderation|tts|whisper)([/._-]|$)/i.test(name)) return null;
  const label =
    typeof record.display_name === 'string'
      ? record.display_name
      : typeof record.label === 'string'
        ? record.label
        : name;
  if (!isLanguageModelName(label)) return null;
  const contextWindowTokens =
    readPositiveTokenCount(record.context_window) ?? readPositiveTokenCount(record.context_length);
  if (contextWindowTokens === null) return null;
  return { name, label, limits: { kind: 'shared-context', contextWindowTokens } };
}

function resolveChatEndpoint(url: URL): URL {
  const pathname = url.pathname.replace(/\/+$/, '');
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
  const pathname = url.pathname.replace(/\/+$/, '');
  const candidates: URL[] = [];

  if (pathname.endsWith('/chat/completions')) {
    candidates.push(new URL(`${pathname.slice(0, -'/chat/completions'.length)}/models`, url));
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
  return candidates.filter(candidate => {
    if (seen.has(candidate.href)) return false;
    seen.add(candidate.href);
    return true;
  });
}

function candidateCatalogueError(message: string) {
  return createLanguageModelApiError(message, {
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
      const payload = await requestLanguageModelJson({
        providerLabel: 'FreeLLMAPI',
        url: modelsUrl,
        timeoutMs: 5_000,
        token,
        init: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
        config,
      });

      let rawList: unknown[] = [];
      if (Array.isArray(payload)) {
        rawList = payload;
      } else if (isRecord(payload)) {
        if (Array.isArray(payload.data)) {
          rawList = payload.data;
        } else if (Array.isArray(payload.models)) {
          rawList = payload.models;
        }
      }

      for (const entry of rawList) {
        if (!isRecord(entry)) continue;
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
        const candidateFailure =
          error.metadata.candidateFailure === true ||
          error.metadata.status === 404 ||
          error.metadata.status === 405;
        if (!candidateFailure) throw error;
      }
      lastError = error;
    }
  }

  throw lastError;
}

export async function createFreeLlmApiProvider(options: {
  baseUrl: string;
  model?: string;
  token?: string;
  config: Config;
  logger?: Logger;
  debugApi?: boolean;
  onFallback?: (from: string, to: string) => void;
}): Promise<LanguageModelProvider> {
  const url = parseProviderBaseUrl(options.baseUrl, 'FreeLLMAPI', {
    allowHttps: true,
    loopbackError: 'FreeLLMAPI URL must use HTTPS or a loopback hostname',
  });
  if (options.token && !isHeaderSafeToken(options.token)) {
    throw createLanguageModelApiError('Invalid FreeLLMAPI API token');
  }

  const config = options.config;
  const fetchImpl =
    options.logger && (options.debugApi === true || config.DEBUG_API)
      ? withRequestTrace(options.logger, globalThis.fetch, 'FreeLLMAPI', options.token)
      : undefined;
  const { models } = await discoverModels(url, config, options.token);

  if (options.model && !models.some(model => model.name === options.model)) {
    throw new Error('Configured FreeLLMAPI model is not available');
  }

  const byName = new Map(models.map(model => [model.name, model]));

  const defaultModel = options.model ?? DEFAULT_FREELLMAPI_MODEL;
  if (!models.some(model => model.name === defaultModel)) {
    throw createLanguageModelApiError(
      'FreeLLMAPI auto model is unavailable or lacks context metadata',
    );
  }

  async function generateWithModel(params: LanguageModelGenerateParams, modelName: string) {
    const model = byName.get(modelName);
    if (!model) throw new Error('Unknown FreeLLMAPI model');

    return generateOpenAiCompatibleChat({
      providerLabel: 'FreeLLMAPI',
      url: resolveChatEndpoint(url),
      token: options.token,
      params: { ...params, modelName },
      fetchImpl,
      config,
    });
  }

  async function generate(params: LanguageModelGenerateParams) {
    try {
      return await generateWithModel(params, params.modelName);
    } catch (error) {
      const primary = byName.get(FALLBACK_FROM_MODEL);
      const fallback = byName.get(FALLBACK_TO_MODEL);
      if (
        params.modelName !== FALLBACK_FROM_MODEL ||
        !primary ||
        !fallback ||
        !canUseFallbackModel(primary.limits, fallback.limits) ||
        !isModelUnavailableError(error)
      ) {
        throw error;
      }
      options.onFallback?.(FALLBACK_FROM_MODEL, FALLBACK_TO_MODEL);
      return generateWithModel(params, FALLBACK_TO_MODEL);
    }
  }

  return {
    id: 'freellmapi',
    label: 'FreeLLMAPI',
    defaultModel,

    service: {
      generate,
    },
    models: async () => models,
  };
}
