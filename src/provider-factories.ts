import type { Config } from '../gcm.config.js';
import { createFreeLlmApiProvider } from './freellmapi-provider.js';
import { createGeminiProvider } from './gemini-provider.js';
import type {
  LanguageModelProvider,
  LanguageModelProviderFactory,
  LanguageModelService,
} from './language-model-service.js';
import { createLmStudioProvider } from './lm-studio-provider.js';
import {
  checkLocalCliAuthentication,
  createClaudeCliProvider,
  createCodexCliProvider,
  type LocalCliRun,
} from './local-cli-provider.js';
import type { Logger } from './logger.js';
import type { ModelSpec } from './model-registry.js';

export interface ProviderFactoryOptions {
  geminiService?: LanguageModelService;
  languageModelProvider?: LanguageModelProvider;
  languageModelProviderFactories?: LanguageModelProviderFactory[];
  geminiModelLister?: (credential: string) => Promise<ModelSpec[]>;
  which?: (name: string) => string | null;
  localCliRun?: LocalCliRun;
}

export function createProviderFactories(
  options: ProviderFactoryOptions,
  logger: Logger,
  debugApi = false,
  config: Config,
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
  if (options.languageModelProviderFactories) return options.languageModelProviderFactories;
  const factories: LanguageModelProviderFactory[] = [
    {
      id: 'gemini',
      label: 'Gemini',
      create: async () =>
        createGeminiProvider({
          logger,
          debugApi,
          service: options.geminiService,
          listModels: options.geminiModelLister,
          config,
        }),
    },
    {
      id: 'freellmapi',
      label: 'FreeLLMAPI',
      create: async () =>
        createFreeLlmApiProvider({
          baseUrl: config.FREELLMAPI_URL,
          model: config.FREELLMAPI_MODEL,
          token: config.FREELLMAPI_TOKEN,
          config,
          logger,
          debugApi,
        }),
    },
    {
      id: 'lm-studio',
      label: 'LM Studio',
      create: async factoryOptions =>
        createLmStudioProvider({
          baseUrl: config.LM_STUDIO_URL,
          model: config.LM_STUDIO_MODEL,
          token: config.LM_STUDIO_TOKEN,
          config,
          logger,
          debugApi,
          probeOnly: factoryOptions?.probeOnly,
        }),
    },
  ];
  const which = options.which ?? Bun.which;
  for (const [command, id, label, create] of [
    ['codex', 'codex-cli', 'Codex CLI', createCodexCliProvider],
    ['claude', 'claude-cli', 'Claude CLI', createClaudeCliProvider],
  ] as const) {
    const executable = which(command);
    if (!executable) continue;
    factories.push({
      id,
      label,
      create: async function () {
        await checkLocalCliAuthentication(command, executable, options.localCliRun);
        return create({
          executable,
          run: options.localCliRun,
          onFallback: function (from, to) {
            logger.log('info', `${from} unavailable; retrying with ${to}`);
          },
        });
      },
    });
  }
  return factories;
}
