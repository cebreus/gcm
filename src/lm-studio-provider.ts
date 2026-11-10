import {
  createLanguageModelApiError,
  isLanguageModelName,
  type LanguageModelGenerateParams,
  type LanguageModelProvider,
} from './language-model-service.js';
import {
  collectSortedModels,
  readPositiveTokenCount,
  requireDistinctModels,
  type ModelSpec,
} from './model-registry.js';
import { parseProviderBaseUrl } from './provider-http.js';
import {
  generateOpenAiCompatibleChat,
  isHeaderSafeToken,
  rejectUnsafeModelMetadata,
  requestLanguageModelJson,
} from './openai-compatible-client.js';
import type { Config } from '../gcm.config.js';
import { isRecord } from './utils.js';

const PREFERRED_LM_STUDIO_MODEL = 'gemma-4-e4b-it-mlx';

function parseModel(value: unknown): ModelSpec | null {
  if (!isRecord(value) || value.type !== 'llm' || !isLanguageModelName(value.key)) return null;
  const loadedContexts = Array.isArray(value.loaded_instances)
    ? value.loaded_instances
        .map(instance => {
          if (!isRecord(instance) || !isRecord(instance.config)) return null;
          return readPositiveTokenCount(instance.config.context_length);
        })
        .filter((context): context is number => context !== null)
    : [];
  const catalogContext = readPositiveTokenCount(value.max_context_length);
  const contextWindowTokens =
    loadedContexts.length > 0 ? Math.min(...loadedContexts) : catalogContext;
  if (contextWindowTokens === null) return null;
  const label = typeof value.display_name === 'string' ? value.display_name : value.key;
  if (!isLanguageModelName(label)) return null;
  return {
    name: value.key,
    label,
    limits: { kind: 'shared-context', contextWindowTokens },
  };
}

async function discoverModels(
  url: URL,
  config: Config,
  token?: string,
): Promise<{ models: ModelSpec[]; loadedModelIds: Set<string> }> {
  const payload = await requestLanguageModelJson({
    providerLabel: 'LM Studio',
    url: new URL('/api/v1/models', url),
    timeoutMs: 5_000,
    token,
    init: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    config,
  });
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw createLanguageModelApiError('Invalid LM Studio model catalogue');
  }
  for (const entry of payload.models) {
    if (!isRecord(entry) || entry.type !== 'llm') continue;
    rejectUnsafeModelMetadata(
      [entry.key, entry.display_name],
      token,
      'Invalid LM Studio model metadata',
    );
  }
  const loadedModelIds = new Set<string>();
  for (const entry of payload.models) {
    if (!isRecord(entry) || !isLanguageModelName(entry.key)) continue;
    if (
      Array.isArray(entry.loaded_instances) &&
      entry.loaded_instances.some(
        instance =>
          isRecord(instance) &&
          isRecord(instance.config) &&
          (readPositiveTokenCount(instance.config.context_length) ?? 0) > 0,
      )
    ) {
      loadedModelIds.add(entry.key);
    }
  }
  const models = collectSortedModels(payload.models, parseModel);
  requireDistinctModels(models, 'LM Studio', createLanguageModelApiError);
  return { models, loadedModelIds };
}

export async function createLmStudioProvider(options: {
  baseUrl: string;
  model?: string;
  token?: string;
  probeOnly?: boolean;
  config: Config;
}): Promise<LanguageModelProvider> {
  const url = parseProviderBaseUrl(options.baseUrl, 'LM Studio', {
    allowHttps: false,
    loopbackError: 'LM Studio URL must use a loopback hostname',
  });
  if (options.token && !isHeaderSafeToken(options.token)) {
    throw createLanguageModelApiError('Invalid LM Studio API token');
  }
  const config = options.config;
  let { models, loadedModelIds } = await discoverModels(url, config, options.token);
  if (options.model && !models.some(model => model.name === options.model)) {
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
      config,
    });
    if (!isRecord(loadResult) || loadResult.status !== 'loaded' || loadResult.type !== 'llm') {
      throw createLanguageModelApiError('Invalid LM Studio load response');
    }
    ({ models, loadedModelIds } = await discoverModels(url, config, options.token));
    if (!loadedModelIds.has(modelName)) {
      throw createLanguageModelApiError('LM Studio model did not report loaded state');
    }
  }
  let selectedModel =
    options.model ?? models.find(model => model.name === PREFERRED_LM_STUDIO_MODEL)?.name;
  let selectionNotice: string | undefined;
  if (selectedModel && !options.probeOnly) {
    try {
      await loadModel(selectedModel);
    } catch (error) {
      if (options.model) throw error;
      selectionNotice = `${PREFERRED_LM_STUDIO_MODEL} could not be loaded`;
      selectedModel = undefined;
    }
  }
  const byName = new Map(models.map(model => [model.name, model]));
  const defaultModel =
    selectedModel ?? models.find(model => loadedModelIds.has(model.name))?.name ?? models[0].name;
  if (!options.model && defaultModel !== PREFERRED_LM_STUDIO_MODEL) {
    selectionNotice = `${selectionNotice ?? `${PREFERRED_LM_STUDIO_MODEL} is unavailable`}; using ${defaultModel}`;
  }
  if (!byName.has(defaultModel)) throw new Error('Configured LM Studio model is not available');

  async function generate(params: LanguageModelGenerateParams) {
    const model = byName.get(params.modelName);
    if (!model) throw new Error('Unknown LM Studio model');
    return generateOpenAiCompatibleChat({
      providerLabel: 'LM Studio',
      url: new URL('/v1/chat/completions', url),
      token: options.token,
      params,
      config,
    });
  }

  return {
    id: 'lm-studio',
    label: 'LM Studio',
    selectionNotice,
    defaultModel,
    service: {
      generate,
    },
    models: async () => models,
  };
}
