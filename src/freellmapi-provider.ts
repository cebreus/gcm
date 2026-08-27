import {
  createLanguageModelApiError,
  isLanguageModelApiError,
  isLanguageModelName,
  type LanguageModelGenerateParams,
  getModelSpecValidationError,
  type LanguageModelProvider,
} from './language-model-service.js';
import {
  generateOpenAiCompatibleChat,
  isRecord,
  requestLanguageModelJson,
  sanitizeLanguageModelErrorText,
} from './openai-compatible-client.js';
import type { ModelSpec } from './model-registry.js';

const DEFAULT_FREELLMAPI_MODEL = 'auto';

function parseModelId(entry: unknown): string | null {
  if (typeof entry === 'string' && isLanguageModelName(entry)) return entry;
  if (!isRecord(entry)) return null;
  const rawId = entry.id ?? entry.name ?? entry.key;
  if (typeof rawId === 'string' && isLanguageModelName(rawId)) return rawId;
  return null;
}

function readPositiveSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
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
    readPositiveSafeInteger(record.context_window) ??
    readPositiveSafeInteger(record.context_length);
  if (contextWindowTokens === null) return null;
  const model: ModelSpec = {
    name,
    label,
    limits: { kind: 'shared-context', contextWindowTokens },
  };
  return getModelSpecValidationError(model) === null ? model : null;
}

function parseBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Invalid FreeLLMAPI URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid FreeLLMAPI URL');
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    baseUrl.includes('?') ||
    baseUrl.includes('#')
  ) {
    throw new Error('Invalid FreeLLMAPI URL');
  }
  if (url.protocol === 'http:') {
    const authority = baseUrl.slice('http://'.length).split(/[/?#]/, 1)[0] ?? '';
    const rawHostname = authority.startsWith('[')
      ? authority.slice(0, authority.indexOf(']') + 1)
      : (authority.split(':', 1)[0] ?? '');
    const loopbackHostnames = ['127.0.0.1', 'localhost', '[::1]'];
    if (!loopbackHostnames.includes(url.hostname) || !loopbackHostnames.includes(rawHostname)) {
      throw new Error('FreeLLMAPI URL must use HTTPS or a loopback hostname');
    }
  }
  return url;
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
  if (pathname.endsWith('/v1')) {
    return new URL(`${pathname}/chat/completions`, url);
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
  return candidates.filter(function (candidate) {
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

async function discoverModels(url: URL, token?: string): Promise<{ models: ModelSpec[] }> {
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
        for (const metadata of [entry.id, entry.name, entry.key, entry.label, entry.display_name]) {
          if (
            typeof metadata === 'string' &&
            sanitizeLanguageModelErrorText(metadata, token) !== metadata
          ) {
            throw createLanguageModelApiError('Invalid FreeLLMAPI model metadata');
          }
        }
      }

      const models = rawList
        .map(parseModel)
        .filter(function (model): model is ModelSpec {
          return model !== null;
        })
        .sort(function (left, right) {
          return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
        });

      if (models.length === 0) {
        throw candidateCatalogueError('FreeLLMAPI returned no compatible text models');
      }
      const modelIds = new Set<string>();
      for (const model of models) {
        if (modelIds.has(model.name)) {
          throw candidateCatalogueError('Duplicate FreeLLMAPI model identifier');
        }
        modelIds.add(model.name);
      }
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

  if (lastError) throw lastError;
  throw createLanguageModelApiError('FreeLLMAPI returned no compatible text models');
}

export async function createFreeLlmApiProvider(options: {
  baseUrl: string;
  model?: string;
  token?: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<LanguageModelProvider> {
  const url = parseBaseUrl(options.baseUrl);
  if (options.token && !/^[\x21-\x7E]+$/.test(options.token)) {
    throw createLanguageModelApiError('Invalid FreeLLMAPI API token');
  }

  const { models } = await discoverModels(url, options.token);

  if (
    options.model &&
    !models.some(function (model) {
      return model.name === options.model;
    })
  ) {
    throw new Error('Configured FreeLLMAPI model is not available');
  }

  const byName = new Map(
    models.map(function (model) {
      return [model.name, model];
    }),
  );

  const defaultModel = options.model ?? DEFAULT_FREELLMAPI_MODEL;
  if (
    !models.some(function (model) {
      return model.name === defaultModel;
    })
  ) {
    throw createLanguageModelApiError(
      'FreeLLMAPI auto model is unavailable or lacks context metadata',
    );
  }

  async function generate(params: LanguageModelGenerateParams) {
    const modelName = params.opts?.modelOverride ?? defaultModel;
    const model = byName.get(modelName);
    if (!model) throw new Error('Unknown FreeLLMAPI model');

    return generateOpenAiCompatibleChat({
      providerLabel: 'FreeLLMAPI',
      url: resolveChatEndpoint(url),
      token: options.token,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      modelName,
      model,
      params,
    });
  }

  return {
    id: 'freellmapi',
    label: 'FreeLLMAPI',
    defaultModel,

    service: {
      generate,
    },
    models: async function () {
      return models;
    },
  };
}
