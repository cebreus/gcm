import type { Config } from '../gcm.config.js';
import { listGeminiModels } from './gemini-models.js';
import {
  createLanguageModelApiError,
  isModelUnavailableError,
  getModelSpecValidationError,
  type LanguageModelGenerateParams,
  type LanguageModelProvider,
  type LanguageModelService,
} from './language-model-service.js';
import type { Logger } from './logger.js';
import { canUseFallbackModel, requireDistinctModels, type ModelSpec } from './model-registry.js';
import { generateOpenAiCompatibleChat } from './openai-compatible-client.js';
import { withRequestTrace, type ProviderFetch } from './provider-http.js';

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_MODEL = 'gemini-3.5-flash';

const CHAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const UNSUPPORTED_MODEL_PATTERN =
  /(^gemini-2\.5-|preview|experimental|embedding|image|tts|audio|live|robotics|computer-use|veo|imagen|nano-banana|omni|transcribe)/i;

function selectCompatibleModels(discovered: ModelSpec[]): ModelSpec[] {
  const compatible: ModelSpec[] = [];
  for (const value of discovered) {
    const model = { ...value, name: value.name.replace(/^models\//, '') };
    if (!model.name.startsWith('gemini-')) continue;
    if (UNSUPPORTED_MODEL_PATTERN.test(model.name)) continue;
    const validationError = getModelSpecValidationError(model);
    if (validationError) {
      throw createLanguageModelApiError(validationError);
    }
    compatible.push(model);
  }
  return requireDistinctModels(compatible, 'Gemini', createLanguageModelApiError);
}

export function createGeminiProvider(options: {
  logger: Logger;
  debugApi?: boolean;
  service?: LanguageModelService;
  listModels?: (credential: string) => Promise<ModelSpec[]>;
  fetchImpl?: ProviderFetch;
  config: Config;
}): LanguageModelProvider {
  const config = options.config;
  const apiKey = config.GEMINI_API_KEY;
  const listModels =
    options.listModels ?? ((credential: string) => listGeminiModels(credential, config));
  const traced = options.debugApi === true || config.DEBUG_API;
  const baseFetch = options.fetchImpl ?? globalThis.fetch;
  const fetchImpl = traced
    ? withRequestTrace(options.logger, baseFetch, 'Gemini', apiKey)
    : baseFetch;
  let cataloguePromise: Promise<ModelSpec[]> | null = null;

  function loadModels(): Promise<ModelSpec[]> {
    if (!apiKey) return Promise.reject(new Error('GOOGLE_GEMINI_API_KEY is not set.'));
    if (cataloguePromise) return cataloguePromise;
    cataloguePromise = listModels(apiKey)
      .then(selectCompatibleModels)
      .catch((error: unknown) => {
        cataloguePromise = null;
        throw error;
      });
    return cataloguePromise;
  }

  async function generateWithModel(params: LanguageModelGenerateParams, modelName: string) {
    const known = (await loadModels()).some(candidate => candidate.name === modelName);
    if (!known) throw new Error('Unknown Gemini model');
    return generateOpenAiCompatibleChat({
      providerLabel: 'Gemini',
      url: new URL(CHAT_URL),
      token: apiKey,
      params: { ...params, modelName },
      fetchImpl,
      config,
    });
  }

  async function generate(params: LanguageModelGenerateParams) {
    try {
      return await generateWithModel(params, params.modelName);
    } catch (error) {
      if (!isModelUnavailableError(error)) throw error;
      const models = await loadModels();
      const primary = models.find(model => model.name === DEFAULT_MODEL);
      const fallback = models.find(model => model.name === FALLBACK_MODEL);
      if (
        params.modelName !== DEFAULT_MODEL ||
        !primary ||
        !fallback ||
        !canUseFallbackModel(primary.limits, fallback.limits)
      ) {
        throw error;
      }
      options.logger.log('info', `${DEFAULT_MODEL} unavailable; retrying with ${FALLBACK_MODEL}`);
      return generateWithModel(params, FALLBACK_MODEL);
    }
  }

  return {
    id: 'gemini',
    label: 'Gemini',
    readinessError: apiKey ? undefined : 'Environment variable GOOGLE_GEMINI_API_KEY not set.',
    defaultModel: config.MODEL,
    service: options.service ?? { generate },
    models: loadModels,
  };
}
