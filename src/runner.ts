import { ArgumentValidationError, parseArgs } from './cli.js';
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
import type { GitService, RepositoryState } from './services/git-service.js';
import {
  createCommitActionService,
  isCommitActionRefusal,
  type CommitCapability,
} from './commit-action-service.js';
import { createContextService } from './services/context-service.js';
import type { ContextService } from './services/context-service.js';
import { createGeminiService } from './services/gemini-service.js';
import type { GeminiService } from './services/gemini-service.js';
import { generateFallbackCommitDetails } from './runner-utils.js';
import { buildAtomicSplitProposal } from './atomic-commit-planner.js';
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
import { KNOWN_MODELS, getEffectiveMaxOutputTokens, getModelSpec } from './model-registry.js';
import { sanitizeForDisplay, stripTerminalControlSequences } from './utils.js';
import clipboardy from 'clipboardy';
import pkg from '../package.json';
import {
  createInteractiveGenerationDialogue,
  type ActionMenuResult,
  type GenerationState,
  type InteractiveGenerationDialogue,
} from './interactive-generation-dialogue.js';

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
  gitService: GitService;
  contextService: ContextService;
  geminiService: GeminiService;
  dialogue: InteractiveGenerationDialogue;
}

type TerminalOutcome = 'success' | 'failure';

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

function displayResultStructured(logger: Logger, res: Labels): void {
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
  logger: Logger;
}): void {
  const { modelName, tokens, inputLength, logger } = params;
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

function createRunnerServices(opts: RunnerOptions, logger: Logger, apiKey: string): RunnerServices {
  const gitService = opts.gitService || createGitService();
  const contextService = opts.contextService || createContextService();
  const geminiClient = createGeminiClient({ config: CONFIG, logger });
  const geminiService =
    opts.geminiService ||
    createGeminiService({ client: geminiClient, logger, apiKey, contextService });
  const listModelsFn = opts.listModels || listGeminiModels;
  const dialogue = createRunnerDialogue(logger, listModelsFn);
  return { gitService, contextService, geminiService, dialogue };
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
    session.modelName === 'gemini-2.5-flash' || session.modelName === 'gemini-2.5-pro'
      ? CONFIG.MODEL
      : session.modelName;
  const initialModelName = parsedArgs.model || resolvedSessionModel || CONFIG.MODEL;
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

// eslint-disable-next-line max-statements -- terminal outcomes must reach the entrypoint intact.
async function runGenerationSafely(params: {
  opts: RunnerOptions;
  parsedArgs: ParsedOptions;
  logger: Logger;
  apiKey: string | undefined;
  targetCommit: string | null;
  state: GenerationState;
  s: ReturnType<typeof spinner>;
}): Promise<TerminalOutcome> {
  const { opts, parsedArgs, logger, apiKey, targetCommit, state, s } = params;
  try {
    const services = createRunnerServices(opts, logger, apiKey || '');
    return await runGenerationWorkflow({
      services,
      parsedArgs,
      logger,
      apiKey,
      targetCommit,
      state,
      s,
    });
  } catch (error: unknown) {
    s.stop('An error occurred');
    const errStr = String(error);
    if (/Not a git repository/i.test(errStr)) {
      cancel('Error: Not inside a git repository.');
      return 'failure';
    } else if (/unknown revision/i.test(errStr))
      cancel(`Error: Invalid commit SHA: ${targetCommit}`);
    else if (isGeminiApiError(error)) {
      const metadata = error.metadata || {};
      let msg = `API Error (${metadata.status || 'Unknown'})`;
      try {
        const parsed: unknown = JSON.parse(
          typeof metadata.snippet === 'string' ? metadata.snippet : '{}',
        );
        const responseError = isRecord(parsed) ? parsed.error : undefined;
        const responseMessage = isRecord(responseError) ? responseError.message : undefined;
        if (responseMessage) {
          msg += `: ${stripTerminalControlSequences(String(responseMessage))}`;
        } else {
          msg += `: ${stripTerminalControlSequences(error.message)}`;
        }
      } catch {
        msg += `: ${stripTerminalControlSequences(error.message)}`;
      }
      logger.log('error', `Gemini commit helper failed: ${error}`, {
        error: errStr,
        snippet: metadata.snippet,
      });
      cancel(stripTerminalControlSequences(msg));
    } else {
      logger.log('error', `Gemini commit helper failed: ${error}`, { error: errStr });
      cancel(`An unexpected error occurred: ${errStr}`);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGeminiApiError(
  error: unknown,
): error is Error & { name: 'GeminiApiError'; metadata?: Record<string, unknown> } {
  return (
    error instanceof Error &&
    error.name === 'GeminiApiError' &&
    (!('metadata' in error) || isRecord(error.metadata))
  );
}

// eslint-disable-next-line max-statements -- terminal outcomes must reach the entrypoint intact.
async function runGenerationWorkflow(params: {
  services: RunnerServices;
  parsedArgs: ParsedOptions;
  logger: Logger;
  apiKey: string | undefined;
  targetCommit: string | null;
  state: GenerationState;
  s: ReturnType<typeof spinner>;
}): Promise<TerminalOutcome> {
  const { services, parsedArgs, logger, apiKey, targetCommit, state, s } = params;
  logTargetCommitInfo(logger, targetCommit);
  const readyState = await resolveReadyRepositoryState({
    services,
    parsedArgs,
    targetCommit,
    logger,
    s,
  });
  if (!readyState) return 'failure';
  const { repositoryState, staged } = readyState;
  if (!targetCommit && isWhitespaceOnlyStagedChanges(staged)) {
    cancel(
      `Only whitespace-only staged changes detected in ${staged.stagedFiles.length} file(s). Nothing to send to AI.`,
    );
    return 'failure';
  }
  if (!apiKey) {
    cancel('Error: Environment variable GOOGLE_GEMINI_API_KEY not set.');
    return 'failure';
  }
  const commitActions = createCommitActionService({ gitService: services.gitService, logger });
  const inspection = await commitActions.inspect(targetCommit, staged.snapshot);
  const preflightRepositoryState = inspection.repositoryState ?? repositoryState;
  if (reportUnresolvedConflicts(preflightRepositoryState)) return 'failure';
  if (inspection.observedSnapshotInvalid) {
    cancel(inspection.capability.reason ?? 'Staged changes could not be verified. Run gcm again.');
    return 'failure';
  }

  showRepositoryWarnings(preflightRepositoryState, targetCommit, inspection.capability);
  const preflight =
    parsedArgs.model && parsedArgs.mode
      ? 'continue'
      : await services.dialogue.configure(state, apiKey);
  if (preflight === 'exit') return 'success';
  const commitCapability = {
    ...inspection.capability,
    excludedPaths: targetCommit ? [] : (staged.excludedPaths ?? []),
  };
  const meta = buildLogMetadata(staged, targetCommit);
  const commitContextHints = await resolveCommitContextHints(staged.stagedFiles, logger);
  const shouldContinue = await services.dialogue.confirmAtomicity(staged.stagedFiles, targetCommit);
  if (!shouldContinue) return 'success';
  return runGenerationCycle({
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
  let repositoryState = await services.gitService.getRepositoryState(logger);
  if (reportUnresolvedConflicts(repositoryState)) return null;
  let staged = await loadStagedChanges({
    services,
    parsedArgs,
    targetCommit,
    logger,
    s,
    suppressNoChangesMessage: process.stdin.isTTY,
  });

  if (!staged && !process.stdin.isTTY) return null;

  while (!staged) {
    const nextStep = await handleEmptyStaging({
      targetCommit,
      stagedFilesFromWorktree: repositoryState.changedFiles,
    });
    if (nextStep === 'cancel') return null;
    repositoryState = await services.gitService.getRepositoryState(logger);
    if (reportUnresolvedConflicts(repositoryState)) return null;
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

function reportUnresolvedConflicts(repositoryState: RepositoryState): boolean {
  if (!repositoryState.hasUnmergedPaths) return false;
  cancel('Git index has unresolved conflicts. Resolve conflicts before generating or committing.');
  return true;
}

function showRepositoryWarnings(
  repositoryState: RepositoryState,
  targetCommit: string | null,
  commitCapability: CommitCapability,
): void {
  const warnings: string[] = [];
  if (targetCommit && commitCapability.mode === 'amend') {
    warnings.push(
      'Target is the unpublished HEAD: the commit action will amend it and rewrite that commit.',
    );
  }
  if (targetCommit && commitCapability.mode === 'reword') {
    warnings.push(
      'Target is not an amendable HEAD: the commit action will add an `amend!` commit instead of rewriting history.',
    );
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
  targetCommit: string | null;
  stagedFilesFromWorktree: string[];
}): Promise<'retry' | 'cancel'> {
  const { targetCommit, stagedFilesFromWorktree } = params;
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
    return 'retry';
  }
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

async function runGenerationCycle(params: {
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
}): Promise<TerminalOutcome> {
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
    return outcome;
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
}): Promise<TerminalOutcome | 'regenerate'> {
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
  const maxOutputTokens = getEffectiveMaxOutputTokens(state.modelName, CONFIG.MAX_OUTPUT_TOKENS);
  const safeMaxTokens = modelSpec.maxInputTokens - maxOutputTokens - 1000;
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
    logger,
  });
  logger.log('debug', 'Run started', {
    targetCommit: targetCommit ?? null,
  });
  s.start(`Generating commit message with ${state.modelName}...`);
  const systemPrompt =
    state.outputMode === 'full' ? SYSTEM_INSTRUCTIONS_FULL : SYSTEM_INSTRUCTIONS_COMMIT_ONLY;
  const response = await services.geminiService.callGeminiAPI({
    promptContext: contextResult.promptContext,
    promptParts: contextResult.promptParts,
    summaryAttempted: contextResult.summaryAttempted,
    systemPrompt,
    stagedFiles: staged.stagedFiles,
    meta,
    opts: {
      modelOverride: state.modelName,
      retryIfTruncated: true,
      retryIfTruncatedMaxRetries: 1,
      retryIfTruncatedIncreaseTokens: maxOutputTokens,
    },
  });
  s.stop('Gemini response received');
  if (!response) {
    logger.log('warn', 'Gemini did not return text after retries; using deterministic fallback');
    displayResultStructured(logger, generateFallbackCommitDetails(staged.stagedFiles));
    return 'success';
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
}): Promise<TerminalOutcome | 'regenerate'> {
  const { response, state, logger, apiKey, services, meta, s, commitCapability } = params;
  logger.log('debug', 'LLM response received', {
    promptTokens: response.usage.promptTokens,
    outputTokens: response.usage.outputTokens,
    ...meta,
  });
  const parsedOut = parseAndSanitizeResponse(response.text, state.outputMode, logger);
  if (!parsedOut) {
    logger.log('info', stripTerminalControlSequences(response.text));
    outro('Failed to parse structured output.');
    return 'failure';
  }
  const warningIcon = response.truncated ? ` ${C.yellow}[⚠ ZKRACENO]${C.reset}` : '';
  note(
    buildNoteContent(state.outputMode, parsedOut),
    (state.outputMode === 'full' ? 'Generated Report' : 'Generated Commit Message') + warningIcon,
  );
  reportStats(logger, state.modelName, response.usage, response.text.length);
  const actionResult: ActionMenuResult = await services.dialogue.review({
    state,
    result: parsedOut,
    apiKey,
    commitCapability,
  });
  if (actionResult.type === 'cancel') return 'success';
  state.baselineModelName = actionResult.modelName;
  state.modelName = actionResult.modelName;
  state.userHint = actionResult.userHint;
  if (actionResult.type === 'regenerate') return 'regenerate';
  return commitGeneratedMessage({
    commitMessage: parsedOut.COMMIT_MESSAGE,
    commitCapability: {
      ...commitCapability,
      exclusionsAcknowledged: actionResult.exclusionsAcknowledged,
    },
    services,
    state,
    logger,
    s,
  });
}

async function commitGeneratedMessage(params: {
  commitMessage: string;
  commitCapability: CommitCapability;
  services: RunnerServices;
  state: GenerationState;
  logger: Logger;
  s: ReturnType<typeof spinner>;
}): Promise<TerminalOutcome> {
  const { commitMessage, commitCapability, services, state, logger, s } = params;
  const verb = commitCapability.mode === 'commit' ? 'Committing changes' : commitCapability.mode;
  s.start(`${verb}...`);
  try {
    const commitActions = createCommitActionService({ gitService: services.gitService, logger });
    const { summary } = await commitActions.apply(commitCapability, commitMessage);
    await saveSession({ modelName: state.baselineModelName, outputMode: state.outputMode });
    s.stop('Done');
    outro(`${C.cyan}${summary}${C.reset}`);
  } catch (error) {
    s.stop('Failed');
    cancel(
      isCommitActionRefusal(error)
        ? error.message
        : `Failed to apply commit action: ${error instanceof Error ? error.message : String(error)}`,
    );
    logger.log('error', `Commit action failed: ${error}`);
    return 'failure';
  }
  return 'success';
}

async function handleCliEarlyExit(
  parsedArgs: ParsedOptions,
  packageInfo: PackageInfo,
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
  return maybeHandleListModels(parsedArgs);
}

function parseArgsOrReport(argv: string[]): ParsedOptions | null {
  try {
    return parseArgs(argv);
  } catch (error) {
    if (!(error instanceof ArgumentValidationError)) throw error;
    cancel(`Error: ${error.message}. Run gcm --help for usage.`);
    return null;
  }
}

export async function executeCommitMessageGeneration(
  argv?: string[],
  dependencies?: RunnerOptions,
): Promise<void> {
  const opts = dependencies || {};
  const parsedArgs = parseArgsOrReport(argv || process.argv.slice(2));
  const packageInfo = getPackageInfo();
  let exitCode = 0;
  if (parsedArgs) {
    const earlyExitCode = await handleCliEarlyExit(parsedArgs, packageInfo);
    if (earlyExitCode === null) {
      const loggerConfig = buildLoggerConfig(parsedArgs);
      const logger = opts.logger || createLogger(loggerConfig);
      const s = spinner();
      const { targetCommit, state } = await buildGenerationState(parsedArgs);
      const outcome = await runGenerationSafely({
        opts,
        parsedArgs,
        logger,
        apiKey: process.env.GOOGLE_GEMINI_API_KEY,
        targetCommit,
        state,
        s,
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
