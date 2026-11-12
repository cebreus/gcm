import type { Config } from '../gcm.config.js';
import { listGeminiModels } from './gemini-models.js';
import {
  type LanguageModelGenerateParams,
  type LanguageModelProvider,
  type LanguageModelResponse,
  type LanguageModelService,
  createLanguageModelApiError,
  getModelSpecValidationError,
  isModelUnavailableError,
} from './language-model-service.js';
import type { Logger } from './logger.js';
import {
  type ModelSpec,
  canUseFallbackModel,
  requireDistinctModels,
} from './model-registry.js';
import { generateOpenAiCompatibleChat } from './openai-compatible-client.js';
import { type ProviderFetch, withRequestTrace } from './provider-http.js';

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_MODEL = 'gemini-3.5-flash';

const CHAT_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const UNSUPPORTED_MODEL_PATTERN =
  /(?:^gemini-2\.5-|preview|experimental|embedding|image|tts|audio|live|robotics|computer-use|veo|imagen|nano-banana|omni|transcribe)/iv;

function selectCompatibleModels(discovered: ModelSpec[]): ModelSpec[] {
  const compatible: ModelSpec[] = [];
  for (const value of discovered) {
    const model = { ...value, name: value.name.replace(/^models\//v, '') };
    if (!model.name.startsWith('gemini-')) {
      continue;
    }
    if (UNSUPPORTED_MODEL_PATTERN.test(model.name)) {
      continue;
    }
    const validationError = getModelSpecValidationError(model);
    if (validationError !== null) {
      throw createLanguageModelApiError(validationError, {
        kind: 'invalid-model',
      });
    }
    compatible.push(model);
  }
  return requireDistinctModels(
    compatible,
    'Gemini',
    createLanguageModelApiError,
  );
}

export function createGeminiProvider(options: {
  logger: Logger;
  debugApi?: boolean;
  service?: LanguageModelService;
  listModels?: (credential: string) => Promise<ModelSpec[]>;
  fetchImpl?: ProviderFetch;
  config: Config;
}): LanguageModelProvider {
  const { config } = options;
  const { GEMINI_API_KEY: apiKey } = config;
  const listModels =
    options.listModels ??
    (async (credential: string) => await listGeminiModels(credential, config));
  const traced = options.debugApi === true || config.DEBUG_API;
  const baseFetch = options.fetchImpl ?? globalThis.fetch;
  const fetchImpl = traced
    ? withRequestTrace(options.logger, baseFetch, 'Gemini', apiKey)
    : baseFetch;
  let cataloguePromise: Promise<ModelSpec[]> | null = null;

  async function loadModels(): Promise<ModelSpec[]> {
    if (apiKey === '') {
      return await Promise.reject(
        new Error('GOOGLE_GEMINI_API_KEY is not set.'),
      );
    }
    if (cataloguePromise !== null) {
      return await cataloguePromise;
    }
    cataloguePromise = listModels(apiKey)
      .then(selectCompatibleModels)
      .catch((error: unknown) => {
        cataloguePromise = null;
        throw error;
      });
    return await cataloguePromise;
  }

  async function generateWithModel(
    params: LanguageModelGenerateParams,
    modelName: string,
  ): Promise<LanguageModelResponse | null> {
    const known = (await loadModels()).some(
      (candidate) => candidate.name === modelName,
    );
    if (!known) {
      throw new Error('Unknown Gemini model');
    }
    return await generateOpenAiCompatibleChat({
      providerLabel: 'Gemini',
      url: new URL(CHAT_URL),
      token: apiKey,
      params: { ...params, modelName },
      fetchImpl,
      config,
    });
  }

  async function generate(
    params: LanguageModelGenerateParams,
  ): Promise<LanguageModelResponse | null> {
    try {
      return await generateWithModel(params, params.modelName);
    } catch (error) {
      if (!isModelUnavailableError(error)) {
        throw error;
      }
      const models = await loadModels();
      const primary = models.find((model) => model.name === DEFAULT_MODEL);
      const fallback = models.find((model) => model.name === FALLBACK_MODEL);
      if (
        params.modelName !== DEFAULT_MODEL ||
        primary === undefined ||
        fallback === undefined ||
        !canUseFallbackModel(primary.limits, fallback.limits)
      ) {
        throw error;
      }
      options.logger.log(
        'info',
        `${DEFAULT_MODEL} unavailable; retrying with ${FALLBACK_MODEL}`,
      );
      return await generateWithModel(params, FALLBACK_MODEL);
    }
  }

  return {
    id: 'gemini',
    label: 'Gemini',
    readinessError:
      apiKey === ''
        ? 'Environment variable GOOGLE_GEMINI_API_KEY not set.'
        : undefined,
    defaultModel: config.MODEL,
    service: options.service ?? { generate },
    models: loadModels,
  };
}
