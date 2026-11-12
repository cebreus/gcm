import { intro, note, outro } from '@clack/prompts';

import { type Config, loadConfig } from '../gcm.config.js';
import pkg from '../package.json';
import {
  type ProviderLoopContext,
  runActiveProvider,
} from './active-provider.js';
import { isArgumentValidationError, parseArgs } from './cli.js';
import type { ParsedOptions } from './cli.js';
import { isGitFailure } from './git-utils.js';
import type {
  LanguageModelProvider,
  LanguageModelProviderFactory,
} from './language-model-service.js';
import { isLanguageModelName } from './language-model-service.js';
import { createLogger } from './logger.js';
import type { Logger, LoggerConfig } from './logger.js';
import { createProviderFactories } from './provider-factories.js';
import { type ProviderRecovery, recoverProvider } from './provider-recovery.js';
import { runProvidersListCommand } from './providers-list-command.js';
import {
  C,
  forStream,
  reportCancel,
  showHelp,
  unknownProviderMessage,
} from './runner-output.js';
import type { RunnerOptions } from './runner-services.js';
import { createGitService } from './services/git-service.js';
import type { GitService } from './services/git-service.js';
import { type GCMSession, loadSession } from './session.js';
import { hasText } from './utils.js';

function buildLoggerConfig(
  parsedArgs: ParsedOptions,
  config: Config,
): LoggerConfig {
  const loggerConfig: LoggerConfig = {
    LOG_LEVEL: config.LOG_LEVEL,
  };
  if (parsedArgs.verbose || parsedArgs.debug || config.DEBUG_API) {
    loggerConfig.LOG_LEVEL = 'debug';
  }
  return loggerConfig;
}

function parseArgsOrReport(argv?: string[]): ParsedOptions | null {
  try {
    return parseArgs(argv);
  } catch (error) {
    if (!isArgumentValidationError(error)) {
      throw error;
    }
    const message = `Error: ${error.message}. Run gcm --help for usage.`;
    reportCancel(message);
    return null;
  }
}

interface ProviderLoopState {
  providerId: string;
  previousProviderId: string | null;
  providerSwitched: boolean;
  // Only the saved session picked the provider: a non-interactive failure may fall back to the default.
  sessionOnly: boolean;
  // A fallback is a one-off: it must not overwrite the saved provider and model.
  keepSavedSession: boolean;
}

type ProviderStep = { exitCode: number } | { next: ProviderLoopState };

async function tryCreateProvider(
  factory: LanguageModelProviderFactory,
): Promise<{ provider: LanguageModelProvider } | { error: unknown }> {
  try {
    return { provider: await factory.create() };
  } catch (error) {
    return { error };
  }
}

function applyRecovery(
  state: ProviderLoopState,
  recovery: ProviderRecovery,
): ProviderStep {
  if (recovery.kind === 'switch') {
    return {
      next: {
        ...state,
        providerId: recovery.providerId,
        previousProviderId: null,
        providerSwitched: recovery.providerSwitched,
      },
    };
  }
  if (recovery.kind === 'fallback') {
    return {
      next: {
        ...state,
        providerId: recovery.providerId,
        sessionOnly: false,
        keepSavedSession: true,
      },
    };
  }
  return { exitCode: 1 };
}

async function runProviderStep(
  context: ProviderLoopContext,
  state: ProviderLoopState,
): Promise<ProviderStep> {
  const { factories, parsedArgs, isInteractive } = context;
  const factory = factories.find(
    (candidate) => candidate.id === state.providerId,
  );
  if (factory === undefined) {
    reportCancel(unknownProviderMessage(state.providerId, factories));
    return { exitCode: 1 };
  }
  const created = await tryCreateProvider(factory);
  if ('error' in created) {
    const recovery = await recoverProvider({
      error: created.error,
      factory,
      factories,
      previousProviderId: state.previousProviderId,
      isInteractive,
      nonInteractive: parsedArgs.nonInteractive,
      sessionOnly: state.sessionOnly,
    });
    return applyRecovery(state, recovery);
  }
  const outcome = await runActiveProvider({
    ...context,
    provider: created.provider,
    providerSwitched: state.providerSwitched,
    keepSavedSession: state.keepSavedSession,
  });
  if ('exitCode' in outcome) {
    return outcome;
  }
  return {
    next: {
      ...state,
      previousProviderId: state.providerId,
      providerId: outcome.switchToProviderId,
      providerSwitched: true,
    },
  };
}

// Each provider attempt depends on the previous outcome; switches are few.
async function runProviderLoop(
  context: ProviderLoopContext,
  state: ProviderLoopState,
): Promise<number> {
  const step = await runProviderStep(context, state);
  return 'exitCode' in step
    ? step.exitCode
    : await runProviderLoop(context, step.next);
}

function loadRunConfig(help: boolean): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (!help) {
      throw error;
    }
    return loadConfig({}); // --help stays usable; provider text falls back to defaults
  }
}

interface FactoryContext {
  opts: RunnerOptions;
  parsedArgs: ParsedOptions;
  config: Config;
  logger: Logger;
  factories: LanguageModelProviderFactory[];
}

function resolveProviderId(
  { opts, parsedArgs, config, factories }: FactoryContext,
  session: GCMSession,
): string | undefined {
  if (opts.languageModelProvider !== undefined) {
    return opts.languageModelProvider.id;
  }
  // Session file is local but may be stale or hand-edited: its provider counts only if a factory exists for it.
  const sessionProviderId = factories.some(
    (factory) => factory.id === session.providerId,
  )
    ? session.providerId
    : undefined;
  return (
    parsedArgs.provider ??
    config.PROVIDER ??
    sessionProviderId ??
    factories[0]?.id
  );
}

function selectProviderId(
  context: FactoryContext,
  session: GCMSession,
): string | null {
  const providerId = resolveProviderId(context, session);
  if (!hasText(providerId)) {
    reportCancel('Error: No language model provider available.');
    return null;
  }
  const {
    parsedArgs: { model },
  } = context;
  if (hasText(model) && !isLanguageModelName(model)) {
    reportCancel('Error: Invalid model name.');
    return null;
  }
  return providerId;
}

function showHelpScreen(
  factories: LanguageModelProviderFactory[],
  providerId: string,
): number {
  const helpFactory =
    factories.find((factory) => factory.id === providerId) ?? factories.at(0);
  if (helpFactory === undefined) {
    reportCancel(unknownProviderMessage(providerId, factories));
    return 1;
  }
  intro(
    forStream(
      `${C.bright}${helpFactory.label} Commit Message Helper v${pkg.version}${C.reset}`,
    ),
  );
  showHelp(
    helpFactory.label,
    factories.map((factory) => factory.id),
  );
  return 0;
}

// Cheap local probe first: a run outside a repository must not reach any provider.
async function isOutsideRepository(
  gitService: GitService,
  logger: Logger,
): Promise<boolean> {
  try {
    await gitService.getRepositoryState(logger);
    return false;
  } catch (error) {
    if (!isGitFailure(error, 'not-a-repository')) {
      throw error;
    }
    reportCancel('Error: Not inside a git repository.');
    return true;
  }
}

// An explicit --model targets the saved provider, so it stays fatal rather than moving to another one.
function isSessionOnly({ opts, parsedArgs, config }: FactoryContext): boolean {
  return (
    opts.languageModelProvider === undefined &&
    !hasText(parsedArgs.provider) &&
    !hasText(config.PROVIDER) &&
    !hasText(parsedArgs.model)
  );
}

async function runWithFactories(context: FactoryContext): Promise<number> {
  const { opts, parsedArgs, config, logger, factories } = context;
  const session = await loadSession();
  const providerId = selectProviderId(context, session);
  if (providerId === null) {
    return 1;
  }
  if (parsedArgs.help) {
    return showHelpScreen(factories, providerId);
  }
  if (!factories.some((factory) => factory.id === providerId)) {
    reportCancel(unknownProviderMessage(providerId, factories));
    return 1;
  }
  const gitService =
    opts.gitService ??
    createGitService({ maxBytes: config.CHILD_PROCESS_MAX_BUFFER });
  if (
    !parsedArgs.modelsList &&
    (await isOutsideRepository(gitService, logger))
  ) {
    return 1;
  }
  // Node types declare isTTY as boolean, but it is undefined on a pipe.
  const stdinIsTty = (process.stdin.isTTY as boolean | undefined) === true;
  return await runProviderLoop(
    {
      opts,
      parsedArgs,
      logger,
      factories,
      gitService,
      config,
      session,
      isInteractive: opts.isInteractive ?? stdinIsTty,
    },
    {
      providerId,
      previousProviderId: null,
      providerSwitched: false,
      sessionOnly: isSessionOnly(context),
      keepSavedSession: false,
    },
  );
}

async function runParsedCommand(
  parsedArgs: ParsedOptions,
  opts: RunnerOptions,
): Promise<number> {
  const config = loadRunConfig(parsedArgs.help);
  const logger =
    opts.logger ?? createLogger(buildLoggerConfig(parsedArgs, config));
  // Checked before any provider is built, because GCM_MODEL becomes a
  // provider's default model and would otherwise surface as "unavailable".
  // --help never resolves a model, so it stays usable.
  if (!parsedArgs.help && !isLanguageModelName(config.MODEL)) {
    reportCancel('Error: Invalid GCM_MODEL.');
    return 1;
  }
  const factories = createProviderFactories(
    opts,
    logger,
    parsedArgs.debug,
    config,
  );
  if (parsedArgs.providersList && !parsedArgs.help) {
    return await runProvidersListCommand({
      factories,
      output: {
        note,
        outro,
        style: process.stdout.isTTY
          ? {
              available: (message) => `${C.green}${message}${C.reset}`,
              unavailable: (message) => `${C.yellow}${message}${C.reset}`,
            }
          : undefined,
      },
    });
  }
  return await runWithFactories({
    opts,
    parsedArgs,
    config,
    logger,
    factories,
  });
}

async function runCommitMessageGeneration(
  argv?: string[],
  dependencies?: RunnerOptions,
): Promise<number> {
  const parsedArgs = parseArgsOrReport(argv);
  if (parsedArgs === null) {
    return 1;
  }
  if (parsedArgs.version) {
    process.stdout.write(`${pkg.name} ${pkg.version}\n`);
    return 0;
  }
  return await runParsedCommand(parsedArgs, dependencies ?? {});
}

export async function executeCommitMessageGeneration(
  argv?: string[],
  dependencies?: RunnerOptions,
): Promise<void> {
  process.exitCode = await runCommitMessageGeneration(argv, dependencies);
}

export default { executeCommitMessageGeneration };
