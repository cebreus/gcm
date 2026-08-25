import { CLI_OPTION_DEFINITIONS, isArgumentValidationError, parseArgs } from './cli.js';
import type { ParsedOptions } from './cli.js';
import { CONFIG } from '../gcm.config.js';
import { createLogger } from './logger.js';
import type { Logger, LoggerConfig } from './logger.js';
import { createGeminiClient } from './gemini-client.js';
import { listGeminiModels } from './gemini-client/listModels.js';
import { runListModelsCommand } from './list-models-command.js';
import { createGitService } from './services/git-service.js';
import type { GitService } from './services/git-service.js';
import { createCommitActionService } from './commit-action-service.js';
import { getCommitContextHints } from './scope-detector.js';
import { readCommitContextFacts } from './services/repository-context.js';
import { summarizeRepositoryDiff } from './services/repository-summary.js';
import { createContextService } from './services/context-service.js';
import type { ContextService } from './services/context-service.js';
import { createGeminiService } from './services/gemini-service.js';
import { createLmStudioProvider } from './lm-studio-provider.js';
import { createOpenAiProvider } from './openai-provider.js';
import type { LanguageModelProvider, LanguageModelService } from './language-model-service.js';
import {
  getLanguageModelProviderValidationError,
  isLanguageModelProviderId,
  isLanguageModelName,
} from './language-model-service.js';
import { getModelSpec, KNOWN_MODELS } from './model-registry.js';
import { loadSession, saveSession } from './session.js';
import {
  intro,
  outro,
  spinner,
  note,
  select,
  text,
  confirm,
  isCancel,
  cancel,
} from '@clack/prompts';
import { redactSensitiveText, sanitizeForDisplay, stripTerminalControlSequences } from './utils.js';
import clipboardy from 'clipboardy';
import pkg from '../package.json';
import {
  createInteractiveGenerationDialogue,
  type InteractiveGenerationDialogue,
} from './interactive-generation-dialogue.js';
import {
  createGenerationState,
  runGenerationCommand,
  type GenerationServices,
} from './generation.js';
import { runCommitBatch } from './batch-generation.js';

const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};

interface PackageInfo {
  name: string;
  version: string;
}

function getPackageInfo(): PackageInfo {
  return { name: pkg.name, version: pkg.version };
}

function showHelp(providerLabel: string) {
  const packageInfo = getPackageInfo();
  const optionWidth = Math.max(...CLI_OPTION_DEFINITIONS.map(option => option.usage.length));
  const options = CLI_OPTION_DEFINITIONS.map(function (option) {
    const description = option.description.replaceAll('{provider}', providerLabel);
    return `      ${C.cyan}${option.usage.padEnd(optionWidth)}${C.reset}  ${description}`;
  }).join('\n');
  const helpText = `
    ${C.bright}${providerLabel} Commit Message Helper${C.reset}
    Version: ${packageInfo.version}

    Automatically generates professional commit messages, branch names, and PR descriptions using ${providerLabel} AI.

    ${C.bright}Usage:${C.reset}
      gcm [options]

    ${C.bright}Options:${C.reset}
${options}

    ${C.bright}Provider:${C.reset}
      Choose another provider in interactive Settings, or set ${C.cyan}GCM_PROVIDER${C.reset} before gcm.
      Available values: gemini, openai, freellmapi, lm-studio.
      Example: ${C.cyan}GCM_PROVIDER=lm-studio gcm${C.reset}

    ${C.bright}Examples:${C.reset}
      gcm                                      Generate from staged changes.
      gcm --commit HEAD                        Generate from the latest commit.
      gcm --commit-range 'abc123^..def456' --non-interactive --apply
                                               Generate from abc123 through def456.
                                               The first commit is included because of ^.

    ${C.bright}Commit Safety:${C.reset}
      - Without ${C.cyan}--commit${C.reset} the action commits the staged changes.
      - With ${C.cyan}--commit${C.reset} on an unpublished HEAD the action amends that commit.
      - With ${C.cyan}--commit${C.reset} on any other commit the action adds an 'amend!' commit.
        History stays intact until you run 'git rebase --autosquash' yourself.
      - Amend is never offered for a commit already reachable from a remote branch.
      - Nothing is offered for a commit unreachable from HEAD, on a detached HEAD,
        or while the index has staged changes.
      - All actions are disabled when git has unresolved conflicts.
      - All actions are disabled while merge/rebase/cherry-pick/revert/bisect is in progress.
      - ${C.cyan}--commit-range${C.reset} creates one separate 'amend!' commit per target and never runs rebase.

    `;
  process.stdout.write(helpText.trim() + '\n');
}

export interface RunnerOptions {
  isInteractive?: boolean;
  logger?: Logger;
  gitService?: GitService;
  contextService?: ContextService;
  geminiService?: LanguageModelService;
  languageModelProvider?: LanguageModelProvider;
  languageModelProviderFactories?: Array<{
    id: string;
    label: string;
    create(): Promise<LanguageModelProvider>;
  }>;
  geminiModelLister?: (credential: string) => Promise<string[]>;
}

function createRunnerDialogue(
  logger: Logger,
  provider: LanguageModelProvider,
  providers: Array<{ id: string; label: string }>,
): InteractiveGenerationDialogue {
  return createInteractiveGenerationDialogue({
    prompts: {
      select: async function (options) {
        return select(options);
      },
      text: async function (options) {
        return text(options);
      },
      confirm: async function (options) {
        return confirm(options);
      },
      note,
      outro,
      cancel,
      isCancel,
    },
    clipboard: {
      write: async function (message) {
        await clipboardy.write(message);
      },
    },
    listModels: async function () {
      return provider.listModels();
    },
    fallbackModels: provider.fallbackModels,
    providers,
    logger,
  });
}

function createRunnerServices(
  opts: RunnerOptions,
  logger: Logger,
  provider: LanguageModelProvider,
  providers: Array<{ id: string; label: string }>,
  gitService: GitService,
  allowDirectAmend = true,
): Omit<GenerationServices, 'output'> {
  const contextService =
    opts.contextService ?? createContextService({ summarizeLargeDiff: summarizeRepositoryDiff });
  const dialogue = createRunnerDialogue(logger, provider, providers);
  const commitActions = createCommitActionService({ gitService, logger, allowDirectAmend });
  async function resolveCommitContextHints(files: string[]) {
    return getCommitContextHints(files, await readCommitContextFacts(files));
  }
  return {
    gitService,
    contextService,
    languageModelService: provider.service,
    providerId: provider.id,
    providerLabel: provider.label,
    getModelSpec: provider.getModelSpec,
    dialogue,
    commitActions,
    getCommitContextHints: resolveCommitContextHints,
    saveSession,
  };
}

function createGeminiProvider(
  opts: RunnerOptions,
  logger: Logger,
  debugApi = false,
): LanguageModelProvider {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY ?? '';
  const service: LanguageModelService =
    opts.geminiService ??
    createGeminiService({
      client: createGeminiClient({
        config: { ...CONFIG, DEBUG_API: debugApi || CONFIG.DEBUG_API },
        logger,
      }),
      logger,
      apiKey,
    });
  const listModels = opts.geminiModelLister ?? listGeminiModels;
  return {
    id: 'gemini',
    label: 'Gemini',
    readinessError: apiKey ? undefined : 'Environment variable GOOGLE_GEMINI_API_KEY not set.',
    defaultModel: CONFIG.MODEL,
    fallbackModels: KNOWN_MODELS,
    service,
    listModels: function () {
      if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set.');
      return listModels(apiKey).then(function (models) {
        return models
          .map(model => model.replace(/^models\//, ''))
          .filter(model => model.startsWith('gemini-'))
          .filter(
            model =>
              !/(embedding|image|tts|audio|live|robotics|computer-use|veo|imagen)/i.test(model),
          );
      });
    },
    getModelSpec,
  };
}

function getProviderFactories(opts: RunnerOptions, logger: Logger, debugApi = false) {
  if (opts.languageModelProvider) {
    const provider = opts.languageModelProvider;
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
    opts.languageModelProviderFactories ?? [
      {
        id: 'gemini',
        label: 'Gemini',
        create: async function () {
          return createGeminiProvider(opts, logger, debugApi);
        },
      },
      {
        id: 'openai',
        label: 'OpenAI-FreeLLMAPI',
        create: async function () {
          return createOpenAiProvider({
            baseUrl: process.env.GCM_OPENAI_URL ?? process.env.OPENAI_BASE_URL ?? CONFIG.OPENAI_URL,
            model: process.env.GCM_OPENAI_MODEL ?? process.env.OPENAI_MODEL ?? CONFIG.OPENAI_MODEL,
            token:
              process.env.GCM_OPENAI_TOKEN ?? process.env.OPENAI_API_KEY ?? CONFIG.OPENAI_TOKEN,
            temperature: CONFIG.TEMP,
            maxOutputTokens: CONFIG.MAX_OUTPUT_TOKENS,
          });
        },
      },
      {
        id: 'lm-studio',
        label: 'LM Studio',
        create: async function () {
          return createLmStudioProvider({
            baseUrl: process.env.GCM_LM_STUDIO_URL ?? 'http://127.0.0.1:1234',
            model: process.env.GCM_LM_STUDIO_MODEL,
            token: process.env.LM_API_TOKEN,
            temperature: CONFIG.TEMP,
            maxOutputTokens: CONFIG.MAX_OUTPUT_TOKENS,
          });
        },
      },
    ]
  );
}

function getProviderFactoriesValidationError(
  factories: ReturnType<typeof getProviderFactories>,
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

function createRunnerOutput(
  s: ReturnType<typeof spinner>,
  isInteractive = Boolean(process.stdin.isTTY),
): GenerationServices['output'] {
  return {
    isInteractive,
    startProgress: function (message) {
      s.start(message);
    },
    stopProgress: function (message) {
      s.stop(message);
    },
    cancel,
    note,
    outro,
    sanitizeGeneratedText: sanitizeForDisplay,
    sanitizeTerminalText: function (message) {
      return redactSensitiveText(stripTerminalControlSequences(message));
    },
    style: {
      bright: function (message) {
        return `${C.bright}${message}${C.reset}`;
      },
      cyan: function (message) {
        return `${C.cyan}${message}${C.reset}`;
      },
      cyanBright: function (message) {
        return `${C.cyan}${C.bright}${message}${C.reset}`;
      },
      dim: function (message) {
        return `${C.dim}${message}${C.reset}`;
      },
      magentaBright: function (message) {
        return `${C.magenta}${C.bright}${message}${C.reset}`;
      },
      yellow: function (message) {
        return `${C.yellow}${message}${C.reset}`;
      },
    },
  };
}

async function maybeHandleListModels(
  parsedArgs: ParsedOptions,
  provider: LanguageModelProvider,
): Promise<number | null> {
  if (!parsedArgs.listModels) return null;
  return runListModelsCommand({
    providerLabel: provider.label,
    readinessError: provider.readinessError,
    listModels: function () {
      return provider.listModels();
    },
    output: { cancel, note, outro },
  });
}

function buildLoggerConfig(parsedArgs: ParsedOptions): LoggerConfig {
  const loggerConfig: LoggerConfig = {
    LOG_LEVEL: CONFIG.LOG_LEVEL,
  };
  if (parsedArgs.verbose) loggerConfig.LOG_LEVEL = 'debug';
  return loggerConfig;
}

function parseArgsOrReport(argv: string[]): ParsedOptions | null {
  try {
    return parseArgs(argv);
  } catch (error) {
    if (!isArgumentValidationError(error)) throw error;
    cancel(`Error: ${error.message}. Run gcm --help for usage.`);
    return null;
  }
}

async function runCommitRangeCommand(params: {
  gitService: GitService;
  range: string;
  createServices(): Omit<GenerationServices, 'output'>;
  parsedArgs: ParsedOptions;
  logger: Logger;
  providerReadinessError?: string;
  state: ReturnType<typeof createGenerationState>['state'];
  output: GenerationServices['output'];
}): Promise<'success' | 'failure'> {
  const {
    gitService,
    range,
    createServices,
    parsedArgs,
    logger,
    providerReadinessError,
    state,
    output,
  } = params;
  if (!gitService.listCommitHashes || !gitService.hasAmendment || !gitService.getHeadHash) {
    output.cancel('The configured Git adapter does not support commit ranges.');
    return 'failure';
  }
  const listCommitHashes = gitService.listCommitHashes.bind(gitService);
  const hasAmendment = gitService.hasAmendment.bind(gitService);
  const getHeadHash = gitService.getHeadHash.bind(gitService);
  try {
    const repositoryState = await gitService.getRepositoryState(logger);
    if (
      parsedArgs.apply &&
      (repositoryState.hasStagedChanges ||
        repositoryState.hasUnmergedPaths ||
        repositoryState.inProgressOperation)
    ) {
      output.cancel('Commit range apply requires a clean index with no Git operation in progress.');
      return 'failure';
    }
    const targets = await listCommitHashes(range, logger);
    if (targets.length === 0) {
      output.cancel(`Commit range ${range} contains no commits.`);
      return 'failure';
    }
    const initialHead = await getHeadHash(logger);
    const result = await runCommitBatch({
      targets,
      initialHead,
      getHead: function () {
        return getHeadHash(logger);
      },
      hasAmendment: function (hash) {
        return parsedArgs.apply ? hasAmendment(hash, logger) : Promise.resolve(false);
      },
      runOne: async function (hash) {
        try {
          const outcome = await runGenerationCommand({
            createServices,
            parsedArgs,
            logger,
            providerReadinessError,
            canSwitchProvider: false,
            targetCommit: hash,
            state,
            output,
          });
          return outcome === 'success';
        } catch (error) {
          logger.log('error', `Commit range target failed: ${error}`);
          return false;
        }
      },
      report: function (message) {
        logger.log('info', message);
      },
    });
    const summary = `Commit range: ${result.completed.length} completed, ${result.skipped.length} skipped.`;
    if (result.failed) {
      const failedIndex = targets.indexOf(result.failed);
      const remaining = targets.slice(Math.max(0, failedIndex)).join(', ');
      output.cancel(
        `${summary} Failed at ${result.failed}. Remaining: ${remaining}. No rebase was run.`,
      );
      return 'failure';
    }
    output.outro(`${summary} No rebase was run.`);
    return 'success';
  } catch (error) {
    output.cancel(
      `Commit range failed before completion: ${output.sanitizeTerminalText(String(error))}`,
    );
    return 'failure';
  }
}

export async function executeCommitMessageGeneration(
  argv?: string[],
  dependencies?: RunnerOptions,
): Promise<void> {
  const opts = dependencies ?? {};
  const parsedArgs = parseArgsOrReport(argv ?? process.argv.slice(2));
  const packageInfo = getPackageInfo();
  let exitCode = 0;
  if (parsedArgs) {
    const loggerConfig = buildLoggerConfig(parsedArgs);
    const logger = opts.logger ?? createLogger(loggerConfig);
    const isInteractive = opts.isInteractive ?? Boolean(process.stdin.isTTY);
    if (parsedArgs.version) {
      process.stdout.write(`${packageInfo.name} ${packageInfo.version}\n`);
      process.exitCode = 0;
      return;
    }
    const factories = getProviderFactories(opts, logger, parsedArgs.debug);
    const factoriesError = getProviderFactoriesValidationError(factories);
    if (factoriesError) {
      cancel(`Error: ${factoriesError}.`);
      process.exitCode = 1;
      return;
    }
    const session = await loadSession();
    const gitService = opts.gitService ?? createGitService();
    const environmentProviderId =
      process.env.GCM_PROVIDER === 'freellmapi' ? 'openai' : process.env.GCM_PROVIDER;
    let providerId = opts.languageModelProvider
      ? opts.languageModelProvider.id
      : (environmentProviderId ?? factories[0]?.id);
    if (!providerId || (parsedArgs.model && !isLanguageModelName(parsedArgs.model))) {
      cancel(
        `Error: ${providerId ? 'Invalid model name' : 'No language model provider available'}.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!factories.some(factory => factory.id === providerId)) {
      cancel('Error: Unknown language model provider.');
      process.exitCode = 1;
      return;
    }
    if (parsedArgs.help) {
      const helpFactory = factories.find(factory => factory.id === providerId) ?? factories[0];
      if (!helpFactory) throw new Error('No language model provider available.');
      intro(
        `${C.bright}${helpFactory.label} Commit Message Helper v${packageInfo.version}${C.reset}`,
      );
      showHelp(helpFactory.label);
      process.exitCode = 0;
      return;
    }
    let providerSwitched = false;
    let previousProviderId: string | null = null;
    for (;;) {
      const factory = factories.find(candidate => candidate.id === providerId);
      if (!factory) {
        cancel('Error: Unknown language model provider.');
        exitCode = 1;
        break;
      }
      let provider: LanguageModelProvider;
      try {
        provider = await factory.create();
      } catch (error) {
        const message = redactSensitiveText(stripTerminalControlSequences(String(error)));
        if (previousProviderId) {
          note(message, `${factory.label} unavailable`);
          providerId = previousProviderId;
          previousProviderId = null;
          providerSwitched = false;
          continue;
        }
        if (isInteractive && factories.length > 1) {
          note(message, `${factory.label} unavailable`);
          const selectedProvider = await select({
            message: 'Select AI Provider',
            options: factories.map(candidate => ({ value: candidate.id, label: candidate.label })),
          });
          if (!isCancel(selectedProvider)) {
            providerId = String(selectedProvider);
            providerSwitched = true;
            continue;
          }
        }
        cancel(`Error: ${message}.`);
        exitCode = 1;
        break;
      }
      if (provider.id !== factory.id || provider.label !== factory.label) {
        cancel('Error: Invalid provider factory identity.');
        exitCode = 1;
        break;
      }
      const providerError = getLanguageModelProviderValidationError(provider);
      if (providerError) {
        cancel(`Error: ${providerError}.`);
        exitCode = 1;
        break;
      }
      intro(`${C.bright}${provider.label} Commit Message Helper v${packageInfo.version}${C.reset}`);
      if (provider.selectionNotice) note(provider.selectionNotice, 'Model fallback');
      const earlyExitCode = await maybeHandleListModels(parsedArgs, provider);
      if (earlyExitCode !== null) {
        exitCode = earlyExitCode;
        break;
      }
      const s = spinner();
      const output = createRunnerOutput(s, isInteractive && !parsedArgs.nonInteractive);
      const activeParsedArgs = providerSwitched ? { ...parsedArgs, model: null } : parsedArgs;
      const { targetCommit, state } = createGenerationState(
        activeParsedArgs,
        session,
        provider.defaultModel,
        provider.id,
      );
      if (activeParsedArgs.commitRange) {
        const outcome = await runCommitRangeCommand({
          gitService,
          range: activeParsedArgs.commitRange,
          createServices: function () {
            return createRunnerServices(opts, logger, provider, factories, gitService, false);
          },
          parsedArgs: activeParsedArgs,
          logger,
          providerReadinessError: provider.readinessError,
          state,
          output,
        });
        exitCode = outcome === 'failure' ? 1 : 0;
        break;
      }
      const outcome = await runGenerationCommand({
        createServices: function () {
          return createRunnerServices(opts, logger, provider, factories, gitService);
        },
        parsedArgs: activeParsedArgs,
        logger,
        providerReadinessError: provider.readinessError,
        canSwitchProvider: factories.length > 1 && output.isInteractive,
        targetCommit,
        state,
        output,
      });
      if (typeof outcome === 'object') {
        previousProviderId = providerId;
        providerId = outcome.providerId;
        providerSwitched = true;
        session.outputMode = state.outputMode;
        continue;
      }
      exitCode = outcome === 'failure' ? 1 : 0;
      break;
    }
  } else {
    exitCode = 1;
  }
  process.exitCode = exitCode;
}

export default { executeCommitMessageGeneration };
