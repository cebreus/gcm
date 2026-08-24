import {
  createLanguageModelApiError,
  isLanguageModelName,
  type LanguageModelGenerateParams,
  type LanguageModelProvider,
} from './language-model-service.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, type ModelSpec } from './model-registry.js';
import {
  generateOpenAiCompatibleChat,
  isRecord,
  requestLanguageModelJson,
  sanitizeLanguageModelErrorText,
} from './openai-compatible-client.js';

const PREFERRED_LM_STUDIO_MODEL = 'gemma-4-e4b-it-mlx';

const UNLOADED_MODEL_MAX_OUTPUT_TOKENS = 1_024;

function readPositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
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
        ? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, maxInputTokens - 1_000 - reservedInputTokens)
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

async function discoverModels(
  url: URL,
  token?: string,
): Promise<{ models: ModelSpec[]; loadedModelIds: Set<string> }> {
  const payload = await requestLanguageModelJson({
    providerLabel: 'LM Studio',
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
      if (
        typeof metadata === 'string' &&
        sanitizeLanguageModelErrorText(metadata, token) !== metadata
      ) {
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
    const loadResult = await requestLanguageModelJson({
      providerLabel: 'LM Studio',
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

  async function generate(params: LanguageModelGenerateParams) {
    const modelName = params.opts?.modelOverride ?? defaultModel;
    const model = byName.get(modelName);
    if (!model) throw new Error('Unknown LM Studio model');
    return generateOpenAiCompatibleChat({
      providerLabel: 'LM Studio',
      url: new URL('/v1/chat/completions', url),
      token: options.token,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      modelName,
      model,
      params,
    });
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
