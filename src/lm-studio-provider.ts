import type { Config } from '../gcm.config.js';
import {
  type LanguageModelGenerateParams,
  type LanguageModelProvider,
  type LanguageModelResponse,
  createLanguageModelApiError,
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
import { hasText, isRecord } from './utils.js';

const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const MODEL_LOAD_TIMEOUT_MS = 300_000;

interface ModelDiscovery {
  models: ModelSpec[];
  loadedModelIds: Set<string>;
}

function parseModel(value: unknown): ModelSpec | null {
  if (
    !isRecord(value) ||
    value.type !== 'llm' ||
    !isLanguageModelName(value.key)
  ) {
    return null;
  }
  const loadedContexts = Array.isArray(value.loaded_instances)
    ? value.loaded_instances
        .map((instance) => {
          if (!isRecord(instance) || !isRecord(instance.config)) {
            return null;
          }
          return readPositiveTokenCount(instance.config.context_length);
        })
        .filter((context): context is number => context !== null)
    : [];
  const catalogContext = readPositiveTokenCount(value.max_context_length);
  const contextWindowTokens =
    loadedContexts.length > 0 ? Math.min(...loadedContexts) : catalogContext;
  if (contextWindowTokens === null) {
    return null;
  }
  const label =
    typeof value.display_name === 'string' ? value.display_name : value.key;
  if (!isLanguageModelName(label)) {
    return null;
  }
  return {
    name: value.key,
    label,
    limits: { kind: 'shared-context', contextWindowTokens },
  };
}

function validateModelMetadata(models: unknown[], token?: string): void {
  for (const entry of models) {
    if (!isRecord(entry) || entry.type !== 'llm') {
      continue;
    }
    rejectUnsafeModelMetadata(
      [entry.key, entry.display_name],
      token,
      'Invalid LM Studio model metadata',
    );
  }
}

function getLoadedModelIds(models: unknown[]): Set<string> {
  const loadedModelIds = new Set<string>();
  for (const entry of models) {
    if (!isRecord(entry) || !isLanguageModelName(entry.key)) {
      continue;
    }
    const isLoaded =
      Array.isArray(entry.loaded_instances) &&
      entry.loaded_instances.some(
        (instance) =>
          isRecord(instance) &&
          isRecord(instance.config) &&
          (readPositiveTokenCount(instance.config.context_length) ?? 0) > 0,
      );
    if (isLoaded) {
      loadedModelIds.add(entry.key);
    }
  }
  return loadedModelIds;
}

async function discoverModels(
  url: URL,
  config: Config,
  token?: string,
): Promise<ModelDiscovery> {
  const payload = await requestLanguageModelJson({
    providerLabel: 'LM Studio',
    url: new URL('/api/v1/models', url),
    timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
    token,
    init: hasText(token)
      ? { headers: { authorization: `Bearer ${token}` } }
      : undefined,
    config,
  });
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw createLanguageModelApiError('Invalid LM Studio model catalogue', {
      kind: 'invalid-model',
    });
  }
  validateModelMetadata(payload.models, token);
  const models = collectSortedModels(payload.models, parseModel);
  requireDistinctModels(models, 'LM Studio', createLanguageModelApiError);
  return { models, loadedModelIds: getLoadedModelIds(payload.models) };
}

interface LoadModelOptions {
  modelName: string;
  discovery: ModelDiscovery;
  url: URL;
  config: Config;
  token?: string;
}

async function loadModel({
  modelName,
  discovery,
  url,
  config,
  token,
}: LoadModelOptions): Promise<ModelDiscovery> {
  if (discovery.loadedModelIds.has(modelName)) {
    return discovery;
  }
  const headers = new Headers({ 'content-type': 'application/json' });
  if (hasText(token)) {
    headers.set('authorization', `Bearer ${token}`);
  }
  const loadResult = await requestLanguageModelJson({
    providerLabel: 'LM Studio',
    url: new URL('/api/v1/models/load', url),
    timeoutMs: MODEL_LOAD_TIMEOUT_MS,
    token,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelName }),
    },
    config,
  });
  if (
    !isRecord(loadResult) ||
    loadResult.status !== 'loaded' ||
    loadResult.type !== 'llm'
  ) {
    throw createLanguageModelApiError('Invalid LM Studio load response');
  }
  const refreshed = await discoverModels(url, config, token);
  if (!refreshed.loadedModelIds.has(modelName)) {
    throw createLanguageModelApiError(
      'LM Studio model did not report loaded state',
    );
  }
  return refreshed;
}

interface LmStudioProviderOptions {
  baseUrl: string;
  model?: string;
  token?: string;
  probeOnly?: boolean;
  config: Config;
  logger?: Logger;
  debugApi?: boolean;
}

function selectModel(
  discovery: ModelDiscovery,
  configuredModel?: string,
): string {
  if (
    hasText(configuredModel) &&
    !discovery.models.some((model) => model.name === configuredModel)
  ) {
    throw new Error('Configured LM Studio model is not available');
  }
  return (
    configuredModel ??
    discovery.models.find((model) => discovery.loadedModelIds.has(model.name))
      ?.name ??
    discovery.models[0].name
  );
}

export async function createLmStudioProvider(
  options: LmStudioProviderOptions,
): Promise<LanguageModelProvider> {
  const url = parseProviderBaseUrl(options.baseUrl, 'LM Studio', {
    allowHttps: false,
    loopbackError: 'LM Studio URL must use a loopback hostname',
  });
  const { token } = options;
  if (hasText(token) && !isHeaderSafeToken(token)) {
    throw createLanguageModelApiError('Invalid LM Studio API token');
  }
  const { config } = options;
  const fetchImpl =
    options.logger !== undefined &&
    (options.debugApi === true || config.DEBUG_API)
      ? withRequestTrace(
          options.logger,
          globalThis.fetch,
          'LM Studio',
          options.token,
        )
      : undefined;
  const discoveredModels = await discoverModels(url, config, options.token);
  const selectedModel = selectModel(discoveredModels, options.model);
  const discovery =
    options.probeOnly === true
      ? discoveredModels
      : await loadModel({
          modelName: selectedModel,
          discovery: discoveredModels,
          url,
          config,
          token: options.token,
        });
  const byName = new Map(discovery.models.map((model) => [model.name, model]));
  if (!byName.has(selectedModel)) {
    throw new Error('Configured LM Studio model is not available');
  }

  async function generate(
    params: LanguageModelGenerateParams,
  ): Promise<LanguageModelResponse | null> {
    if (!byName.has(params.modelName)) {
      throw new Error('Unknown LM Studio model');
    }
    return await generateOpenAiCompatibleChat({
      providerLabel: 'LM Studio',
      url: new URL('/v1/chat/completions', url),
      token: options.token,
      params,
      fetchImpl,
      config,
    });
  }
  return {
    id: 'lm-studio',
    label: 'LM Studio',
    defaultModel: selectedModel,
    service: { generate },
    models: async () => await Promise.resolve(discovery.models),
  };
}
