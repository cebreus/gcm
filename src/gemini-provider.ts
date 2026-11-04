import { CONFIG } from '../gcm.config.js';
import { listGeminiModels } from './gemini-models.js';
import {
  createLanguageModelApiError,
  getModelSpecValidationError,
  type LanguageModelGenerateParams,
  type LanguageModelProvider,
  type LanguageModelService,
} from './language-model-service.js';
import type { Logger } from './logger.js';
import { requireDistinctModels, type ModelSpec } from './model-registry.js';
import { generateOpenAiCompatibleChat } from './openai-compatible-client.js';
import { readResponseBody, type ProviderFetch } from './provider-http.js';
import { redactSensitiveText } from './utils.js';

const MAX_TRACED_BODY_CHARS = 32 * 1024;

const CHAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const UNSUPPORTED_MODEL_PATTERN =
  /(^gemini-2\.5-|preview|experimental|embedding|image|tts|audio|live|robotics|computer-use|veo|imagen|nano-banana|omni|transcribe)/i;

// Redaction runs before truncation: slicing first can cut a secret short of
// the pattern that would have matched it and log the remainder verbatim.
function traceBody(body: string): string {
  return redactSensitiveText(body).slice(0, MAX_TRACED_BODY_CHARS);
}

function withRequestTrace(logger: Logger, fetchImpl: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    logger.log('debug', 'Gemini API request', {
      url: String(input),
      body: traceBody(String(init?.body ?? '')),
    });
    const response = await fetchImpl(input, init);
    const body = await readResponseBody(response.clone())
      .then(traceBody)
      .catch(() => '[response body too large]');
    logger.log('debug', 'Gemini API response', {
      status: response.status,
      body,
    });
    return response;
  };
}

function selectCompatibleModels(discovered: ModelSpec[]): ModelSpec[] {
  const compatible: ModelSpec[] = [];
  for (const value of discovered) {
    const model = { ...value, name: value.name.replace(/^models\//, '') };
    if (!model.name.startsWith('gemini-')) continue;
    if (UNSUPPORTED_MODEL_PATTERN.test(model.name)) continue;
    const validationError = getModelSpecValidationError(model);
    if (validationError) {
      throw createLanguageModelApiError(validationError, { category: 'data' });
    }
    compatible.push(model);
  }
  return requireDistinctModels(compatible, 'Gemini', message =>
    createLanguageModelApiError(message, { category: 'data' }),
  );
}

export function createGeminiProvider(options: {
  logger: Logger;
  debugApi?: boolean;
  service?: LanguageModelService;
  listModels?: (credential: string) => Promise<ModelSpec[]>;
  fetchImpl?: ProviderFetch;
}): LanguageModelProvider {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY ?? '';
  const listModels = options.listModels ?? listGeminiModels;
  const traced = options.debugApi === true || CONFIG.DEBUG_API;
  const baseFetch = options.fetchImpl ?? globalThis.fetch;
  const fetchImpl = traced ? withRequestTrace(options.logger, baseFetch) : baseFetch;
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

  async function generate(params: LanguageModelGenerateParams) {
    const known = (await loadModels()).some(candidate => candidate.name === params.modelName);
    if (!known) throw new Error('Unknown Gemini model');
    return generateOpenAiCompatibleChat({
      providerLabel: 'Gemini',
      url: new URL(CHAT_URL),
      token: apiKey,
      params,
      fetchImpl,
    });
  }

  return {
    id: 'gemini',
    label: 'Gemini',
    readinessError: apiKey ? undefined : 'Environment variable GOOGLE_GEMINI_API_KEY not set.',
    defaultModel: CONFIG.MODEL,
    service: options.service ?? { generate },
    models: loadModels,
  };
}
