import { parseArgs } from './cli.js';
import type { ParsedOptions } from './cli.js';
import { CONFIG } from '../gcm.config.js';
import { createLogger } from './logger.js';
import type { Logger, LoggerConfig, LogMetadata } from './logger.js';
import { createGeminiClient } from './gemini-client.js';
import { parseGeminiOutput } from './parser.js';
import type { Labels } from './parser.js';
import { getCommitContextHints } from './scope-detector.js';
import type { CommitContextHints } from './scope-detector.js';
import { listGeminiModels } from './gemini-client/listModels.js';
import { createGitService } from './services/git-service.js';
import type { GitService } from './services/git-service.js';
import type { RepositoryState } from './services/git-service.js';
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
  baselineModelName: string;
  modelName: string;
  outputMode: 'full' | 'commit-only';
  userHint?: string;
}

interface ActionMenuResult {
  type: 'commit' | 'regenerate' | 'cancel';
  modelName: string;
  userHint?: string;
}

interface CommitCapability {
  allowed: boolean;
  reason?: string;
}

type ActionChoice =
  | 'commit'
  | 'copy'
  | 'edit'
  | 'regenerate'
  | 'regenerate-hint'
  | 'switch'
  | 'cancel';

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

    ${C.bright}Commit Safety:${C.reset}
      - Commit action is disabled in ${C.cyan}--commit${C.reset} analysis mode (read-only).
      - Commit action is disabled when git has unresolved conflicts.
      - Commit action is disabled while merge/rebase/cherry-pick/revert/bisect is in progress.

    `;
  process.stdout.write(helpText.trim() + '\n');
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

const COMMIT_MESSAGE_RULES = `Commit message rules:
- Subject format: type(scope): summary
- Allowed types: feat, fix, refactor, perf, style, docs, test, build, ci, chore
- Subject must start lowercase after the colon, use imperative mood, have no trailing period, and be extremely concise (max 60 characters).
- Body is optional. Use it only for non-trivial changes.
- Body bullets must start with "- " and each bullet must be extremely concise (max 80 characters total per bullet point).
- CRITICAL: Never add manual line breaks (\\n) inside the subject or inside a single bullet point. Keep each bullet as a single continuous line.

Body semantics:
- Describe observable behaviour, business rules, or technical invariants changed by the diff.
- Write bullets as acceptance-style technical outcomes, not as user stories.
- Prefer what behaviour now holds true over implementation narration.
- Do not list filenames.
- Include implementation details only when they clarify behaviour, risk, or compatibility.

Grounding:
- Use only facts present in the changed file list, diff, and recent commit examples.
- Do not mention tools, frameworks, modules, APIs, versions, or behaviours unless visible in the provided context.
- Never invent motivation, performance impact, security impact, migration impact, or breaking-change status.
- If intent is ambiguous, use conservative wording.

Style alignment:
- Use recent commit examples only to align type, scope, and wording style.
- Do not copy unrelated content from history.`;

const SYSTEM_INSTRUCTIONS_FULL = `You generate concise, evidence-grounded Conventional Commit metadata from git diffs.\n\nOutput format (follow exactly):\n\nBRANCH: [Generated branch name]\nCOMMIT_MESSAGE: [Generated conventional commit message]\nPR_TITLE: [Generated pull request title]\nPR_DESCRIPTION: [Generated pull request description]\n\nBranch rules:\n- Format: type/short-description\n- Allowed branch types: feat, fix, refactor, chore, docs\n\n${COMMIT_MESSAGE_RULES}\n\nPR rules:\n- PR title must match the commit subject and be at most 60 characters.\n- PR description must use GitHub-flavoured Markdown and stay to 2-3 short paragraphs or bullets.`;

const SYSTEM_INSTRUCTIONS_COMMIT_ONLY = `You generate concise, evidence-grounded Conventional Commit messages from git diffs.\n\nOutput only the commit message.\n\n${COMMIT_MESSAGE_RULES}`;

function logTokenInfo(params: {
  modelName: string;
  tokens: number;
  inputLength: number;
  enableThinking: boolean;
  logger: Logger;
}): void {
  const { modelName, tokens, inputLength, enableThinking, logger } = params;
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

async function runPreflightIfNeeded(params: {
  parsedArgs: ParsedOptions;
  state: GenerationState;
  apiKey: string;
  logger: Logger;
  listModelsFn: (apiKey: string) => Promise<string[]>;
}): Promise<'continue' | 'exit'> {
  const { parsedArgs, state, apiKey, logger, listModelsFn } = params;
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
      if (!isCancel(selectedModel)) {
        state.baselineModelName = String(selectedModel);
        state.modelName = state.baselineModelName;
      }
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

async function handleActionCopy(finalMessage: string): Promise<void> {
  try {
    await clipboardy.write(finalMessage);
    note('Commit message copied to clipboard!', 'Success');
  } catch (error) {
    note(`Failed to copy to clipboard: ${error}`, 'Error');
  }
}

async function handleActionEdit(finalMessage: string): Promise<string> {
  const edited = await text({
    message: 'Edit commit message',
    initialValue: finalMessage,
    placeholder: 'Enter commit message',
  });
  if (isCancel(edited)) return finalMessage;
  const updated = String(edited);
  note(updated, 'Updated Commit Message');
  return updated;
}

async function runActionMenu(params: {
  state: GenerationState;
  parsedOut: Labels;
  apiKey: string;
  logger: Logger;
  listModelsFn: (apiKey: string) => Promise<string[]>;
  commitCapability: CommitCapability;
}): Promise<ActionMenuResult> {
  const { state, parsedOut, apiKey, logger, listModelsFn, commitCapability } = params;
  let finalMessage = parsedOut.COMMIT_MESSAGE;
  if (!commitCapability.allowed && commitCapability.reason) {
    note(commitCapability.reason, 'Commit unavailable');
  }

  for (;;) {
    const action = await selectAction(commitCapability);
    if (action === null || action === 'cancel') {
      outro('Commit cancelled.');
      return { type: 'cancel', modelName: state.modelName, userHint: state.userHint };
    }
    const actionResult = await handleActionChoice({
      action,
      finalMessage,
      parsedOut,
      state,
      apiKey,
      logger,
      listModelsFn,
    });
    if (actionResult.type === 'update-message') {
      finalMessage = actionResult.message;
      continue;
    }
    if (actionResult.type === 'continue') continue;
    return actionResult.result;
  }
}

async function selectAction(commitCapability: CommitCapability): Promise<ActionChoice | null> {
  const options: Array<{ value: ActionChoice; label: string }> = [];
  if (commitCapability.allowed) options.push({ value: 'commit', label: 'Commit' });
  options.push(
    { value: 'copy', label: 'Copy to clipboard' },
    { value: 'edit', label: 'Edit message' },
    { value: 'regenerate', label: 'Regenerate (same model)' },
    { value: 'regenerate-hint', label: 'Regenerate with Hint...' },
    { value: 'switch', label: 'Switch Model & Regenerate' },
    { value: 'cancel', label: 'Cancel' },
  );
  const action = await select({
    message: 'What would you like to do?',
    options,
  });
  if (isCancel(action)) return null;
  return action as ActionChoice;
}

async function handleActionChoice(params: {
  action: ActionChoice;
  finalMessage: string;
  parsedOut: Labels;
  state: GenerationState;
  apiKey: string;
  logger: Logger;
  listModelsFn: (apiKey: string) => Promise<string[]>;
}): Promise<
  | { type: 'continue' }
  | { type: 'update-message'; message: string }
  | { type: 'return'; result: ActionMenuResult }
> {
  const { action, finalMessage, parsedOut, state, apiKey, logger, listModelsFn } = params;
  if (action === 'copy') {
    await handleActionCopy(finalMessage);
    return { type: 'continue' };
  }
  if (action === 'edit') {
    return { type: 'update-message', message: await handleActionEdit(finalMessage) };
  }
  if (action === 'regenerate') {
    return {
      type: 'return',
      result: { type: 'regenerate', modelName: state.modelName, userHint: undefined },
    };
  }
  if (action === 'regenerate-hint') return handleRegenerateHint(state);
  if (action === 'switch') return handleSwitchModel(apiKey, logger, listModelsFn);
  parsedOut.COMMIT_MESSAGE = finalMessage;
  return {
    type: 'return',
    result: { type: 'commit', modelName: state.modelName, userHint: state.userHint },
  };
}

async function handleRegenerateHint(
  state: GenerationState,
): Promise<{ type: 'continue' } | { type: 'return'; result: ActionMenuResult }> {
  const hint = await text({
    message: 'Enter hint for regeneration (e.g. "emphasize refactoring")',
    placeholder: 'Add instructions...',
  });
  if (isCancel(hint)) return { type: 'continue' };
  return {
    type: 'return',
    result: { type: 'regenerate', modelName: state.modelName, userHint: String(hint) },
  };
}

async function handleSwitchModel(
  apiKey: string,
  logger: Logger,
  listModelsFn: (apiKey: string) => Promise<string[]>,
): Promise<{ type: 'continue' } | { type: 'return'; result: ActionMenuResult }> {
  const modelOptions = await getModelSelectionOptions(apiKey, logger, listModelsFn);
  const selectedModel = await select({
    message: 'Select AI Model for Regeneration',
    options: modelOptions,
  });
  if (isCancel(selectedModel)) return { type: 'continue' };
  return {
    type: 'return',
    result: { type: 'regenerate', modelName: String(selectedModel), userHint: undefined },
  };
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

function buildLoggerConfig(parsedArgs: ParsedOptions): LoggerConfig {
  const loggerConfig: LoggerConfig = {
    LOG_LEVEL: CONFIG.LOG_LEVEL,
    TELEMETRY_FILE: CONFIG.TELEMETRY_FILE,
  };
  if (parsedArgs.verbose) loggerConfig.LOG_LEVEL = 'debug';
  if (parsedArgs.debug) CONFIG.DEBUG_API = true;
  return loggerConfig;
}

async function buildGenerationState(parsedArgs: ParsedOptions): Promise<{
  targetCommit: string | null;
  state: GenerationState;
}> {
  const targetCommit = parsedArgs.commit || null;
  const session = await loadSession();
  const resolvedSessionModel =
    session.modelName === 'gemini-2.5-pro' ? CONFIG.MODEL_NAME : session.modelName;
  const initialModelName = parsedArgs.model || resolvedSessionModel || CONFIG.MODEL_NAME;
  return {
    targetCommit,
    state: {
      baselineModelName: initialModelName,
      modelName: initialModelName,
      outputMode: parsedArgs.mode || session.outputMode || 'commit-only',
      userHint: undefined,
    },
  };
}

async function runGenerationSafely(params: {
  opts: RunnerOptions;
  parsedArgs: ParsedOptions;
  logger: Logger;
  apiKey: string;
  targetCommit: string | null;
  state: GenerationState;
  s: ReturnType<typeof spinner>;
}): Promise<void> {
  const { opts, parsedArgs, logger, apiKey, targetCommit, state, s } = params;
  try {
    const services = createRunnerServices(opts, logger, apiKey);
    await runGenerationWorkflow({ services, parsedArgs, logger, apiKey, targetCommit, state, s });
  } catch (error: unknown) {
    s.stop('An error occurred');
    const errStr = String(error);
    if (/Not a git repository/i.test(errStr)) cancel('Error: Not inside a git repository.');
    else if (/unknown revision/i.test(errStr)) cancel(`Error: Invalid commit SHA: ${targetCommit}`);
    else {
      logger.log('error', `Gemini commit helper failed: ${error}`, { error: errStr });
      cancel(`An unexpected error occurred: ${errStr}`);
    }
    throw error;
  }
}

async function runGenerationWorkflow(params: {
  services: RunnerServices;
  parsedArgs: ParsedOptions;
  logger: Logger;
  apiKey: string;
  targetCommit: string | null;
  state: GenerationState;
  s: ReturnType<typeof spinner>;
}): Promise<void> {
  const { services, parsedArgs, logger, apiKey, targetCommit, state, s } = params;
  logTargetCommitInfo(logger, targetCommit);
  const readyState = await resolveReadyRepositoryState({
    services,
    parsedArgs,
    targetCommit,
    logger,
    s,
  });
  if (!readyState) return;
  const { repositoryState, staged } = readyState;
  if (!targetCommit && isWhitespaceOnlyStagedChanges(staged)) {
    cancel(
      `Only whitespace-only staged changes detected in ${staged.stagedFiles.length} file(s). Nothing to send to AI.`,
    );
    return;
  }

  const initialCommitCapability = evaluateCommitCapability(repositoryState, targetCommit);
  showRepositoryWarnings(repositoryState, targetCommit, initialCommitCapability);
  const preflight = await runPreflightIfNeeded({
    parsedArgs,
    state,
    apiKey,
    logger,
    listModelsFn: services.listModelsFn,
  });
  if (preflight === 'exit') return;
  if (repositoryState.hasUnmergedPaths) {
    cancel(
      'Git index has unresolved conflicts. Resolve conflicts before generating or committing.',
    );
    return;
  }
  const commitCapability = evaluateCommitCapability(repositoryState, targetCommit);
  const meta = buildLogMetadata(staged, targetCommit);
  const commitContextHints = await resolveCommitContextHints(staged.stagedFiles, logger);
  const shouldContinue = await confirmAtomicityIfNeeded(
    commitContextHints.scopeSuggestions,
    staged.stagedFiles,
    targetCommit,
  );
  if (!shouldContinue) return;
  await runGenerationCycle({
    services,
    parsedArgs,
    logger,
    apiKey,
    state,
    s,
    staged,
    meta,
    commitContextHints,
    targetCommit,
    commitCapability,
  });
}

function logTargetCommitInfo(logger: Logger, targetCommit: string | null): void {
  if (!targetCommit) return;
  logger.log('info', `${C.dim}Using commit ${targetCommit} for analysis${C.reset}`);
}

async function resolveReadyRepositoryState(params: {
  services: RunnerServices;
  parsedArgs: ParsedOptions;
  targetCommit: string | null;
  logger: Logger;
  s: ReturnType<typeof spinner>;
}): Promise<{
  repositoryState: RepositoryState;
  staged: NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>>;
} | null> {
  const { services, parsedArgs, targetCommit, logger, s } = params;
  let repositoryState = await getRepositoryStateSafe(services.gitService, logger);
  let staged = await loadStagedChanges({
    services,
    parsedArgs,
    targetCommit,
    logger,
    s,
    suppressNoChangesMessage: true,
  });

  while (!staged) {
    const nextStep = await handleEmptyStaging({
      repositoryState,
      targetCommit,
      stagedFilesFromWorktree: repositoryState.changedFiles,
    });
    if (nextStep === 'cancel') return null;
    repositoryState = await getRepositoryStateSafe(services.gitService, logger);
    staged = await loadStagedChanges({
      services,
      parsedArgs,
      targetCommit,
      logger,
      s,
      suppressNoChangesMessage: true,
    });
  }

  return { repositoryState, staged };
}

function evaluateCommitCapability(
  repositoryState: RepositoryState,
  targetCommit: string | null,
): CommitCapability {
  if (targetCommit) {
    return {
      allowed: false,
      reason: 'Commit is disabled in analyze-commit mode. This mode is read-only.',
    };
  }
  if (repositoryState.inProgressOperation) {
    return {
      allowed: false,
      reason: `Commit is disabled while a git ${repositoryState.inProgressOperation} is in progress. Finish or abort the operation first.`,
    };
  }
  return { allowed: true };
}

function showRepositoryWarnings(
  repositoryState: RepositoryState,
  targetCommit: string | null,
  commitCapability: CommitCapability,
): void {
  const warnings: string[] = [];
  if (targetCommit) {
    warnings.push(
      'Read-only analysis mode is active (`--commit`): commit action will be disabled.',
    );
  }
  if (repositoryState.hasUnmergedPaths) {
    warnings.push('Unresolved merge conflicts detected in index.');
  }
  if (repositoryState.inProgressOperation) {
    warnings.push(
      `Git operation in progress: ${repositoryState.inProgressOperation}. Commit action will be disabled.`,
    );
  }
  if (!commitCapability.allowed && commitCapability.reason) {
    warnings.push(commitCapability.reason);
  }
  if (!warnings.length) return;
  note(warnings.map((entry, idx) => `${idx + 1}. ${entry}`).join('\n'), 'Repository warnings');
}

async function handleEmptyStaging(params: {
  repositoryState: RepositoryState;
  targetCommit: string | null;
  stagedFilesFromWorktree: string[];
}): Promise<'retry' | 'cancel'> {
  const { repositoryState, targetCommit, stagedFilesFromWorktree } = params;
  if (targetCommit) {
    cancel(`No changes found in commit ${targetCommit}.`);
    return 'cancel';
  }

  const hasWorktreeChanges = stagedFilesFromWorktree.length > 0;
  const warningLines = hasWorktreeChanges
    ? [
        'No files are selected for commit (stage).',
        'Add files with `git add <files>`, then choose "Re-check changes".',
        'Or choose "Show split proposal" for a commit split suggestion.',
      ]
    : [
        'No files are selected for commit (stage).',
        'Worktree is clean. Create or change files, then add them with `git add`.',
      ];
  note(warningLines.join('\n'), 'TIP');

  for (;;) {
    const action = await select({
      message: 'How do you want to proceed?',
      options: [
        { value: 'retry', label: 'Re-check changes' },
        ...(hasWorktreeChanges ? [{ value: 'split', label: 'Show split proposal' as const }] : []),
        { value: 'cancel', label: 'Cancel' },
      ],
    });
    if (isCancel(action) || action === 'cancel') return 'cancel';
    if (action === 'split') {
      note(buildAtomicSplitProposal(stagedFilesFromWorktree), 'Atomic split proposal');
      continue;
    }
    if (repositoryState.hasUnmergedPaths) {
      note(
        'Unresolved conflicts are present. Resolve them before staging and committing.',
        'Warning',
      );
    }
    return 'retry';
  }
}

async function getRepositoryStateSafe(
  gitService: GitService,
  logger: Logger,
): Promise<RepositoryState> {
  if (typeof gitService.getRepositoryState === 'function') {
    return gitService.getRepositoryState(logger);
  }
  logger.log('debug', 'Git service does not expose repository state; using safe fallback.');
  return {
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    hasUntrackedFiles: false,
    hasUnmergedPaths: false,
    inProgressOperation: null,
    changedFiles: [],
  };
}

function buildLogMetadata(
  staged: NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>>,
  targetCommit: string | null,
): LogMetadata {
  return {
    targetCommit: targetCommit || null,
    numFiles: staged.stagedFiles.length,
    origLen: staged.stagedDiff.length,
    truncated: staged.truncated,
  };
}

async function loadStagedChanges(params: {
  services: RunnerServices;
  parsedArgs: ParsedOptions;
  targetCommit: string | null;
  logger: Logger;
  s: ReturnType<typeof spinner>;
  suppressNoChangesMessage?: boolean;
}): Promise<NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>> | null> {
  const { services, parsedArgs, targetCommit, logger, s, suppressNoChangesMessage } = params;
  s.start('Analyzing repository changes...');
  const staged = await services.gitService.retrieveStagedChanges(
    targetCommit,
    logger,
    parsedArgs.exclude,
  );
  if (!staged) {
    s.stop(`${C.yellow}No staged changes found${C.reset}`);
    if (!suppressNoChangesMessage) {
      cancel('No staged changes found. Use "git add" to stage files.');
    }
    return null;
  }
  if (!targetCommit && isWhitespaceOnlyStagedChanges(staged)) {
    s.stop(
      `${C.yellow}Found ${staged.stagedFiles.length} staged file(s), but only whitespace changes${C.reset}`,
    );
    return staged;
  }
  s.stop(`Found ${staged.stagedFiles.length} file(s) changed`);
  return staged;
}

function isWhitespaceOnlyStagedChanges(
  staged: NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>>,
): boolean {
  return staged.stagedFiles.length > 0 && staged.stagedDiff.trim().length === 0;
}

async function resolveCommitContextHints(
  stagedFiles: string[],
  logger: Logger,
): Promise<CommitContextHints> {
  try {
    return await getCommitContextHints(stagedFiles);
  } catch (error) {
    logger.log('debug', 'Failed to get commit context hints', { error: String(error) });
    return { scopeSuggestions: [], recentCommitSubjects: [] };
  }
}

async function confirmAtomicityIfNeeded(
  scopeSuggestions: string[],
  stagedFiles: string[],
  targetCommit: string | null,
): Promise<boolean> {
  if (targetCommit) return true;
  const stagedGroups = Array.from(new Set(stagedFiles.map(detectAtomicGroup)));
  if (stagedGroups.length <= 1) return true;
  const displayScopes = stagedGroups.length > 0 ? stagedGroups : scopeSuggestions;
  for (;;) {
    const action = await select({
      message: [
        `Staged files suggest multiple possible scopes: ${displayScopes.join(', ')}.`,
        'Atomic commits are preferred; split unrelated changes unless this is one functional unit.',
      ].join('\n'),
      options: [
        { value: 'split', label: 'Show split proposal' },
        { value: 'continue', label: 'Continue anyway' },
        { value: 'cancel', label: 'Cancel' },
      ],
    });
    if (isCancel(action) || action === 'cancel') {
      outro('Commit cancelled.');
      return false;
    }
    if (action === 'continue') return true;
    note(buildAtomicSplitProposal(stagedFiles), 'Atomic split proposal');
  }
}

function buildAtomicSplitProposal(stagedFiles: string[]): string {
  const groups = new Map<string, string[]>();
  for (const file of stagedFiles) {
    const scope = detectAtomicGroup(file);
    const list = groups.get(scope) || [];
    list.push(file);
    groups.set(scope, list);
  }

  const orderedGroups = orderAtomicGroups(groups);
  const sections: string[] = [];
  let index = 0;
  for (const [scope, files] of orderedGroups) {
    index += 1;
    const escapedFiles = files.map(escapeShellArg).join(' ');
    const commitSubject = buildSuggestedSplitCommitSubject(scope, files);
    const commitBodyBullet = buildSuggestedSplitCommitBody(scope, files);
    sections.push(
      [
        `Commit ${index}: ${scope}`,
        ...files.map(file => `- ${file}`),
        '',
        'Suggested commands:',
        `git reset`,
        `git add ${escapedFiles}`,
        `git commit -m $'${escapeForAnsiCString(commitSubject)}' \\`,
        `  -m $'- ${escapeForAnsiCString(commitBodyBullet)}'`,
      ].join('\n'),
    );
  }

  return [
    `Found ${stagedFiles.length} staged file(s), proposed ${groups.size} atomic group(s).`,
    'Rules applied: lockfiles grouped with dependency manifests; docs/formatting split from functional changes.',
    '',
    ...sections,
  ].join('\n\n');
}

function detectAtomicGroup(file: string): string {
  if (isDependencyMetadataFile(file)) return 'deps';
  if (isDocsOrFormattingFile(file)) return 'docs-formatting';

  const workspaceMatch = /^(apps|packages|sites|tools)\/([^/]+)/.exec(file);
  if (workspaceMatch?.[2]) return workspaceMatch[2];
  if (file.startsWith('.github/')) return 'ci';
  if (/^(infra|scripts)\//.test(file)) return 'tooling';
  if (/^test\//.test(file) || /\.test\./.test(file)) return 'tests';
  if (/^src\/services\//.test(file)) return 'services';
  if (/^src\/models\//.test(file)) return 'models';
  if (/^src\/.*runner/.test(file) || file.includes('runner.ts')) return 'runner';
  if (/^src\/.*scope-detector/.test(file) || file.includes('scope-detector.ts')) return 'scope';
  const topLevel = file.split('/')[0];
  if (topLevel && topLevel !== file) return topLevel;
  return 'core';
}

function isDependencyMetadataFile(file: string): boolean {
  const base = file.split('/').pop() || '';
  if (base === 'package.json') return true;
  if (/^(pnpm-lock\.yaml|bun\.lockb?|package-lock\.json|yarn\.lock)$/.test(base)) return true;
  if (base === 'pnpm-workspace.yaml') return true;
  return false;
}

function isDocsOrFormattingFile(file: string): boolean {
  if (/\.(md|mdx|rst|txt)$/i.test(file)) return true;
  const base = file.split('/').pop() || '';
  if (/^(\.prettierrc(\..+)?|\.editorconfig|prettier\.config\.(js|ts|cjs|mjs))$/i.test(base)) {
    return true;
  }
  if (/^(\.eslintrc(\..+)?|eslint\.config\.(js|ts|cjs|mjs))$/i.test(base)) return true;
  return false;
}

function orderAtomicGroups(groups: Map<string, string[]>): Array<[string, string[]]> {
  const priority: Record<string, number> = {
    deps: 10,
    ci: 20,
    tooling: 30,
    core: 40,
    services: 50,
    models: 60,
    runner: 70,
    scope: 80,
    tests: 90,
    'docs-formatting': 100,
  };
  return Array.from(groups.entries()).sort((a, b) => {
    const aPriority = priority[a[0]] ?? 50;
    const bPriority = priority[b[0]] ?? 50;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a[0].localeCompare(b[0]);
  });
}

function buildSuggestedSplitCommitSubject(scope: string, files: string[]): string {
  const typeByScope: Record<string, string> = {
    tests: 'test',
    'docs-formatting': 'docs',
    deps: 'build',
    ci: 'ci',
    tooling: 'chore',
  };
  const type = typeByScope[scope] || 'refactor';
  const normalizedScope = scope === 'docs-formatting' ? 'docs' : scope;
  const fileHint = files.length === 1 ? files[0].split('/').pop() || 'changes' : 'changes';
  return `${type}(${normalizedScope}): split ${fileHint} updates`;
}

function buildSuggestedSplitCommitBody(scope: string, files: string[]): string {
  if (scope === 'deps') return 'align dependency metadata and lockfile state';
  if (scope === 'docs-formatting') return 'separate documentation and formatting-only changes';
  if (scope === 'tests') return 'keep test coverage aligned with related code updates';
  if (files.length === 1) return `isolate ${files[0]} changes into one atomic unit`;
  return `group ${scope} changes into one atomic unit`;
}

function escapeForAnsiCString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, `\\'`);
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runGenerationCycle(params: {
  services: RunnerServices;
  parsedArgs: ParsedOptions;
  logger: Logger;
  apiKey: string;
  state: GenerationState;
  s: ReturnType<typeof spinner>;
  staged: NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>>;
  meta: LogMetadata;
  commitContextHints: CommitContextHints;
  targetCommit: string | null;
  commitCapability: CommitCapability;
}): Promise<void> {
  const {
    services,
    logger,
    apiKey,
    state,
    s,
    staged,
    meta,
    commitContextHints,
    targetCommit,
    commitCapability,
  } = params;
  for (;;) {
    const outcome = await runSingleGenerationAttempt({
      services,
      logger,
      apiKey,
      state,
      s,
      staged,
      meta,
      commitContextHints,
      targetCommit,
      commitCapability,
    });
    if (outcome === 'regenerate') continue;
    return;
  }
}

async function runSingleGenerationAttempt(params: {
  services: RunnerServices;
  logger: Logger;
  apiKey: string;
  state: GenerationState;
  s: ReturnType<typeof spinner>;
  staged: NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>>;
  meta: LogMetadata;
  commitContextHints: CommitContextHints;
  targetCommit: string | null;
  commitCapability: CommitCapability;
}): Promise<'done' | 'regenerate'> {
  const {
    services,
    logger,
    apiKey,
    state,
    s,
    staged,
    meta,
    commitContextHints,
    targetCommit,
    commitCapability,
  } = params;
  const modelSpec = getModelSpec(state.modelName);
  const safeMaxTokens = modelSpec.maxInputTokens - CONFIG.MAX_OUTPUT_TOKENS - 1000;
  const customHeader =
    state.outputMode === 'full'
      ? 'Generate a branch name, pull request title, pull request description, and a conventional commit message based on the following'
      : 'Generate a professional conventional commit message based on the following';
  const contextResult = await services.contextService.constructLLMPromptContext({
    diffContent: staged.stagedDiff,
    promptSuffix: staged.truncated ? 'truncated diff' : 'diff',
    maxAvailableTokens: safeMaxTokens,
    tokenBytesRatio: CONFIG.TOKEN_BYTES_RATIO,
    stagedFiles: staged.stagedFiles,
    scopeSuggestions: commitContextHints.scopeSuggestions,
    recentCommitSubjects: commitContextHints.recentCommitSubjects,
    logger,
    customHeader,
    userHint: state.userHint,
  });
  logTokenInfo({
    modelName: state.modelName,
    tokens: contextResult.tokens,
    inputLength: contextResult.processedDiffContent.length,
    enableThinking: CONFIG.ENABLE_THINKING,
    logger,
  });
  logger.log('debug', 'Run started', {
    targetCommit: targetCommit ?? null,
    runtime: detectRuntime(),
  });
  s.start(`Generating commit message with ${state.modelName}...`);
  const systemPrompt =
    state.outputMode === 'full' ? SYSTEM_INSTRUCTIONS_FULL : SYSTEM_INSTRUCTIONS_COMMIT_ONLY;
  const response = await services.geminiService.callGeminiAPI({
    promptContext: contextResult.promptContext,
    systemPrompt,
    stagedFiles: staged.stagedFiles,
    meta,
    opts: {
      modelOverride: state.modelName,
      retryIfTruncated: true,
      retryIfTruncatedMaxRetries: 1,
      retryIfTruncatedIncreaseTokens: CONFIG.MAX_OUTPUT_TOKENS,
    },
  });
  s.stop('Gemini response received');
  if (!response) {
    logger.log('warn', 'Gemini did not return text after retries; using deterministic fallback');
    displayResultStructured(logger, generateFallbackCommitDetails(staged.stagedFiles));
    return 'done';
  }
  const action = await handleSuccessfulGeneration({
    response,
    state,
    logger,
    apiKey,
    services,
    meta,
    s,
    commitCapability,
  });
  return action;
}

async function handleSuccessfulGeneration(params: {
  response: NonNullable<Awaited<ReturnType<GeminiService['callGeminiAPI']>>>;
  state: GenerationState;
  logger: Logger;
  apiKey: string;
  services: RunnerServices;
  meta: LogMetadata;
  s: ReturnType<typeof spinner>;
  commitCapability: CommitCapability;
}): Promise<'done' | 'regenerate'> {
  const { response, state, logger, apiKey, services, meta, s, commitCapability } = params;
  logger.log('debug', 'LLM response received', {
    promptTokens: response.usage.promptTokens,
    outputTokens: response.usage.outputTokens,
    ...meta,
  });
  const parsedOut = parseAndSanitizeResponse(response.text, state.outputMode, logger);
  if (!parsedOut) {
    logger.log('info', response.text);
    outro('Failed to parse structured output.');
    return 'done';
  }
  const warningIcon = response.truncated ? ` ${C.yellow}[⚠ ZKRACENO]${C.reset}` : '';
  note(
    buildNoteContent(state.outputMode, parsedOut),
    (state.outputMode === 'full' ? 'Generated Report' : 'Generated Commit Message') + warningIcon,
  );
  reportStats(logger, state.modelName, response.usage, response.text.length);
  const actionResult = await runActionMenu({
    state,
    parsedOut,
    apiKey,
    logger,
    listModelsFn: services.listModelsFn,
    commitCapability,
  });
  if (actionResult.type === 'cancel') return 'done';
  state.baselineModelName = actionResult.modelName;
  state.modelName = actionResult.modelName;
  state.userHint = actionResult.userHint;
  if (actionResult.type === 'regenerate') return 'regenerate';
  return commitGeneratedMessage({
    commitMessage: parsedOut.COMMIT_MESSAGE,
    services,
    state,
    logger,
    s,
  });
}

async function commitGeneratedMessage(params: {
  commitMessage: string;
  services: RunnerServices;
  state: GenerationState;
  logger: Logger;
  s: ReturnType<typeof spinner>;
}): Promise<'done'> {
  const { commitMessage, services, state, logger, s } = params;
  s.start('Committing changes...');
  try {
    await services.gitService.commitChanges(commitMessage, logger);
    await saveSession({ modelName: state.baselineModelName, outputMode: state.outputMode });
    s.stop('Changes committed successfully');
    outro(`${C.cyan}Commit successfully created!${C.reset}`);
  } catch (error) {
    s.stop('Commit failed');
    cancel(`Failed to commit changes: ${error}`);
    logger.log('error', `Commit failed: ${error}`);
  }
  return 'done';
}

async function handleCliEarlyExit(
  parsedArgs: ParsedOptions,
  packageInfo: PackageInfo,
): Promise<boolean> {
  if (parsedArgs.version) {
    process.stdout.write(`${packageInfo.name} ${packageInfo.version}\n`);
    return true;
  }
  intro(`${C.bright}Gemini Commit Message Helper v${packageInfo.version}${C.reset}`);
  if (parsedArgs.help) {
    showHelp();
    return true;
  }
  const listModelsExitCode = await maybeHandleListModels(parsedArgs);
  if (listModelsExitCode === null) return false;
  process.exitCode = listModelsExitCode;
  return true;
}

export async function executeCommitMessageGeneration(
  argv?: string[],
  dependencies?: RunnerOptions,
): Promise<void> {
  const opts = dependencies || {};
  const parsedArgs: ParsedOptions = parseArgs(argv || process.argv.slice(2));
  const packageInfo = getPackageInfo();
  if (await handleCliEarlyExit(parsedArgs, packageInfo)) return;

  const loggerConfig = buildLoggerConfig(parsedArgs);
  const logger = opts.logger || createLogger(loggerConfig);
  const s = spinner();

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    cancel('Error: Environment variable GOOGLE_GEMINI_API_KEY not set.');
    return;
  }

  const { targetCommit, state } = await buildGenerationState(parsedArgs);
  await runGenerationSafely({ opts, parsedArgs, logger, apiKey, targetCommit, state, s });
}

export default { executeCommitMessageGeneration };
