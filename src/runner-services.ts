import { confirm, isCancel, note, outro, select, text } from '@clack/prompts';
import clipboardy from 'clipboardy';

import type { Config } from '../gcm.config.js';
import { createCommitActionService } from './commit-action-service.js';
import type { GenerationServices } from './generation-types.js';
import {
  type InteractiveGenerationDialogue,
  type ProviderChoice,
  createInteractiveGenerationDialogue,
} from './interactive-generation-dialogue.js';
import type { LanguageModelProvider } from './language-model-service.js';
import type { Logger } from './logger.js';
import type { ProjectConfig } from './project-config.js';
import type { ProviderFactoryOptions } from './provider-factories.js';
import { reportCancel } from './runner-output.js';
import { getCommitContextHints } from './scope-detector.js';
import { createContextService } from './services/context-service.js';
import type { ContextService } from './services/context-service.js';
import type { GitService } from './services/git-service.js';
import { readCommitContextFacts } from './services/repository-context.js';
import { summarizeRepositoryDiff } from './services/repository-summary.js';
import { saveSession } from './session.js';

export interface RunnerOptions extends ProviderFactoryOptions {
  isInteractive?: boolean;
  logger?: Logger;
  gitService?: GitService;
  contextService?: ContextService;
}

function createRunnerDialogue(
  provider: LanguageModelProvider,
  providers: ProviderChoice[],
): InteractiveGenerationDialogue {
  return createInteractiveGenerationDialogue({
    prompts: {
      select,
      text,
      confirm,
      note,
      outro,
      cancel: reportCancel,
      isCancel,
    },
    clipboard: {
      write: async (message) => {
        await clipboardy.write(message);
      },
    },
    models: async () => await provider.models(),
    providers,
  });
}

interface RunnerServicesOptions {
  opts: RunnerOptions;
  logger: Logger;
  provider: LanguageModelProvider;
  providers: ProviderChoice[];
  gitService: GitService;
  allowDirectAmend: boolean;
  config: Config;
  projectConfig: ProjectConfig;
}

export function createRunnerServices(
  options: RunnerServicesOptions,
): Omit<GenerationServices, 'output'> {
  const {
    opts,
    logger,
    provider,
    providers,
    gitService,
    allowDirectAmend,
    config,
    projectConfig,
  } = options;
  const contextService =
    opts.contextService ??
    createContextService({
      summarizeLargeDiff: async (files, options) =>
        await summarizeRepositoryDiff(files, options, config),
    });
  const dialogue = createRunnerDialogue(provider, providers);
  const commitActions = createCommitActionService({
    gitService,
    logger,
    allowDirectAmend,
  });
  async function resolveCommitContextHints(
    files: string[],
  ): Promise<ReturnType<typeof getCommitContextHints>> {
    return getCommitContextHints(files, await readCommitContextFacts(files));
  }
  return {
    config,
    projectConfig,
    gitService,
    contextService,
    languageModelService: provider.service,
    providerId: provider.id,
    providerLabel: provider.label,
    models: async () => await provider.models(),
    dialogue,
    commitActions,
    getCommitContextHints: resolveCommitContextHints,
    saveSession,
  };
}
