import { CONFIG } from '../gcm.config.js';
import type { ParsedOptions } from './cli.js';
import type { OutputMode } from './output-mode.js';
import {
  isCommitActionRefusal,
  type CommitActionService,
  type CommitCapability,
} from './commit-action-service.js';
import type { Logger, LogMetadata } from './logger.js';
import {
  getModelSpecValidationError,
  isLanguageModelApiError,
  type ModelSpec,
} from './language-model-service.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './model-registry.js';
import { parseLanguageModelOutput, type Labels } from './parser.js';
import { generateFallbackCommitDetails } from './runner-utils.js';
import type { CommitContextHints } from './scope-detector.js';
import type { ContextService } from './services/context-service.js';
import type { LanguageModelService } from './language-model-service.js';
import type { GitService, RepositoryState } from './services/git-service.js';
import type { GCMSession } from './session.js';
import {
  type ActionMenuResult,
  type GenerationState,
  type InteractiveGenerationDialogue,
} from './interactive-generation-dialogue.js';

export type GenerationServices = {
  gitService: GitService;
  contextService: ContextService;
  languageModelService: LanguageModelService;
  providerId: string;
  providerLabel: string;
  getModelSpec(modelName: string): ModelSpec;
  dialogue: InteractiveGenerationDialogue;
  commitActions: CommitActionService;
  getCommitContextHints(files: string[]): Promise<CommitContextHints>;
  saveSession(session: GCMSession): Promise<void>;
  output: {
    isInteractive: boolean;
    startProgress(message: string): void;
    stopProgress(message: string): void;
    cancel(message: string): void;
    note(message: string, title?: string): void;
    outro(message: string): void;
    sanitizeGeneratedText(message: string): string;
    sanitizeTerminalText(message: string): string;
    style: {
      bright(message: string): string;
      cyan(message: string): string;
      cyanBright(message: string): string;
      dim(message: string): string;
      magentaBright(message: string): string;
      yellow(message: string): string;
    };
  };
};

export type ProviderSwitchOutcome = { type: 'switch-provider'; providerId: string };
export type TerminalOutcome = 'success' | 'failure' | ProviderSwitchOutcome;

export function createGenerationState(
  parsedArgs: ParsedOptions,
  session: GCMSession,
  defaultModel: string,
  providerId: string,
): { targetCommit: string | null; state: GenerationState } {
  const sessionModel = session.providerId === providerId ? session.modelName : null;
  const initialModelName = parsedArgs.model ?? sessionModel ?? defaultModel;
  return {
    targetCommit: parsedArgs.commit ?? null,
    state: {
      providerId,
      baselineModelName: initialModelName,
      modelName: initialModelName,
      outputMode: parsedArgs.mode ?? session.outputMode ?? 'commit-only',
      nonInteractive: parsedArgs.nonInteractive,
      apply: parsedArgs.apply,
      userHint: undefined,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function runGenerationCommand(params: {
  createServices(): Omit<GenerationServices, 'output'>;
  parsedArgs: ParsedOptions;
  logger: Logger;
  providerReadinessError?: string;
  canSwitchProvider?: boolean;
  targetCommit: string | null;
  state: GenerationState;
  output: GenerationServices['output'];
}): Promise<TerminalOutcome> {
  const {
    createServices,
    parsedArgs,
    logger,
    providerReadinessError,
    canSwitchProvider,
    targetCommit,
    state,
    output,
  } = params;
  try {
    return await runGenerationWorkflow({
      services: { ...createServices(), output },
      parsedArgs,
      logger,
      providerReadinessError,
      canSwitchProvider,
      targetCommit,
      state,
    });
  } catch (error: unknown) {
    output.stopProgress('An error occurred');
    const errStr = String(error);
    if (/Not a git repository/i.test(errStr)) {
      output.cancel('Error: Not inside a git repository.');
      return 'failure';
    } else if (/unknown revision/i.test(errStr))
      output.cancel(`Error: Invalid commit SHA: ${targetCommit}`);
    else if (isLanguageModelApiError(error)) {
      const metadata = error.metadata ?? {};
      let status = 'Unknown';
      if (typeof metadata.status === 'string' || typeof metadata.status === 'number') {
        status = String(metadata.status);
      }
      let msg = `API Error (${status})`;
      try {
        const parsed: unknown = JSON.parse(
          typeof metadata.snippet === 'string' ? metadata.snippet : '{}',
        );
        const responseError = isRecord(parsed) ? parsed.error : undefined;
        const responseMessage = isRecord(responseError) ? responseError.message : undefined;
        if (typeof responseMessage === 'string' && responseMessage) {
          msg += `: ${output.sanitizeTerminalText(responseMessage)}`;
        } else {
          msg += `: ${output.sanitizeTerminalText(error.message)}`;
        }
      } catch {
        msg += `: ${output.sanitizeTerminalText(error.message)}`;
      }
      logger.log('error', `Commit helper failed: ${error}`, {
        error: errStr,
        snippet: metadata.snippet,
      });
      output.cancel(output.sanitizeTerminalText(msg));
    } else {
      logger.log('error', `Commit helper failed: ${error}`, { error: errStr });
      output.cancel(`An unexpected error occurred: ${output.sanitizeTerminalText(errStr)}`);
    }
    throw error;
  }
}

function displayResultStructured(
  output: GenerationServices['output'],
  logger: Logger,
  res: Labels,
): void {
  const branchText = `\n${output.style.cyanBright('BRANCH:')}\n${res.BRANCH || ''}\n`;
  const commitText = `\n${output.style.cyanBright('COMMIT_MESSAGE:')}\n${res.COMMIT_MESSAGE ?? ''}\n`;
  const titleText = `\n${output.style.magentaBright('PR_TITLE:')}\n${res.PR_TITLE ?? ''}\n`;
  const descText = `\n${output.style.magentaBright('PR_DESCRIPTION:')}\n${res.PR_DESCRIPTION ?? ''}\n`;
  logger.log('info', `${branchText}${commitText}${titleText}${descText}`);
}

function reportStats(
  output: GenerationServices['output'],
  logger: Logger,
  modelName: string,
  usage: { promptTokens?: number; outputTokens?: number; thinkingTokens?: number } = {},
  outputLength: number,
): void {
  let thinking = '';
  if (usage.thinkingTokens) thinking = ` | thinking: ${usage.thinkingTokens}`;
  logger.log(
    'info',
    output.style.dim(
      `${modelName} | actual usage -> input: ${usage.promptTokens ?? 0} tokens | output: ${
        usage.outputTokens ?? 0
      } tokens (${outputLength.toLocaleString()} chars)${thinking}`,
    ) + '\n',
  );
}

const COMMIT_MESSAGE_RULES = `Commit message rules:
- Subject format: type(scope): summary
- Allowed types: feat, fix, refactor, perf, style, docs, test, build, ci, chore
- Subject must start lowercase after the colon, use imperative mood, have no trailing period, and be extremely concise (max 60 characters).
- Body is optional. Use it only when the change cannot be described faithfully in the subject alone.
- When a body is needed, use at least two concise "- " bullets.
- Each bullet must add a distinct detail not already stated in the subject or another bullet.
- Do not repeat or paraphrase the subject in the body.
- CRITICAL: Never add manual line breaks (\\n) inside the subject or inside a single bullet point. Keep each bullet as a single continuous line.

Body shape when needed:
type(scope): summary

- specific outcome or invariant not stated in the subject
- another distinct outcome or invariant

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

function buildNoteContent(
  output: GenerationServices['output'],
  outputMode: OutputMode,
  parsedOut: Labels,
): string {
  if (outputMode === 'commit-only') return parsedOut.COMMIT_MESSAGE;

  return [
    `${output.style.cyanBright('BRANCH:')} ${parsedOut.BRANCH ?? 'N/A'}`,
    `${output.style.cyanBright('PR_TITLE:')} ${parsedOut.PR_TITLE ?? 'N/A'}`,
    '',
    output.style.bright('COMMIT MESSAGE:'),
    parsedOut.COMMIT_MESSAGE,
    '',
    output.style.magentaBright('PR DESCRIPTION:'),
    parsedOut.PR_DESCRIPTION ?? 'N/A',
  ].join('\n');
}

function parseAndSanitizeResponse(
  output: GenerationServices['output'],
  responseText: string,
  outputMode: OutputMode,
  logger: Logger,
): Labels | null {
  try {
    const rawParsed = parseLanguageModelOutput(responseText, outputMode);
    return {
      BRANCH: output.sanitizeGeneratedText(rawParsed.BRANCH),
      COMMIT_MESSAGE: output.sanitizeGeneratedText(rawParsed.COMMIT_MESSAGE),
      PR_TITLE: output.sanitizeGeneratedText(rawParsed.PR_TITLE),
      PR_DESCRIPTION: output.sanitizeGeneratedText(rawParsed.PR_DESCRIPTION),
    };
  } catch (error) {
    logger.log('error', `Parse failed: ${error}`);
    return null;
  }
}

async function runGenerationWorkflow(params: {
  services: GenerationServices;
  parsedArgs: ParsedOptions;
  logger: Logger;
  providerReadinessError?: string;
  canSwitchProvider?: boolean;
  targetCommit: string | null;
  state: GenerationState;
}): Promise<TerminalOutcome> {
  const {
    services,
    parsedArgs,
    logger,
    providerReadinessError,
    canSwitchProvider,
    targetCommit,
    state,
  } = params;
  logTargetCommitInfo(services.output, logger, targetCommit);
  if (canSwitchProvider && (!(parsedArgs.model && parsedArgs.mode) || providerReadinessError)) {
    const providerConfiguration = await services.dialogue.configure(state);
    if (providerConfiguration === 'exit') return 'success';
    if (typeof providerConfiguration === 'object') return providerConfiguration;
    if (providerReadinessError) {
      services.output.cancel(
        `Error: ${services.output.sanitizeTerminalText(providerReadinessError)}`,
      );
      return 'failure';
    }
  }
  const readyState = await resolveReadyRepositoryState({
    services,
    parsedArgs,
    targetCommit,
    logger,
  });
  if (!readyState) return 'failure';
  const { repositoryState, staged } = readyState;
  if (!targetCommit && isWhitespaceOnlyStagedChanges(staged)) {
    services.output.cancel(
      `Only whitespace-only staged changes detected in ${staged.stagedFiles.length} file(s). Nothing to send to AI.`,
    );
    return 'failure';
  }
  if (providerReadinessError && !canSwitchProvider) {
    services.output.cancel(
      `Error: ${services.output.sanitizeTerminalText(providerReadinessError)}`,
    );
    return 'failure';
  }
  const inspection = await services.commitActions.inspect(targetCommit, staged.snapshot);
  const preflightRepositoryState = inspection.repositoryState ?? repositoryState;
  if (reportUnresolvedConflicts(preflightRepositoryState, services.output)) return 'failure';
  if (inspection.observedSnapshotInvalid) {
    services.output.cancel(
      inspection.capability.reason ?? 'Staged changes could not be verified. Run gcm again.',
    );
    return 'failure';
  }

  showRepositoryWarnings(
    preflightRepositoryState,
    targetCommit,
    inspection.capability,
    services.output,
  );
  const preflight =
    state.nonInteractive || canSwitchProvider || (parsedArgs.model && parsedArgs.mode)
      ? 'continue'
      : await services.dialogue.configure(state);
  if (preflight === 'exit') return 'success';
  if (typeof preflight === 'object') return preflight;
  const commitCapability = {
    ...inspection.capability,
    excludedPaths: targetCommit ? [] : (staged.excludedPaths ?? []),
  };
  const meta = buildLogMetadata(staged, targetCommit);
  const commitContextHints = await resolveCommitContextHints(services, staged.stagedFiles, logger);
  const shouldContinue = state.nonInteractive
    ? true
    : await services.dialogue.confirmAtomicity(staged.stagedFiles, targetCommit);
  if (!shouldContinue) return 'success';
  return runGenerationCycle({
    services,
    logger,
    state,
    staged,
    meta,
    commitContextHints,
    targetCommit,
    commitCapability,
  });
}

function logTargetCommitInfo(
  output: GenerationServices['output'],
  logger: Logger,
  targetCommit: string | null,
): void {
  if (!targetCommit) return;
  logger.log('info', output.style.dim(`Using commit ${targetCommit} for analysis`));
}

async function resolveReadyRepositoryState(params: {
  services: GenerationServices;
  parsedArgs: ParsedOptions;
  targetCommit: string | null;
  logger: Logger;
}): Promise<{
  repositoryState: RepositoryState;
  staged: NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>>;
} | null> {
  const { services, parsedArgs, targetCommit, logger } = params;
  let repositoryState = await services.gitService.getRepositoryState(logger);
  if (reportUnresolvedConflicts(repositoryState, services.output)) return null;
  let staged = await loadStagedChanges({
    services,
    parsedArgs,
    targetCommit,
    logger,
    suppressNoChangesMessage: services.output.isInteractive,
  });

  if (!staged && !services.output.isInteractive) return null;

  while (!staged) {
    const nextStep = await services.dialogue.handleEmptyStaging(
      targetCommit,
      repositoryState.changedFiles,
    );
    if (nextStep === 'cancel') return null;
    repositoryState = await services.gitService.getRepositoryState(logger);
    if (reportUnresolvedConflicts(repositoryState, services.output)) return null;
    staged = await loadStagedChanges({
      services,
      parsedArgs,
      targetCommit,
      logger,
      suppressNoChangesMessage: true,
    });
  }

  return { repositoryState, staged };
}

function reportUnresolvedConflicts(
  repositoryState: RepositoryState,
  output: GenerationServices['output'],
): boolean {
  if (!repositoryState.hasUnmergedPaths) return false;
  output.cancel(
    'Git index has unresolved conflicts. Resolve conflicts before generating or committing.',
  );
  return true;
}

function showRepositoryWarnings(
  repositoryState: RepositoryState,
  targetCommit: string | null,
  commitCapability: CommitCapability,
  output: GenerationServices['output'],
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
  output.note(
    warnings.map((entry, idx) => `${idx + 1}. ${entry}`).join('\n'),
    'Repository warnings',
  );
}

function buildLogMetadata(
  staged: NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>>,
  targetCommit: string | null,
): LogMetadata {
  return {
    targetCommit: targetCommit ?? null,
    numFiles: staged.stagedFiles.length,
    origLen: staged.stagedDiff.length,
    truncated: staged.truncated,
  };
}

async function loadStagedChanges(params: {
  services: GenerationServices;
  parsedArgs: ParsedOptions;
  targetCommit: string | null;
  logger: Logger;
  suppressNoChangesMessage?: boolean;
}): Promise<NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>> | null> {
  const { services, parsedArgs, targetCommit, logger, suppressNoChangesMessage } = params;
  services.output.startProgress('Analyzing repository changes...');
  const staged = await services.gitService.retrieveStagedChanges(
    targetCommit,
    logger,
    parsedArgs.exclude,
  );
  if (!staged) {
    services.output.stopProgress(services.output.style.yellow('No staged changes found'));
    if (!suppressNoChangesMessage) {
      services.output.cancel('No staged changes found. Use "git add" to stage files.');
    }
    return null;
  }
  if (!targetCommit && isWhitespaceOnlyStagedChanges(staged)) {
    services.output.stopProgress(
      services.output.style.yellow(
        `Found ${staged.stagedFiles.length} staged file(s), but only whitespace changes`,
      ),
    );
    return staged;
  }
  services.output.stopProgress(`Found ${staged.stagedFiles.length} file(s) changed`);
  return staged;
}

function isWhitespaceOnlyStagedChanges(
  staged: NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>>,
): boolean {
  return staged.stagedFiles.length > 0 && staged.stagedDiff.trim().length === 0;
}

async function resolveCommitContextHints(
  services: GenerationServices,
  stagedFiles: string[],
  logger: Logger,
): Promise<CommitContextHints> {
  try {
    return await services.getCommitContextHints(stagedFiles);
  } catch (error) {
    logger.log('debug', 'Failed to get commit context hints', { error: String(error) });
    return { scopeSuggestions: [], recentCommitSubjects: [] };
  }
}

async function runGenerationCycle(params: {
  services: GenerationServices;
  logger: Logger;
  state: GenerationState;
  staged: NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>>;
  meta: LogMetadata;
  commitContextHints: CommitContextHints;
  targetCommit: string | null;
  commitCapability: CommitCapability;
}): Promise<TerminalOutcome> {
  const {
    services,
    logger,
    state,
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
      state,
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
  services: GenerationServices;
  logger: Logger;
  state: GenerationState;
  staged: NonNullable<Awaited<ReturnType<GitService['retrieveStagedChanges']>>>;
  meta: LogMetadata;
  commitContextHints: CommitContextHints;
  targetCommit: string | null;
  commitCapability: CommitCapability;
}): Promise<TerminalOutcome | 'regenerate'> {
  const {
    services,
    logger,
    state,
    staged,
    meta,
    commitContextHints,
    targetCommit,
    commitCapability,
  } = params;
  const modelSpec = services.getModelSpec(state.modelName);
  const modelSpecError = getModelSpecValidationError(modelSpec, state.modelName);
  if (modelSpecError) {
    services.output.cancel(`Error: ${modelSpecError}.`);
    return 'failure';
  }
  const configuredMaxOutputTokens =
    Number.isSafeInteger(CONFIG.MAX_OUTPUT_TOKENS) && CONFIG.MAX_OUTPUT_TOKENS > 0
      ? CONFIG.MAX_OUTPUT_TOKENS
      : DEFAULT_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = Math.min(configuredMaxOutputTokens, modelSpec.maxOutputTokens);
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
  services.output.startProgress(`Generating commit message with ${state.modelName}...`);
  const systemPrompt =
    state.outputMode === 'full' ? SYSTEM_INSTRUCTIONS_FULL : SYSTEM_INSTRUCTIONS_COMMIT_ONLY;
  const response = await services.languageModelService.generate({
    promptContext: contextResult.promptContext,
    promptParts: contextResult.promptParts,
    summaryAttempted: contextResult.summaryAttempted,
    systemPrompt,
    reduceForRetry: function (params) {
      return services.contextService.reduceForRetry({
        ...params,
        stagedFiles: staged.stagedFiles,
      });
    },
    meta,
    opts: {
      modelOverride: state.modelName,
      retryIfTruncated: true,
      retryIfTruncatedMaxRetries: 1,
      retryIfTruncatedIncreaseTokens: maxOutputTokens,
    },
  });
  services.output.stopProgress(`${services.providerLabel} response received`);
  if (!response) {
    logger.log(
      'warn',
      `${services.providerLabel} did not return text after retries; using deterministic fallback`,
    );
    displayResultStructured(
      services.output,
      logger,
      generateFallbackCommitDetails(staged.stagedFiles, services.providerLabel),
    );
    if (state.nonInteractive && state.apply) {
      services.output.cancel('No generated commit message was available to apply.');
      return 'failure';
    }
    return 'success';
  }
  const action = await handleSuccessfulGeneration({
    response,
    state,
    logger,
    services,
    meta,
    commitCapability,
  });
  return action;
}

async function handleSuccessfulGeneration(params: {
  response: NonNullable<Awaited<ReturnType<LanguageModelService['generate']>>>;
  state: GenerationState;
  logger: Logger;
  services: GenerationServices;
  meta: LogMetadata;
  commitCapability: CommitCapability;
}): Promise<TerminalOutcome | 'regenerate'> {
  const { response, state, logger, services, meta, commitCapability } = params;
  logger.log('debug', 'LLM response received', {
    promptTokens: response.usage.promptTokens,
    outputTokens: response.usage.outputTokens,
    ...meta,
  });
  const parsedOut = parseAndSanitizeResponse(
    services.output,
    response.text,
    state.outputMode,
    logger,
  );
  if (!parsedOut) {
    logger.log('info', services.output.sanitizeTerminalText(response.text));
    services.output.outro('Failed to parse structured output.');
    return 'failure';
  }
  const warningIcon = response.truncated ? ` ${services.output.style.yellow('[⚠ ZKRACENO]')}` : '';
  services.output.note(
    buildNoteContent(services.output, state.outputMode, parsedOut),
    (state.outputMode === 'full' ? 'Generated Report' : 'Generated Commit Message') + warningIcon,
  );
  reportStats(services.output, logger, state.modelName, response.usage, response.text.length);
  if (state.nonInteractive) {
    if (!state.apply) return 'success';
    return commitGeneratedMessage({
      commitMessage: parsedOut.COMMIT_MESSAGE,
      commitCapability,
      services,
      state,
      logger,
    });
  }
  const actionResult: ActionMenuResult = await services.dialogue.review({
    state,
    result: parsedOut,
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
  });
}

async function commitGeneratedMessage(params: {
  commitMessage: string;
  commitCapability: CommitCapability;
  services: GenerationServices;
  state: GenerationState;
  logger: Logger;
}): Promise<TerminalOutcome> {
  const { commitMessage, commitCapability, services, state, logger } = params;
  const verb = commitCapability.mode === 'commit' ? 'Committing changes' : commitCapability.mode;
  services.output.startProgress(`${verb}...`);
  try {
    const { summary } = await services.commitActions.apply(commitCapability, commitMessage);
    await services.saveSession({
      providerId: services.providerId,
      modelName: state.baselineModelName,
      outputMode: state.outputMode,
    });
    services.output.stopProgress('Done');
    services.output.outro(services.output.style.cyan(summary));
  } catch (error) {
    services.output.stopProgress('Failed');
    services.output.cancel(
      isCommitActionRefusal(error)
        ? error.message
        : `Failed to apply commit action: ${error instanceof Error ? error.message : String(error)}`,
    );
    logger.log('error', `Commit action failed: ${error}`);
    return 'failure';
  }
  return 'success';
}
