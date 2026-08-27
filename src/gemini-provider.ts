import { CONFIG } from '../gcm.config.js';
import { createGeminiClient } from './gemini-client.js';
import { listGeminiModels } from './gemini-client/listModels.js';
import {
  createLanguageModelApiError,
  getModelSpecValidationError,
  type LanguageModelProvider,
  type LanguageModelService,
} from './language-model-service.js';
import type { Logger } from './logger.js';
import type { ModelSpec } from './model-registry.js';
import { createGeminiService } from './services/gemini-service.js';

export function createGeminiProvider(options: {
  logger: Logger;
  debugApi?: boolean;
  service?: LanguageModelService;
  listModels?: (credential: string) => Promise<ModelSpec[]>;
}): LanguageModelProvider {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY ?? '';
  let debugApi = CONFIG.DEBUG_API;
  if (options.debugApi === true) debugApi = true;
  const service =
    options.service ??
    createGeminiService({
      client: createGeminiClient({
        config: { ...CONFIG, DEBUG_API: debugApi },
        logger: options.logger,
      }),
      logger: options.logger,
      apiKey,
    });
  const listModels = options.listModels ?? listGeminiModels;
  let cataloguePromise: Promise<ModelSpec[]> | null = null;

  function loadModels(): Promise<ModelSpec[]> {
    if (!apiKey) return Promise.reject(new Error('GOOGLE_GEMINI_API_KEY is not set.'));
    if (cataloguePromise) return cataloguePromise;
    cataloguePromise = listModels(apiKey).then(function (discovered) {
      const compatible: ModelSpec[] = [];
      const names = new Set<string>();
      for (const value of discovered) {
        const model = { ...value, name: value.name.replace(/^models\//, '') };
        if (!model.name.startsWith('gemini-')) continue;
        if (/(embedding|image|tts|audio|live|robotics|computer-use|veo|imagen)/i.test(model.name)) {
          continue;
        }
        const validationError = getModelSpecValidationError(model);
        if (validationError) {
          throw createLanguageModelApiError(validationError, { category: 'data' });
        }
        if (names.has(model.name)) {
          throw createLanguageModelApiError('Duplicate Gemini model identifier', {
            category: 'data',
          });
        }
        names.add(model.name);
        compatible.push(model);
      }
      if (compatible.length === 0) {
        throw createLanguageModelApiError('Gemini returned no compatible text models', {
          category: 'data',
        });
      }
      return compatible;
    });
    cataloguePromise = cataloguePromise.catch(function (error: unknown) {
      cataloguePromise = null;
      throw error;
    });
    return cataloguePromise;
  }

  return {
    id: 'gemini',
    label: 'Gemini',
    readinessError: apiKey ? undefined : 'Environment variable GOOGLE_GEMINI_API_KEY not set.',
    defaultModel: CONFIG.MODEL,
    service,
    models: loadModels,
  };
}
