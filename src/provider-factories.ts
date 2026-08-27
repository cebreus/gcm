import { CONFIG } from '../gcm.config.js';
import { createFreeLlmApiProvider } from './freellmapi-provider.js';
import { createGeminiProvider } from './gemini-provider.js';
import {
  isLanguageModelProviderId,
  type LanguageModelProvider,
  type LanguageModelProviderFactory,
  type LanguageModelService,
} from './language-model-service.js';
import { createLmStudioProvider } from './lm-studio-provider.js';
import type { Logger } from './logger.js';
import type { ModelSpec } from './model-registry.js';

export interface ProviderFactoryOptions {
  geminiService?: LanguageModelService;
  languageModelProvider?: LanguageModelProvider;
  languageModelProviderFactories?: LanguageModelProviderFactory[];
  geminiModelLister?: (credential: string) => Promise<ModelSpec[]>;
}

export function createProviderFactories(
  options: ProviderFactoryOptions,
  logger: Logger,
  debugApi = false,
): LanguageModelProviderFactory[] {
  if (options.languageModelProvider) {
    const provider = options.languageModelProvider;
    return [
      {
        id: provider.id,
        label: provider.label,
        create: async function () {
          return provider;
        },
      },
    ];
  }
  return (
    options.languageModelProviderFactories ?? [
      {
        id: 'gemini',
        label: 'Gemini',
        create: async function () {
          return createGeminiProvider({
            logger,
            debugApi,
            service: options.geminiService,
            listModels: options.geminiModelLister,
          });
        },
      },
      {
        id: 'freellmapi',
        label: 'FreeLLMAPI',
        create: async function () {
          return createFreeLlmApiProvider({
            baseUrl: CONFIG.FREELLMAPI_URL,
            model: CONFIG.FREELLMAPI_MODEL,
            token: CONFIG.FREELLMAPI_TOKEN,
            temperature: CONFIG.TEMP,
            maxOutputTokens: CONFIG.MAX_OUTPUT_TOKENS,
          });
        },
      },
      {
        id: 'lm-studio',
        label: 'LM Studio',
        create: async function (factoryOptions) {
          return createLmStudioProvider({
            baseUrl: process.env.GCM_LM_STUDIO_URL ?? 'http://127.0.0.1:1234',
            model: process.env.GCM_LM_STUDIO_MODEL,
            token: process.env.LM_API_TOKEN,
            temperature: CONFIG.TEMP,
            maxOutputTokens: CONFIG.MAX_OUTPUT_TOKENS,
            probeOnly: factoryOptions?.probeOnly,
          });
        },
      },
    ]
  );
}

export function getProviderFactoriesValidationError(
  factories: LanguageModelProviderFactory[],
): string | null {
  if (factories.length === 0) return 'No language model provider available';
  const ids = new Set<string>();
  for (const factory of factories) {
    if (!isLanguageModelProviderId(factory.id)) return 'Invalid language model provider id';
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(factory.label)) {
      return 'Invalid language model provider label';
    }
    if (ids.has(factory.id)) return 'Duplicate language model provider id';
    ids.add(factory.id);
  }
  return null;
}
