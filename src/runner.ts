import { parseArgs } from './cli.js';
import type { ParsedOptions } from './cli.js';
import { CONFIG } from '../gcm.config.js';
import { createLogger } from './logger.js';
import type { Logger, LoggerConfig, LogMetadata } from './logger.js';
import { createGeminiClient } from './gemini-client.js';
import { parseGeminiOutput } from './parser.js';
import type { Labels } from './parser.js';
import { getScopeSuggestions } from './scope-detector.js';
import { listGeminiModels } from './gemini-client/listModels.js';
import { createGitService } from './services/git-service.js';
import type { GitService } from './services/git-service.js';
import { createContextService } from './services/context-service.js';
import type { ContextService } from './services/context-service.js';
import { createGeminiService } from './services/gemini-service.js';
import type { GeminiService } from './services/gemini-service.js';
import { generateFallbackCommitDetails } from './runner-utils.js';
import { loadSession, saveSession } from './session.js';
import { intro, outro, spinner, note, select, text, isCancel, cancel } from '@clack/prompts';
import { KNOWN_MODELS, getModelSpec } from './model-registry.js';
import { sanitizeForDisplay } from './utils.js';
import clipboardy from 'clipboardy';
import { readFileSync } from 'node:fs';

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

interface RunnerServices {
  logger: Logger;
  gitService: GitService;
  contextService: ContextService;
  geminiService: GeminiService;
  listModelsFn: (apiKey: string) => Promise<string[]>;
}

interface GenerationState {
  modelName: string;
  outputMode: 'full' | 'commit-only';
  userHint?: string;
}

interface ActionMenuResult {
  type: 'commit' | 'regenerate' | 'cancel';
  modelName: string;
  userHint?: string;
}

function getPackageInfo(): PackageInfo {
  try {
    const packageJsonPath = new URL('../package.json', import.meta.url);
    const packageRaw = readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageRaw) as { name?: string; version?: string };
    return {
      name: packageJson.name || 'gcm',
      version: packageJson.version || 'unknown',
    };
  } catch {
    return { name: 'gcm', version: 'unknown' };
  }
}

export function showHelp() {
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
      ${C.cyan}-d, --debug${C.reset}               Save complete logs to a '.debug.log' file for debugging.
      ${C.cyan}-e, --exclude <pattern>${C.reset}   Exclude files matching pattern (e.g., *manifest*).
                                Can be comma-separated or used multiple times.
      ${C.cyan}--model <name>${C.reset}            Specify an alternative Gemini model to use.
      ${C.cyan}--list-models${C.reset}             List available Gemini models and exit.

    `;
  console.log(helpText.trim());
}

export function displayResultStructured(logger: Logger, res: Labels): void {
  const branchText = `\n${C.cyan}${C.bright}BRANCH:${C.reset}\n${res.BRANCH || ''}\n`;
  const commitText = `\n${C.cyan}${C.bright}COMMIT_MESSAGE:${C.reset}\n${res.COMMIT_MESSAGE || ''}\n`;
  const titleText = `\n${C.magenta}${C.bright}PR_TITLE:${C.reset}\n${res.PR_TITLE || ''}\n`;
  const descText = `\n${C.magenta}${C.bright}PR_DESCRIPTION:${C.reset}\n${res.PR_DESCRIPTION || ''}\n`;
  logger.log('info', `${branchText}${commitText}${titleText}${descText}`);
}

function reportStats(
  logger: Logger,
  modelName: string,
  usage: { promptTokens?: number; outputTokens?: number; thinkingTokens?: number } = {},
  outputLength: number,
): void {
  let thinking = '';
  if (usage.thinkingTokens) thinking = ` | thinking: ${usage.thinkingTokens}`;
  logger.log(
    'info',
    `${C.dim}${modelName} | actual usage -> input: ${usage.promptTokens || 0} tokens | output: ${
      usage.outputTokens || 0
    } tokens (${outputLength.toLocaleString()} chars)${thinking}${C.reset}\n`,
  );
}

function detectRuntime(): string {
  return 'bun';
}

const SYSTEM_INSTRUCTIONS_FULL = `You are an expert at writing concise, professional conventional commit messages.\n\nOutput format (follow exactly):\n\nBRANCH: [Generated branch name]\nCOMMIT_MESSAGE: [Generated conventional commit message]\nPR_TITLE: [Generated pull request title]\nPR_DESCRIPTION: [Generated pull request description]\n\n--- RULES ---\n1. **Branch Name**: Format: \`type/short-description\`, Types: feat, fix, refactor, chore, docs\n2. **Commit Message** (MOST IMPORTANT): CRITICAL: First line MUST be ≤60 characters (type(scope): summary), BLANK LINE after first line, Body: Use bullet points with dash (-), EACH LINE MUST be ≤80 characters maximum, Focus on WHAT changed not WHY, Group related changes, Be specific and concise, If breaking change add BREAKING CHANGE: footer. Your response will be automatically formatted to enforce these limits.\n3. **PR Title**: Same as commit first line, Max 60 characters\n4. **PR Description**: 2-3 paragraphs maximum, Bulleted list of key changes, Use GitHub-flavored Markdown`;

const SYSTEM_INSTRUCTIONS_COMMIT_ONLY = `You are an expert at writing concise, professional conventional commit messages. Use GitHub-flavored Markdown as required format.\n\nOutput format (follow exactly):\n\n[Generated conventional commit message]\n\n--- RULES ---\n1. **Commit Message** (MOST IMPORTANT): CRITICAL: First line MUST be ≤60 characters (type(scope): summary), BLANK LINE after first line, Body: Use bullet points with dash (-), EACH LINE MUST be ≤80 characters maximum, Focus on WHAT changed not WHY, Group related changes, Be specific and concise, If breaking change add BREAKING CHANGE: footer. Your response will be automatically formatted to enforce these limits.`;

function logTokenInfo(
  modelName: string,
  tokens: number,
  inputLength: number,
  enableThinking: boolean,
  logger: Logger,
): void {
  if (enableThinking) {
    logger.log(
      'info',
      `model: ${modelName} (thinking) | estimated input: ~${tokens} tokens | length: ${inputLength}`,
    );
    return;
  }
  logger.log(
    'info',
    `model: ${modelName} | estimated input: ~${tokens} tokens | length: ${inputLength}`,
  );
}

export interface RunnerOptions {
  logger?: Logger;
  gitService?: GitService;
  contextService?: ContextService;
  geminiService?: GeminiService;
  listModels?: (apiKey: string) => Promise<string[]>;
}

function toModelOption(name: string): { value: string; label: string; hint?: string } {
  const normalizedName = name.replace(/^models\//, '');
  const knownModel = KNOWN_MODELS.find(function (model) {
    return model.name === normalizedName;
  });

  if (knownModel) {
    return {
      value: knownModel.name,
      label: knownModel.label,
      hint: knownModel.description,
    };
  }

  return {
    value: normalizedName,
    label: normalizedName,
    hint: 'Available from Gemini API',
  };
}

function isSelectableTextModel(name: string): boolean {
  return !/(embedding|image|tts|audio|live|robotics|computer-use|veo|imagen)/i.test(name);
}

async function getModelSelectionOptions(
  apiKey: string,
  logger: Logger,
  listModelsFn: (apiKey: string) => Promise<string[]>,
): Promise<Array<{ value: string; label: string; hint?: string }>> {
  try {
    const apiModels = await listModelsFn(apiKey);
    const uniqueModels = [
      ...new Set(
        apiModels.map(function (name) {
          return name.replace(/^models\//, '');
        }),
      ),
    ]
      .filter(function (name) {
        return name.startsWith('gemini-');
      })
      .filter(isSelectableTextModel);

    if (uniqueModels.length > 0) {
      return uniqueModels.map(toModelOption);
    }
  } catch (error) {
    logger.log('debug', 'Failed to load live Gemini model list; falling back to known models', {
      error: String(error),
    });
  }

  return KNOWN_MODELS.map(function (model) {
    return {
      value: model.name,
      label: model.label,
      hint: model.description,
    };
  });
}

async function runPreflightIfNeeded(
  parsedArgs: ParsedOptions,
  state: GenerationState,
  apiKey: string,
  logger: Logger,
  listModelsFn: (apiKey: string) => Promise<string[]>,
): Promise<'continue' | 'exit'> {
  if (parsedArgs.model || parsedArgs.mode) return 'continue';

  for (;;) {
    const modeLabel = state.outputMode === 'full' ? 'Full Report' : 'Commit Msg Only';
    const action = await select({
      message: `Settings: [Model: ${state.modelName}] [Mode: ${modeLabel}]`,
      options: [
        { value: 'generate', label: 'Generate' },
        { value: 'configure', label: 'Configure...' },
        { value: 'exit', label: 'Exit' },
      ],
    });

    if (isCancel(action) || action === 'exit') {
      outro('Bye!');
      return 'exit';
    }

    if (action !== 'configure') return 'continue';

    const configAction = await select({
      message: 'Configure Settings',
      options: [
        { value: 'model', label: `Change Model (Current: ${state.modelName})` },
        { value: 'mode', label: `Change Mode (Current: ${state.outputMode})` },
        { value: 'back', label: 'Back' },
      ],
    });

    if (configAction === 'model') {
      const modelOptions = await getModelSelectionOptions(apiKey, logger, listModelsFn);
      const selectedModel = await select({
        message: 'Select AI Model',
        options: modelOptions,
      });
      if (!isCancel(selectedModel)) state.modelName = String(selectedModel);
    } else if (configAction === 'mode') {
      const selectedMode = await select({
        message: 'Select Output Mode',
        options: [
          {
            value: 'commit-only',
            label: 'Commit Message Only (Default)',
            hint: 'Faster, concise',
          },
          { value: 'full', label: 'Full Report (Branch, PR)', hint: 'Detailed' },
        ],
      });
      if (!isCancel(selectedMode)) state.outputMode = selectedMode as 'full' | 'commit-only';
    }
  }
}

function buildNoteContent(outputMode: 'full' | 'commit-only', parsedOut: Labels): string {
  if (outputMode === 'commit-only') return parsedOut.COMMIT_MESSAGE;

  return [
    `${C.cyan}${C.bright}BRANCH:${C.reset} ${parsedOut.BRANCH || 'N/A'}`,
    `${C.cyan}${C.bright}PR_TITLE:${C.reset} ${parsedOut.PR_TITLE || 'N/A'}`,
    '',
    `${C.bright}COMMIT MESSAGE:${C.reset}`,
    parsedOut.COMMIT_MESSAGE,
    '',
    `${C.magenta}${C.bright}PR DESCRIPTION:${C.reset}`,
    parsedOut.PR_DESCRIPTION || 'N/A',
  ].join('\n');
}

function parseAndSanitizeResponse(
  responseText: string,
  outputMode: 'full' | 'commit-only',
  logger: Logger,
): Labels | null {
  try {
    const rawParsed = parseGeminiOutput(responseText, outputMode);
    return {
      BRANCH: sanitizeForDisplay(rawParsed.BRANCH),
      COMMIT_MESSAGE: sanitizeForDisplay(rawParsed.COMMIT_MESSAGE),
      PR_TITLE: sanitizeForDisplay(rawParsed.PR_TITLE),
      PR_DESCRIPTION: sanitizeForDisplay(rawParsed.PR_DESCRIPTION),
    };
  } catch (error) {
    logger.log('error', `Parse failed: ${error}`);
    return null;
  }
}

async function runActionMenu(
  state: GenerationState,
  parsedOut: Labels,
  apiKey: string,
  logger: Logger,
  listModelsFn: (apiKey: string) => Promise<string[]>,
): Promise<ActionMenuResult> {
  let finalMessage = parsedOut.COMMIT_MESSAGE;

  for (;;) {
    const action = await select({
      message: 'What would you like to do?',
      options: [
        { value: 'commit', label: 'Commit' },
        { value: 'copy', label: 'Copy to clipboard' },
        { value: 'edit', label: 'Edit message' },
        { value: 'regenerate', label: 'Regenerate (same model)' },
        { value: 'regenerate-hint', label: 'Regenerate with Hint...' },
        { value: 'switch', label: 'Switch Model & Regenerate' },
        { value: 'cancel', label: 'Cancel' },
      ],
    });

    if (isCancel(action) || action === 'cancel') {
      outro('Commit cancelled.');
      return { type: 'cancel', modelName: state.modelName, userHint: state.userHint };
    }

    if (action === 'copy') {
      try {
        await clipboardy.write(finalMessage);
        note('Commit message copied to clipboard!', 'Success');
      } catch (error) {
        note(`Failed to copy to clipboard: ${error}`, 'Error');
      }
      continue;
    }

    if (action === 'edit') {
      const edited = await text({
        message: 'Edit commit message',
        initialValue: finalMessage,
        placeholder: 'Enter commit message',
      });
      if (!isCancel(edited)) {
        finalMessage = String(edited);
        note(finalMessage, 'Updated Commit Message');
      }
      continue;
    }

    if (action === 'regenerate') {
      return { type: 'regenerate', modelName: state.modelName, userHint: undefined };
    }

    if (action === 'regenerate-hint') {
      const hint = await text({
        message: 'Enter hint for regeneration (e.g. "emphasize refactoring")',
        placeholder: 'Add instructions...',
      });
      if (!isCancel(hint)) {
        return { type: 'regenerate', modelName: state.modelName, userHint: String(hint) };
      }
      continue;
    }

    if (action === 'switch') {
      const modelOptions = await getModelSelectionOptions(apiKey, logger, listModelsFn);
      const selectedModel = await select({
        message: 'Select AI Model for Regeneration',
        options: modelOptions,
      });
      if (!isCancel(selectedModel)) {
        return { type: 'regenerate', modelName: String(selectedModel), userHint: undefined };
      }
      continue;
    }

    if (action === 'commit') {
      parsedOut.COMMIT_MESSAGE = finalMessage;
      return { type: 'commit', modelName: state.modelName, userHint: state.userHint };
    }
  }
}

function createRunnerServices(opts: RunnerOptions, logger: Logger, apiKey: string): RunnerServices {
  const gitService = opts.gitService || createGitService();
  const contextService = opts.contextService || createContextService();
  const geminiClient = createGeminiClient({ config: CONFIG, logger });
  const geminiService =
    opts.geminiService || createGeminiService({ client: geminiClient, logger, apiKey });
  const listModelsFn = opts.listModels || listGeminiModels;
  return { logger, gitService, contextService, geminiService, listModelsFn };
}

async function maybeHandleListModels(parsedArgs: ParsedOptions): Promise<number | null> {
  if (!parsedArgs.listModels) return null;

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    cancel('Error: GOOGLE_GEMINI_API_KEY is not set.');
    return 1;
  }
  try {
    const models = await listGeminiModels(apiKey);
    let modelList = 'Available Gemini models:\n';
    for (const modelName of models) modelList += `  - ${modelName}\n`;
    note(modelList);
    outro('Done.');
  } catch (error) {
    cancel(`Failed to fetch models: ${error}`);
    return 2;
  }

  return 0;
}

export async function executeCommitMessageGeneration(
  argv?: string[],
  dependencies?: RunnerOptions,
): Promise<void> {
  const opts = dependencies || {};
  const parsedArgs: ParsedOptions = parseArgs(argv || process.argv.slice(2));
  const packageInfo = getPackageInfo();

  if (parsedArgs.version) {
    console.log(`${packageInfo.name} ${packageInfo.version}`);
    return;
  }

  intro(`${C.bright}Gemini Commit Message Helper v${packageInfo.version}${C.reset}`);

  if (parsedArgs.help) {
    showHelp();
    return;
  }

  const listModelsExitCode = await maybeHandleListModels(parsedArgs);
  if (listModelsExitCode !== null) {
    process.exitCode = listModelsExitCode;
    return;
  }

  const loggerConfig: LoggerConfig = {
    LOG_LEVEL: CONFIG.LOG_LEVEL,
    TELEMETRY_FILE: CONFIG.TELEMETRY_FILE,
  };
  if (parsedArgs.verbose) loggerConfig.LOG_LEVEL = 'debug';
  if (parsedArgs.debug) CONFIG.DEBUG_API = true;

  const logger = opts.logger || createLogger(loggerConfig);
  const s = spinner();

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    cancel('Error: Environment variable GOOGLE_GEMINI_API_KEY not set.');
    return;
  }

  const targetCommit = parsedArgs.commit || null;
  const session = await loadSession();
  const state: GenerationState = {
    modelName: parsedArgs.model || session.modelName || CONFIG.MODEL_NAME,
    outputMode: parsedArgs.mode || session.outputMode || 'commit-only',
    userHint: undefined,
  };

  try {
    const services = createRunnerServices(opts, logger, apiKey);

    if (targetCommit) {
      logger.log('info', `${C.dim}Using commit ${targetCommit} for analysis${C.reset}`);
    }

    if (
      (await runPreflightIfNeeded(parsedArgs, state, apiKey, logger, services.listModelsFn)) ===
      'exit'
    ) {
      return;
    }

    s.start('Analyzing repository changes...');
    const staged = await services.gitService.retrieveStagedChanges(
      targetCommit,
      logger,
      parsedArgs.exclude,
    );
    if (!staged) {
      s.stop('No changes found');
      cancel('No staged changes found. Use "git add" to stage files.');
      return;
    }
    s.stop(`Found ${staged.stagedFiles.length} file(s) changed`);

    const meta: LogMetadata = {
      targetCommit: targetCommit || null,
      numFiles: staged.stagedFiles.length,
      origLen: staged.stagedDiff.length,
      truncated: staged.truncated,
    };

    let scopeSuggestions: string[] = [];
    try {
      scopeSuggestions = await getScopeSuggestions(staged.stagedFiles);
    } catch (error) {
      logger.log('debug', 'Failed to get scope suggestions', { error: String(error) });
    }

    for (;;) {
      const modelSpec = getModelSpec(state.modelName);
      const safeMaxTokens = modelSpec.maxInputTokens - CONFIG.MAX_OUTPUT_TOKENS - 1000;
      const customHeader =
        state.outputMode === 'full'
          ? 'Generate a branch name, pull request title, pull request description, and a conventional commit message based on the following'
          : 'Generate a professional conventional commit message based on the following';

      const contextResult = await services.contextService.constructLLMPromptContext(
        staged.stagedDiff,
        staged.truncated ? 'truncated diff' : 'diff',
        safeMaxTokens,
        CONFIG.TOKEN_BYTES_RATIO,
        staged.stagedFiles,
        scopeSuggestions,
        logger,
        customHeader,
        state.userHint,
      );

      const runtime = detectRuntime();
      logTokenInfo(
        state.modelName,
        contextResult.tokens,
        contextResult.processedDiffContent.length,
        CONFIG.ENABLE_THINKING,
        logger,
      );
      logger.log('debug', 'Run started', { targetCommit: targetCommit ?? null, runtime });

      s.start(`Generating commit message with ${state.modelName}...`);
      const systemPrompt =
        state.outputMode === 'full' ? SYSTEM_INSTRUCTIONS_FULL : SYSTEM_INSTRUCTIONS_COMMIT_ONLY;

      const response = await services.geminiService.callGeminiAPI(
        contextResult.promptContext,
        systemPrompt,
        staged.stagedFiles,
        meta,
        {
          modelOverride: state.modelName,
          retryIfTruncated: true,
          retryIfTruncatedMaxRetries: 1,
          retryIfTruncatedIncreaseTokens: CONFIG.MAX_OUTPUT_TOKENS,
        },
      );
      s.stop('Gemini response received');

      if (!response) {
        logger.log(
          'warn',
          'Gemini did not return text after retries; using deterministic fallback',
        );
        displayResultStructured(logger, generateFallbackCommitDetails(staged.stagedFiles));
        return;
      }

      logger.log('debug', 'LLM response received', {
        promptTokens: response.usage.promptTokens,
        outputTokens: response.usage.outputTokens,
        ...meta,
      });

      const parsedOut = parseAndSanitizeResponse(response.text, state.outputMode, logger);
      if (!parsedOut) {
        logger.log('info', response.text);
        outro('Failed to parse structured output.');
        return;
      }

      const warningIcon = response.truncated ? ` ${C.yellow}[⚠ ZKRACENO]${C.reset}` : '';
      const noteContent = buildNoteContent(state.outputMode, parsedOut);
      note(
        noteContent,
        (state.outputMode === 'full' ? 'Generated Report' : 'Generated Commit Message') +
          warningIcon,
      );
      reportStats(logger, state.modelName, response.usage, response.text.length);

      const actionResult = await runActionMenu(
        state,
        parsedOut,
        apiKey,
        logger,
        services.listModelsFn,
      );
      if (actionResult.type === 'cancel') return;

      state.modelName = actionResult.modelName;
      state.userHint = actionResult.userHint;

      if (actionResult.type === 'regenerate') {
        continue;
      }

      s.start('Committing changes...');
      try {
        await services.gitService.commitChanges(parsedOut.COMMIT_MESSAGE, logger);
        await saveSession({ modelName: state.modelName, outputMode: state.outputMode });
        s.stop('Changes committed successfully');
        outro(`${C.cyan}Commit successfully created!${C.reset}`);
      } catch (error) {
        s.stop('Commit failed');
        cancel(`Failed to commit changes: ${error}`);
        logger.log('error', `Commit failed: ${error}`);
      }
      return;
    }
  } catch (error: unknown) {
    s.stop('An error occurred');
    const errStr = String(error);
    if (/Not a git repository/i.test(errStr)) {
      cancel('Error: Not inside a git repository.');
    } else if (/unknown revision/i.test(errStr)) {
      cancel(`Error: Invalid commit SHA: ${targetCommit}`);
    } else {
      logger.log('error', `Gemini commit helper failed: ${error}`, { error: errStr });
      cancel(`An unexpected error occurred: ${errStr}`);
    }
    throw error;
  }
}

export default { executeCommitMessageGeneration };
