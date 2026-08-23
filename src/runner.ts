import { isArgumentValidationError, parseArgs } from './cli.js';
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
import type { GeminiService } from './services/gemini-service.js';
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
import { sanitizeForDisplay, stripTerminalControlSequences } from './utils.js';
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

function showHelp() {
  const packageInfo = getPackageInfo();
  const helpText = `
    ${C.bright}Gemini Commit Message Helper${C.reset}
    Version: ${packageInfo.version}

    Automatically generates professional commit messages, branch names, and PR descriptions using Gemini AI.

    ${C.bright}Usage:${C.reset}
      gcm [options]

    ${C.bright}Options:${C.reset}
      ${C.cyan}-c, --commit <hash>${C.reset}       Analyse a specific commit instead of staged changes.
      ${C.cyan}-h, --help${C.reset}                Show this help message.
      ${C.cyan}--version${C.reset}                 Show package version and exit.
      ${C.cyan}-v, --verbose${C.reset}             Show detailed logs (debug level) in the console.
      ${C.cyan}-d, --debug${C.reset}               Save bounded API traces to '.debug.log' for debugging.
      ${C.cyan}-e, --exclude <pattern>${C.reset}   Exclude files matching pattern (e.g., *manifest*).
                                Can be comma-separated or used multiple times.
      ${C.cyan}-m, --mode <mode>${C.reset}         Output mode: 'full' or 'commit-only'.
      ${C.cyan}--model <name>${C.reset}            Specify an alternative Gemini model to use.
      ${C.cyan}--list-models${C.reset}             List available Gemini models and exit.

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

    `;
  process.stdout.write(helpText.trim() + '\n');
}

export interface RunnerOptions {
  logger?: Logger;
  gitService?: GitService;
  contextService?: ContextService;
  geminiService?: GeminiService;
  listModels?: (apiKey: string) => Promise<string[]>;
}

function createRunnerDialogue(
  logger: Logger,
  listModelsFn: (apiKey: string) => Promise<string[]>,
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
    listModels: listModelsFn,
    logger,
  });
}

function createRunnerServices(
  opts: RunnerOptions,
  logger: Logger,
  apiKey: string,
): Omit<GenerationServices, 'output'> {
  const gitService = opts.gitService ?? createGitService();
  const contextService =
    opts.contextService ?? createContextService({ summarizeLargeDiff: summarizeRepositoryDiff });
  const geminiClient = createGeminiClient({ config: CONFIG, logger });
  const geminiService =
    opts.geminiService ?? createGeminiService({ client: geminiClient, logger, apiKey });
  const listModelsFn = opts.listModels ?? listGeminiModels;
  const dialogue = createRunnerDialogue(logger, listModelsFn);
  const commitActions = createCommitActionService({ gitService, logger });
  async function resolveCommitContextHints(files: string[]) {
    return getCommitContextHints(files, await readCommitContextFacts(files));
  }
  return {
    gitService,
    contextService,
    geminiService,
    dialogue,
    commitActions,
    getCommitContextHints: resolveCommitContextHints,
    saveSession,
  };
}

function createRunnerOutput(s: ReturnType<typeof spinner>): GenerationServices['output'] {
  return {
    isInteractive: Boolean(process.stdin.isTTY),
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
    sanitizeTerminalText: stripTerminalControlSequences,
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
  listModels: (apiKey: string) => Promise<string[]>,
): Promise<number | null> {
  if (!parsedArgs.listModels) return null;
  return runListModelsCommand({
    apiKey: process.env.GOOGLE_GEMINI_API_KEY,
    listModels,
    output: { cancel, note, outro },
  });
}

function buildLoggerConfig(parsedArgs: ParsedOptions): LoggerConfig {
  const loggerConfig: LoggerConfig = {
    LOG_LEVEL: CONFIG.LOG_LEVEL,
  };
  if (parsedArgs.verbose) loggerConfig.LOG_LEVEL = 'debug';
  if (parsedArgs.debug) CONFIG.DEBUG_API = true;
  return loggerConfig;
}

async function handleCliEarlyExit(
  parsedArgs: ParsedOptions,
  packageInfo: PackageInfo,
  listModels: (apiKey: string) => Promise<string[]>,
): Promise<number | null> {
  if (parsedArgs.version) {
    process.stdout.write(`${packageInfo.name} ${packageInfo.version}\n`);
    return 0;
  }
  intro(`${C.bright}Gemini Commit Message Helper v${packageInfo.version}${C.reset}`);
  if (parsedArgs.help) {
    showHelp();
    return 0;
  }
  return maybeHandleListModels(parsedArgs, listModels);
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

export async function executeCommitMessageGeneration(
  argv?: string[],
  dependencies?: RunnerOptions,
): Promise<void> {
  const opts = dependencies ?? {};
  const parsedArgs = parseArgsOrReport(argv ?? process.argv.slice(2));
  const packageInfo = getPackageInfo();
  let exitCode = 0;
  if (parsedArgs) {
    const earlyExitCode = await handleCliEarlyExit(
      parsedArgs,
      packageInfo,
      opts.listModels ?? listGeminiModels,
    );
    if (earlyExitCode === null) {
      const loggerConfig = buildLoggerConfig(parsedArgs);
      const logger = opts.logger ?? createLogger(loggerConfig);
      const s = spinner();
      const output = createRunnerOutput(s);
      const session = await loadSession();
      const { targetCommit, state } = createGenerationState(parsedArgs, session, CONFIG.MODEL);
      const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
      const outcome = await runGenerationCommand({
        createServices: function () {
          return createRunnerServices(opts, logger, apiKey ?? '');
        },
        parsedArgs,
        logger,
        apiKey,
        targetCommit,
        state,
        output,
      });
      exitCode = outcome === 'failure' ? 1 : 0;
    } else {
      exitCode = earlyExitCode;
    }
  } else {
    exitCode = 1;
  }
  process.exitCode = exitCode;
}

export default { executeCommitMessageGeneration };
