import {
  createLanguageModelApiError,
  isLanguageModelApiError,
  isLanguageModelName,
  type LanguageModelGenerateParams,
  type LanguageModelProvider,
} from './language-model-service.js';
import {
  generateOpenAiCompatibleChat,
  isRecord,
  requestLanguageModelJson,
  sanitizeLanguageModelErrorText,
} from './openai-compatible-client.js';
import type { ModelSpec } from './model-registry.js';

const PREFERRED_OPENAI_MODEL = 'gemini-2.5-flash';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

const DEFAULT_OPENAI_INPUT_TOKENS = 32_768;
const DEFAULT_OPENAI_OUTPUT_TOKENS = 8_192;

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
  const type = isRecord(entry) && typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
  if (['audio', 'embedding', 'image', 'moderation', 'rerank'].includes(type)) return null;
  // ponytail: name filter covers catalogues without capabilities; prefer server capability metadata when standardised.
  if (/(^|[/._-])(dall-e|embed(?:ding)?|moderation|tts|whisper)([/._-]|$)/i.test(name)) return null;
  const label = isRecord(entry) && typeof entry.label === 'string' ? entry.label : name;
  if (!isLanguageModelName(label)) return null;
  const maxInputTokens = DEFAULT_OPENAI_INPUT_TOKENS;
  const maxOutputTokens = DEFAULT_OPENAI_OUTPUT_TOKENS;
  return {
    name,
    label,
    maxInputTokens,
    maxOutputTokens,
  };
}

function parseBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Invalid OpenAI API URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid OpenAI API URL');
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    baseUrl.includes('?') ||
    baseUrl.includes('#')
  ) {
    throw new Error('Invalid OpenAI API URL');
  }
  if (url.protocol === 'http:') {
    const authority = baseUrl.slice('http://'.length).split(/[/?#]/, 1)[0] ?? '';
    const rawHostname = authority.startsWith('[')
      ? authority.slice(0, authority.indexOf(']') + 1)
      : (authority.split(':', 1)[0] ?? '');
    const loopbackHostnames = ['127.0.0.1', 'localhost', '[::1]'];
    if (!loopbackHostnames.includes(url.hostname) || !loopbackHostnames.includes(rawHostname)) {
      throw new Error('OpenAI API URL must use HTTPS or a loopback hostname');
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

  return candidates;
}

async function discoverModels(url: URL, token?: string): Promise<{ models: ModelSpec[] }> {
  const candidates = resolveModelCandidates(url);
  let lastError: unknown = null;

  for (const modelsUrl of candidates) {
    try {
      const payload = await requestLanguageModelJson({
        providerLabel: 'OpenAI',
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
        for (const metadata of [entry.id, entry.name, entry.key, entry.label]) {
          if (
            typeof metadata === 'string' &&
            sanitizeLanguageModelErrorText(metadata, token) !== metadata
          ) {
            throw createLanguageModelApiError('Invalid OpenAI model metadata');
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

      const modelIds = new Set<string>();
      const uniqueModels: ModelSpec[] = [];
      for (const model of models) {
        if (!modelIds.has(model.name)) {
          modelIds.add(model.name);
          uniqueModels.push(model);
        }
      }

      if (uniqueModels.length > 0) {
        return { models: uniqueModels };
      }
    } catch (error) {
      if (
        isLanguageModelApiError(error) &&
        error.metadata.status !== 404 &&
        error.metadata.status !== 405
      ) {
        throw error;
      }
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  throw createLanguageModelApiError('OpenAI returned no compatible text models');
}

export async function createOpenAiProvider(options: {
  baseUrl: string;
  model?: string;
  token?: string;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<LanguageModelProvider> {
  const url = parseBaseUrl(options.baseUrl);
  if (options.token && !/^[\x21-\x7E]+$/.test(options.token)) {
    throw createLanguageModelApiError('Invalid OpenAI API token');
  }

  const { models } = await discoverModels(url, options.token);

  if (
    options.model &&
    !models.some(function (model) {
      return model.name === options.model;
    })
  ) {
    throw new Error('Configured OpenAI model is not available');
  }

  const byName = new Map(
    models.map(function (model) {
      return [model.name, model];
    }),
  );

  const preferred = models.find(function (m) {
    return m.name === PREFERRED_OPENAI_MODEL || m.name.includes(PREFERRED_OPENAI_MODEL);
  })?.name;

  const defaultModel =
    options.model ??
    preferred ??
    models.find(function (m) {
      return m.name === DEFAULT_OPENAI_MODEL || m.name.includes('gpt-');
    })?.name ??
    models[0]?.name ??
    DEFAULT_OPENAI_MODEL;

  if (!byName.has(defaultModel) && !options.model) {
    byName.set(defaultModel, {
      name: defaultModel,
      label: defaultModel,
      maxInputTokens: DEFAULT_OPENAI_INPUT_TOKENS,
      maxOutputTokens: DEFAULT_OPENAI_OUTPUT_TOKENS,
    });
  }

  async function generate(params: LanguageModelGenerateParams) {
    const modelName = params.opts?.modelOverride ?? defaultModel;
    const model = byName.get(modelName);
    if (!model) throw new Error('Unknown OpenAI model');

    return generateOpenAiCompatibleChat({
      providerLabel: 'OpenAI',
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
    id: 'openai',
    label: 'OpenAI-FreeLLMAPI',
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
      if (!model) throw new Error('Unknown OpenAI model');
      return model;
    },
  };
}
