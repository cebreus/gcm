import { CLI_OPTION_DEFINITIONS, isArgumentValidationError, parseArgs } from './cli.js';
import type { ParsedOptions } from './cli.js';
import { loadConfig, type Config } from '../gcm.config.js';
import { createLogger } from './logger.js';
import type { Logger, LoggerConfig } from './logger.js';
import { runModelsListCommand } from './models-list-command.js';
import { runProvidersListCommand } from './providers-list-command.js';
import { createGitService } from './services/git-service.js';
import type { GitService } from './services/git-service.js';
import { createCommitActionService } from './commit-action-service.js';
import { getCommitContextHints } from './scope-detector.js';
import { readCommitContextFacts } from './services/repository-context.js';
import { summarizeRepositoryDiff } from './services/repository-summary.js';
import { createContextService } from './services/context-service.js';
import type { ContextService } from './services/context-service.js';
import { loadProjectConfig } from './services/project-config-service.js';
import type { ProjectConfig } from './project-config.js';
import type { LanguageModelProvider } from './language-model-service.js';
import { isLanguageModelName } from './language-model-service.js';
import { createProviderFactories, type ProviderFactoryOptions } from './provider-factories.js';
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
import { sanitizeForDisplay, sanitizeTerminalText } from './utils.js';
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

function reportCancel(message: string): void {
  cancel(message, { output: process.stderr });
}

function paint(code: string): (message: string) => string {
  return message => `${code}${message}${C.reset}`;
}

const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};

function showHelp(providerLabel: string, providerIds: string[]) {
  const optionWidth = Math.max(...CLI_OPTION_DEFINITIONS.map(option => option.usage.length));
  const descriptionLine = new RegExp(`.{1,${80 - optionWidth - 8}}(?:\\s|$)`, 'g');
  const options = CLI_OPTION_DEFINITIONS.map(option => {
    const description = option.description.replaceAll('{provider}', providerLabel);
    const [first, ...rest] = (description.match(descriptionLine) ?? [description]).map(line =>
      line.trim(),
    );
    return [
      `      ${C.cyan}${option.usage.padEnd(optionWidth)}${C.reset}  ${first}`,
      ...rest.map(line => ' '.repeat(optionWidth + 8) + line),
    ].join('\n');
  }).join('\n');
  const helpText = `
    ${C.bright}${providerLabel} Commit Message Helper${C.reset}
    Version: ${pkg.version}

    Automatically generates professional Conventional Commit messages
    using ${providerLabel} AI.

    ${C.bright}Usage:${C.reset}
      gcm [options]

    ${C.bright}Options:${C.reset}
${options}

    ${C.bright}Provider:${C.reset}
      Use ${C.cyan}--provider <name>${C.reset}, choose in interactive Settings,
      or set ${C.cyan}GCM_PROVIDER${C.reset}.
      Available values: ${providerIds.join(', ')}.
      Example: ${C.cyan}GCM_PROVIDER=lm-studio gcm${C.reset}

    ${C.bright}Examples:${C.reset}
      ${C.cyan}gcm${C.reset}                                      Generate from staged changes.
      ${C.cyan}gcm --commit HEAD${C.reset}                        Generate from the latest commit.
      ${C.cyan}gcm --commit-range 'abc123^..def456' --non-interactive --apply${C.reset}
        Generate from abc123 through def456; ^ includes abc123.

    ${C.bright}Commit Safety:${C.reset}
      - Without ${C.cyan}--commit${C.reset} the action commits the staged changes.
      - With ${C.cyan}--commit${C.reset} on an unpublished HEAD the action amends that commit.
      - With ${C.cyan}--commit${C.reset} on any other commit the action adds an 'amend!' commit.
        History stays intact until you run 'git rebase --autosquash' yourself.
      - Amend is never offered for a commit already reachable from
        a remote branch.
      - Nothing is offered for a commit unreachable from HEAD,
        on a detached HEAD, or while the index has staged changes.
      - All actions are disabled when git has unresolved conflicts.
      - All actions are disabled while merge/rebase/cherry-pick/revert/bisect
        is in progress.
      - ${C.cyan}--commit-range${C.reset} creates one separate 'amend!' commit per target
        and never runs rebase.

    `;
  process.stdout.write(helpText.trim() + '\n');
}

const providerModelEnv: Record<string, string | undefined> = {
  gemini: 'GCM_MODEL',
  freellmapi: 'GCM_FREELLMAPI_MODEL',
  'lm-studio': 'GCM_LM_STUDIO_MODEL',
};

function configuredModelFor(providerId: string): string | undefined {
  const name = providerModelEnv[providerId];
  const value = name ? process.env[name] : undefined;
  return value === '' ? undefined : value;
}

export interface RunnerOptions extends ProviderFactoryOptions {
  isInteractive?: boolean;
  logger?: Logger;
  gitService?: GitService;
  contextService?: ContextService;
}

function createRunnerDialogue(
  provider: LanguageModelProvider,
  providers: Array<{ id: string; label: string }>,
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
      write: async message => {
        await clipboardy.write(message);
      },
    },
    models: () => provider.models(),
    providers,
  });
}

function createRunnerServices(
  opts: RunnerOptions,
  logger: Logger,
  provider: LanguageModelProvider,
  providers: Array<{ id: string; label: string }>,
  gitService: GitService,
  allowDirectAmend: boolean,
  config: Config,
  projectConfig: ProjectConfig,
): Omit<GenerationServices, 'output'> {
  const contextService =
    opts.contextService ??
    createContextService({
      summarizeLargeDiff: (files, options) => summarizeRepositoryDiff(files, options, config),
    });
  const dialogue = createRunnerDialogue(provider, providers);
  const commitActions = createCommitActionService({ gitService, logger, allowDirectAmend });
  async function resolveCommitContextHints(files: string[]) {
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
    models: () => provider.models(),
    dialogue,
    commitActions,
    getCommitContextHints: resolveCommitContextHints,
    saveSession,
  };
}

function createRunnerOutput(
  s: ReturnType<typeof spinner>,
  isInteractive: boolean,
  printOnly: boolean,
): GenerationServices['output'] {
  return {
    isInteractive,
    startProgress: message => {
      if (printOnly) return;
      s.start(message);
    },
    stopProgress: message => {
      if (printOnly) return;
      s.stop(message);
    },
    cancel: reportCancel,
    note: (message, title) => {
      if (!printOnly) note(message, title);
    },
    outro: message => {
      if (!printOnly) outro(message);
    },
    print: message => process.stdout.write(message + '\n'),
    sanitizeGeneratedText: sanitizeForDisplay,
    sanitizeTerminalText,
    style: {
      cyan: paint(C.cyan),
      dim: paint(C.dim),
      yellow: paint(C.yellow),
    },
  };
}

async function maybeHandleModelsList(
  parsedArgs: ParsedOptions,
  provider: LanguageModelProvider,
): Promise<number | null> {
  if (!parsedArgs.modelsList) return null;
  return runModelsListCommand({
    providerLabel: provider.label,
    readinessError: provider.readinessError,
    models: () => provider.models(),
    output: { cancel: reportCancel, note, outro },
  });
}

function buildLoggerConfig(parsedArgs: ParsedOptions, config: Config): LoggerConfig {
  const loggerConfig: LoggerConfig = {
    LOG_LEVEL: config.LOG_LEVEL,
    LOG_TO_STDERR: parsedArgs.print,
  };
  if (parsedArgs.verbose || parsedArgs.debug || config.DEBUG_API) loggerConfig.LOG_LEVEL = 'debug';
  return loggerConfig;
}

function parseArgsOrReport(argv: string[]): ParsedOptions | null {
  try {
    return parseArgs(argv);
  } catch (error) {
    if (!isArgumentValidationError(error)) throw error;
    const message = `Error: ${error.message}. Run gcm --help for usage.`;
    reportCancel(message);
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
    const targets = await gitService.listCommitHashes(range, logger);
    if (targets.length === 0) {
      output.cancel(`Commit range ${range} contains no commits.`);
      return 'failure';
    }
    const initialHead = await gitService.getHeadHash(logger);
    const result = await runCommitBatch({
      targets,
      initialHead,
      getHead: () => gitService.getHeadHash(logger),
      hasAmendment: hash =>
        parsedArgs.apply ? gitService.hasAmendment(hash, logger) : Promise.resolve(false),
      runOne: async hash => {
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
      report: message => {
        logger.log('info', message);
      },
    });
    const summary = `Commit range: ${result.completed.length} completed, ${result.skipped.length} skipped.`;
    if (result.failed) {
      const failedIndex = targets.indexOf(result.failed);
      const remaining = targets.slice(failedIndex).join(', ');
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
  let exitCode = 0;
  if (parsedArgs) {
    if (parsedArgs.version) {
      process.stdout.write(`${pkg.name} ${pkg.version}\n`);
      process.exitCode = 0;
      return;
    }
    let config: Config;
    try {
      config = loadConfig(process.env);
    } catch (error) {
      if (!parsedArgs.help) throw error;
      config = loadConfig({}); // --help stays usable; provider text falls back to defaults
    }
    const loggerConfig = buildLoggerConfig(parsedArgs, config);
    const logger = opts.logger ?? createLogger(loggerConfig);
    const isInteractive = opts.isInteractive ?? Boolean(process.stdin.isTTY);
    const printOutput = parsedArgs.print ? { output: process.stderr } : undefined;
    // Checked before any provider is built, because GCM_MODEL becomes a
    // provider's default model and would otherwise surface as "unavailable".
    // --help never resolves a model, so it stays usable.
    if (!parsedArgs.help && !isLanguageModelName(config.MODEL)) {
      reportCancel('Error: Invalid GCM_MODEL.');
      process.exitCode = 1;
      return;
    }
    const factories = createProviderFactories(opts, logger, parsedArgs.debug, config);
    if (parsedArgs.providersList && !parsedArgs.help) {
      process.exitCode = await runProvidersListCommand({
        factories,
        output: {
          note,
          outro,
          style: process.stdout.isTTY
            ? {
                available: message => `${C.green}${message}${C.reset}`,
                unavailable: message => `${C.yellow}${message}${C.reset}`,
              }
            : undefined,
        },
      });
      return;
    }
    const session = await loadSession();
    const gitService =
      opts.gitService ?? createGitService({ maxBytes: config.CHILD_PROCESS_MAX_BUFFER });
    const requestedProviderId = parsedArgs.provider ?? config.PROVIDER;
    let providerId = opts.languageModelProvider
      ? opts.languageModelProvider.id
      : (requestedProviderId ?? factories[0]?.id);
    if (!providerId || (parsedArgs.model && !isLanguageModelName(parsedArgs.model))) {
      reportCancel(
        `Error: ${providerId ? 'Invalid model name' : 'No language model provider available'}.`,
      );
      process.exitCode = 1;
      return;
    }
    const helpFactory =
      factories.find(factory => factory.id === providerId) ??
      (parsedArgs.help ? factories[0] : undefined);
    if (!helpFactory) {
      reportCancel('Error: Unknown language model provider.');
      process.exitCode = 1;
      return;
    }
    if (parsedArgs.help) {
      intro(`${C.bright}${helpFactory.label} Commit Message Helper v${pkg.version}${C.reset}`);
      showHelp(
        helpFactory.label,
        factories.map(factory => factory.id),
      );
      process.exitCode = 0;
      return;
    }
    let providerSwitched = false;
    let previousProviderId: string | null = null;
    for (;;) {
      const factory = factories.find(candidate => candidate.id === providerId);
      if (!factory) {
        reportCancel('Error: Unknown language model provider.');
        exitCode = 1;
        break;
      }
      let provider: LanguageModelProvider;
      try {
        provider = await factory.create();
      } catch (error) {
        const message = sanitizeTerminalText(String(error));
        if (previousProviderId) {
          note(message, `${factory.label} unavailable`);
          providerId = previousProviderId;
          previousProviderId = null;
          providerSwitched = false;
          continue;
        }
        if (isInteractive && !parsedArgs.nonInteractive && factories.length > 1) {
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
        reportCancel(`Error: ${message}.`);
        exitCode = 1;
        break;
      }
      if (!parsedArgs.print)
        intro(`${C.bright}${provider.label} Commit Message Helper v${pkg.version}${C.reset}`);
      const earlyExitCode = await maybeHandleModelsList(parsedArgs, provider);
      if (earlyExitCode !== null) {
        exitCode = earlyExitCode;
        break;
      }
      let projectConfig: ProjectConfig;
      try {
        projectConfig = await loadProjectConfig();
      } catch (error) {
        reportCancel(
          `Error: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
        );
        exitCode = 1;
        break;
      }
      const s = spinner(printOutput);
      const output = createRunnerOutput(
        s,
        isInteractive && !parsedArgs.nonInteractive,
        parsedArgs.print,
      );
      const activeParsedArgs = providerSwitched ? { ...parsedArgs, model: null } : parsedArgs;
      const { targetCommit, state } = createGenerationState(
        activeParsedArgs,
        session,
        provider.defaultModel,
        provider.id,
        configuredModelFor(provider.id),
      );
      if (activeParsedArgs.commitRange) {
        const outcome = await runCommitRangeCommand({
          gitService,
          range: activeParsedArgs.commitRange,
          createServices: () =>
            createRunnerServices(
              opts,
              logger,
              provider,
              factories,
              gitService,
              false,
              config,
              projectConfig,
            ),
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
        createServices: () =>
          createRunnerServices(
            opts,
            logger,
            provider,
            factories,
            gitService,
            true,
            config,
            projectConfig,
          ),
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
