import { intro, note, outro } from '@clack/prompts';

import type { Config } from '../gcm.config.js';
import pkg from '../package.json';
import type { ParsedOptions } from './cli.js';
import { runCommitRangeCommand } from './commit-range-command.js';
import type { GenerationServices } from './generation-types.js';
import { createGenerationState, runGenerationCommand } from './generation.js';
import type {
  LanguageModelProvider,
  LanguageModelProviderFactory,
} from './language-model-service.js';
import type { Logger } from './logger.js';
import { runModelsListCommand } from './models-list-command.js';
import type { ProjectConfig } from './project-config.js';
import {
  C,
  createProgressSpinner,
  createRunnerOutput,
  forStream,
  reportCancel,
} from './runner-output.js';
import { type RunnerOptions, createRunnerServices } from './runner-services.js';
import type { GitService } from './services/git-service.js';
import { loadProjectConfig } from './services/project-config-service.js';
import type { GCMSession } from './session.js';
import { sanitizeTerminalText } from './utils.js';

const providerModelEnv: Record<string, string | undefined> = {
  gemini: 'GCM_MODEL',
  freellmapi: 'GCM_FREELLMAPI_MODEL',
  'lm-studio': 'GCM_LM_STUDIO_MODEL',
};

function configuredModelFor(providerId: string): string | undefined {
  const { [providerId]: name } = providerModelEnv;
  const value = name === undefined ? undefined : process.env[name];
  return value === '' ? undefined : value;
}

const EXIT_CODES = { success: 0, failure: 1 } as const;

async function maybeHandleModelsList(
  parsedArgs: ParsedOptions,
  provider: LanguageModelProvider,
): Promise<number | null> {
  if (!parsedArgs.modelsList) {
    return null;
  }
  return await runModelsListCommand({
    providerLabel: provider.label,
    readinessError: provider.readinessError,
    models: async () => await provider.models(),
    output: { cancel: reportCancel, note, outro },
  });
}

export interface ProviderLoopContext {
  opts: RunnerOptions;
  parsedArgs: ParsedOptions;
  logger: Logger;
  factories: LanguageModelProviderFactory[];
  gitService: GitService;
  config: Config;
  session: GCMSession;
  isInteractive: boolean;
}

interface ActiveProviderOptions extends ProviderLoopContext {
  provider: LanguageModelProvider;
  providerSwitched: boolean;
  keepSavedSession: boolean;
}

type ActiveProviderResult =
  { exitCode: number } | { switchToProviderId: string };

async function loadProjectConfigOrReport(): Promise<ProjectConfig | null> {
  try {
    return await loadProjectConfig();
  } catch (error) {
    reportCancel(
      `Error: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
    );
    return null;
  }
}

export async function runActiveProvider(
  options: ActiveProviderOptions,
): Promise<ActiveProviderResult> {
  const {
    opts,
    parsedArgs,
    logger,
    provider,
    factories,
    gitService,
    config,
    session,
    isInteractive,
    providerSwitched,
    keepSavedSession,
  } = options;
  if (!parsedArgs.print) {
    intro(
      forStream(
        `${C.bright}${provider.label} Commit Message Helper v${pkg.version}${C.reset}`,
        process.stderr,
      ),
      { output: process.stderr },
    );
  }
  const earlyExitCode = await maybeHandleModelsList(parsedArgs, provider);
  if (earlyExitCode !== null) {
    return { exitCode: earlyExitCode };
  }
  const projectConfig = await loadProjectConfigOrReport();
  if (projectConfig === null) {
    return { exitCode: 1 };
  }
  const output = createRunnerOutput(
    createProgressSpinner(),
    isInteractive && !parsedArgs.nonInteractive,
    parsedArgs.print,
  );
  const activeParsedArgs = providerSwitched
    ? { ...parsedArgs, model: null }
    : parsedArgs;
  const { targetCommit, state } = createGenerationState({
    parsedArgs: activeParsedArgs,
    session,
    defaultModel: provider.defaultModel,
    providerId: provider.id,
    configuredModel: configuredModelFor(provider.id),
  });
  const createServices = (
    allowDirectAmend: boolean,
  ): Omit<GenerationServices, 'output'> =>
    createRunnerServices({
      opts,
      logger,
      provider,
      providers: factories,
      gitService,
      allowDirectAmend,
      config,
      projectConfig,
    });
  if (activeParsedArgs.commitRange !== null) {
    const outcome = await runCommitRangeCommand({
      gitService,
      range: activeParsedArgs.commitRange,
      createServices: () => createServices(false),
      parsedArgs: activeParsedArgs,
      logger,
      providerReadinessError: provider.readinessError,
      state,
      output,
    });
    return { exitCode: EXIT_CODES[outcome] };
  }
  const outcome = await runGenerationCommand({
    createServices: () => {
      const services = createServices(true);
      return keepSavedSession
        ? {
            ...services,
            saveSession: async () => {
              await Promise.resolve();
            },
          }
        : services;
    },
    parsedArgs: activeParsedArgs,
    logger,
    providerReadinessError: provider.readinessError,
    canSwitchProvider: factories.length > 1 && output.isInteractive,
    targetCommit,
    state,
    output,
  });
  return typeof outcome === 'object'
    ? { switchToProviderId: outcome.providerId }
    : { exitCode: EXIT_CODES[outcome] };
}
