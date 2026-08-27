import { CLI_OPTION_DEFINITIONS, isArgumentValidationError, parseArgs } from './cli.js';
import type { ParsedOptions } from './cli.js';
import { CONFIG } from '../gcm.config.js';
import { createLogger } from './logger.js';
import type { Logger, LoggerConfig } from './logger.js';
import { runListModelsCommand } from './list-models-command.js';
import { runListProvidersCommand } from './list-providers-command.js';
import { createGitService } from './services/git-service.js';
import type { GitService } from './services/git-service.js';
import { createCommitActionService } from './commit-action-service.js';
import { getCommitContextHints } from './scope-detector.js';
import { readCommitContextFacts } from './services/repository-context.js';
import { summarizeRepositoryDiff } from './services/repository-summary.js';
import { createContextService } from './services/context-service.js';
import type { ContextService } from './services/context-service.js';
import type { LanguageModelProvider } from './language-model-service.js';
import {
  getLanguageModelProviderValidationError,
  isLanguageModelName,
} from './language-model-service.js';
import {
  createProviderFactories,
  getProviderFactoriesValidationError,
  type ProviderFactoryOptions,
} from './provider-factories.js';
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
  green: '\x1b[32m',
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
      Use ${C.cyan}--provider <name>${C.reset}, choose in interactive Settings, or set ${C.cyan}GCM_PROVIDER${C.reset}.
      Available values: gemini, freellmapi, lm-studio.
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

export interface RunnerOptions extends ProviderFactoryOptions {
  isInteractive?: boolean;
  logger?: Logger;
  gitService?: GitService;
  contextService?: ContextService;
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
    models: function () {
      return provider.models();
    },
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
    models: function () {
      return provider.models();
    },
    dialogue,
    commitActions,
    getCommitContextHints: resolveCommitContextHints,
    saveSession,
  };
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
    models: function () {
      return provider.models();
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
    const factories = createProviderFactories(opts, logger, parsedArgs.debug);
    const factoriesError = getProviderFactoriesValidationError(factories);
    if (factoriesError) {
      cancel(`Error: ${factoriesError}.`);
      process.exitCode = 1;
      return;
    }
    if (parsedArgs.listProviders && !parsedArgs.help) {
      process.exitCode = await runListProvidersCommand({
        factories,
        output: {
          note,
          outro,
          style: process.stdout.isTTY
            ? {
                available: function (message) {
                  return `${C.green}${message}${C.reset}`;
                },
                unavailable: function (message) {
                  return `${C.yellow}${message}${C.reset}`;
                },
              }
            : undefined,
        },
      });
      return;
    }
    const session = await loadSession();
    const gitService = opts.gitService ?? createGitService();
    const requestedProviderId = parsedArgs.provider ?? process.env.GCM_PROVIDER;
    const configuredProviderId = requestedProviderId;
    let providerId = opts.languageModelProvider
      ? opts.languageModelProvider.id
      : (configuredProviderId ?? factories[0]?.id);
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
