import { CONFIG } from '../gcm.config.js';
import { createFreeLlmApiProvider } from './freellmapi-provider.js';
import { createGeminiProvider } from './gemini-provider.js';
import type {
  LanguageModelProvider,
  LanguageModelProviderFactory,
  LanguageModelService,
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
        create: async () => provider,
      },
    ];
  }
  return (
    options.languageModelProviderFactories ?? [
      {
        id: 'gemini',
        label: 'Gemini',
        create: async () =>
          createGeminiProvider({
            logger,
            debugApi,
            service: options.geminiService,
            listModels: options.geminiModelLister,
          }),
      },
      {
        id: 'freellmapi',
        label: 'FreeLLMAPI',
        create: async () =>
          createFreeLlmApiProvider({
            baseUrl: CONFIG.FREELLMAPI_URL,
            model: CONFIG.FREELLMAPI_MODEL,
            token: CONFIG.FREELLMAPI_TOKEN,
          }),
      },
      {
        id: 'lm-studio',
        label: 'LM Studio',
        create: async factoryOptions =>
          createLmStudioProvider({
            baseUrl: process.env.GCM_LM_STUDIO_URL ?? 'http://127.0.0.1:1234',
            model: process.env.GCM_LM_STUDIO_MODEL,
            token: process.env.LM_API_TOKEN,
            probeOnly: factoryOptions?.probeOnly,
          }),
      },
    ]
  );
}
