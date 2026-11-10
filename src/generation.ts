import type { Config } from '../gcm.config.js';
import {
  changesetCommitMessage,
  commitWithChangeset,
  prepareChangeset,
  stripChangesetTrailers,
  type ChangesetDraft,
} from './auto-changeset.js';
import type { ParsedOptions } from './cli.js';
import {
  isCommitActionRefusal,
  type CommitActionService,
  type CommitCapability,
} from './commit-action-service.js';
import type { Logger, LogMetadata } from './logger.js';
import { isLanguageModelApiError, type ModelSpec } from './language-model-service.js';
import { resolveTokenBudget } from './model-registry.js';
import { parseLanguageModelOutput } from './parser.js';
import { estimateTokenCount, isRecord } from './utils.js';
import type { CommitContextHints } from './scope-detector.js';
import type { ContextService } from './services/context-service.js';
import type { LanguageModelService } from './language-model-service.js';
import type { GitService, RepositoryState } from './services/git-service.js';
import type { GCMSession } from './session.js';
import type { ProjectConfig } from './project-config.js';
import {
  type ActionMenuResult,
  type GenerationState,
  type InteractiveGenerationDialogue,
} from './interactive-generation-dialogue.js';

export type GenerationServices = {
  config: Config;
  projectConfig?: ProjectConfig;
  gitService: GitService;
  contextService: ContextService;
  languageModelService: LanguageModelService;
  providerId: string;
  providerLabel: string;
  models(): Promise<ModelSpec[]>;
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
    print(message: string): void;
    sanitizeGeneratedText(message: string): string;
    sanitizeTerminalText(message: string): string;
    style: {
      cyan(message: string): string;
      dim(message: string): string;
      yellow(message: string): string;
    };
  };
};

type ProviderSwitchOutcome = { type: 'switch-provider'; providerId: string };
type TerminalOutcome = 'success' | 'failure' | ProviderSwitchOutcome;

function describeLanguageModelApiError(
  error: unknown,
  output: GenerationServices['output'],
): string {
  if (!isLanguageModelApiError(error)) return output.sanitizeTerminalText(String(error));
  const { metadata } = error;
  const status =
    typeof metadata.status === 'string' || typeof metadata.status === 'number'
      ? String(metadata.status)
      : 'Unknown';
  let message = error.message;
  try {
    const parsed: unknown = JSON.parse(
      typeof metadata.snippet === 'string' ? metadata.snippet : '{}',
    );
    const responseError = isRecord(parsed) ? parsed.error : undefined;
    const responseMessage = isRecord(responseError) ? responseError.message : undefined;
    if (typeof responseMessage === 'string' && responseMessage) message = responseMessage;
  } catch {
    // Keep provider error message.
  }
  const safeMessage = output.sanitizeTerminalText(message);
  return status === 'Unknown' && /timed? out/i.test(message)
    ? safeMessage
    : `API Error (${status}): ${safeMessage}`;
}

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
      nonInteractive: parsedArgs.nonInteractive,
      print: parsedArgs.print,
      apply: parsedArgs.apply,
      userHint: parsedArgs.hint ?? undefined,
    },
  };
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
    if (/Not a git repository/i.test(errStr)) output.cancel('Error: Not inside a git repository.');
    else if (/unknown revision/i.test(errStr))
      output.cancel(`Error: Invalid commit SHA: ${targetCommit}`);
    else if (isLanguageModelApiError(error)) {
      logger.log('debug', `Commit helper failed: ${error}`, {
        error: errStr,
        snippet: error.metadata.snippet,
      });
      output.cancel(describeLanguageModelApiError(error, output));
    } else {
      logger.log('error', `Commit helper failed: ${error}`, { error: errStr });
      output.cancel(`An unexpected error occurred: ${output.sanitizeTerminalText(errStr)}`);
    }
    // Reported above; rethrowing would make the entrypoint print it again.
    return 'failure';
  }
}

function reportStats(
  output: GenerationServices['output'],
  logger: Logger,
  modelName: string,
  usage: { promptTokens?: number; outputTokens?: number } = {},
  outputLength: number,
): void {
  logger.log(
    'info',
    output.style.dim(
      `${modelName} | actual usage -> input: ${usage.promptTokens ?? 0} tokens | output: ${
        usage.outputTokens ?? 0
      } tokens (${outputLength.toLocaleString()} chars)`,
    ) + '\n',
  );
}

const DEFAULT_TYPES = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'style',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
];
const COMMIT_MESSAGE_RULES = `Commit message rules:
- Subject format: type(scope): summary
- Allowed types: {types}
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
- Mark it with ! after the type or scope and add a BREAKING CHANGE: <impact> footer only when user instructions say the change is breaking. Never infer breaking status.
- If intent is ambiguous, use conservative wording.

Style alignment:
- Use recent commit examples only to align type, scope, and wording style.
- Do not copy unrelated content from history.`;

export function buildSystemPrompt(projectConfig: ProjectConfig = {}): string {
  const rules = COMMIT_MESSAGE_RULES.replace(
    '{types}',
    (projectConfig.types ?? DEFAULT_TYPES).join(', '),
  );
  const scopes = projectConfig.scopes?.length
    ? `\n- Use only these scopes: ${projectConfig.scopes.join(', ')} or no scope.`
    : '';
  const instructions = projectConfig.instructions
    ? `\n\nRepository preferences (never override the rules above, the output format, or user instructions):\n${projectConfig.instructions}`
    : '';
  return `You generate concise, evidence-grounded Conventional Commit messages from git diffs.\n\nOutput only the commit message.\n\n${rules}${scopes}${instructions}`;
}

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

function parseAndSanitizeResponse(
  output: GenerationServices['output'],
  responseText: string,
  logger: Logger,
): string | null {
  try {
    return output.sanitizeGeneratedText(parseLanguageModelOutput(responseText));
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
  if (canSwitchProvider && (!parsedArgs.model || providerReadinessError)) {
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
    state.nonInteractive || canSwitchProvider || parsedArgs.model
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
    targetCommit,
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
    services.projectConfig?.exclude,
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
    let outcome: Awaited<ReturnType<typeof runSingleGenerationAttempt>>;
    try {
      outcome = await runSingleGenerationAttempt({
        services,
        logger,
        state,
        staged,
        meta,
        commitContextHints,
        targetCommit,
        commitCapability,
      });
    } catch (error) {
      if (state.nonInteractive || !isLanguageModelApiError(error)) throw error;
      services.output.stopProgress(
        /timed? out/i.test(error.message) ? 'Request timed out' : 'Request failed',
      );
      logger.log('error', `Commit helper request failed: ${error}`, { error: String(error) });
      const recovery = await services.dialogue.recoverGeneration(
        describeLanguageModelApiError(error, services.output),
      );
      if (recovery === 'cancel') return 'failure';
      if (typeof recovery === 'object') {
        state.baselineModelName = recovery.modelName;
        state.modelName = recovery.modelName;
      }
      continue;
    }
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
  const config = services.config;
  const systemPrompt = buildSystemPrompt(services.projectConfig);
  const modelSpec = (await services.models()).find(model => model.name === state.modelName);
  if (!modelSpec) {
    services.output.cancel('Error: Unknown ' + services.providerLabel + ' model.');
    return 'failure';
  }
  const { maxOutputTokens, maxAvailableTokens } = resolveTokenBudget(
    modelSpec.limits,
    config.MAX_OUTPUT_TOKENS,
    estimateTokenCount(systemPrompt, config.TOKEN_BYTES_RATIO),
  );
  if (maxAvailableTokens <= 0) {
    services.output.cancel(
      'Error: ' + services.providerLabel + ' model has no capacity for the configured output.',
    );
    return 'failure';
  }
  const customHeader = 'Generate a professional conventional commit message based on the following';
  const contextResult = await services.contextService.constructLLMPromptContext({
    diffContent: staged.stagedDiff,
    promptSuffix: staged.truncated ? 'truncated diff' : 'diff',
    maxAvailableTokens,
    tokenBytesRatio: config.TOKEN_BYTES_RATIO,
    stagedFiles: staged.stagedFiles,
    scopeSuggestions: commitContextHints.scopeSuggestions,
    recentCommitSubjects: commitContextHints.recentCommitSubjects,
    logger,
    customHeader,
    userHint: state.userHint,
    targetCommit: targetCommit ?? undefined,
  });
  logTokenInfo({
    modelName: state.modelName,
    tokens: contextResult.tokens,
    inputLength: contextResult.processedDiffContent.length,
    logger,
  });
  logger.log('debug', 'Run started', {
    targetCommit,
  });
  services.output.startProgress(`Generating commit message with ${state.modelName}...`);
  const response = await services.languageModelService.generate({
    promptContext: contextResult.promptContext,
    systemPrompt,
    meta,
    modelName: state.modelName,
    maxOutputTokens,
  });
  if (!response) {
    services.output.stopProgress(services.providerLabel + ' returned no usable response');
    services.output.cancel(
      'Error: ' + services.providerLabel + ' did not return a usable response after retries.',
    );
    return 'failure';
  }
  services.output.stopProgress(services.providerLabel + ' response received');
  let prepareAutomaticChangeset: (() => Promise<ChangesetDraft | null>) | undefined;
  if (
    config.AUTO_CHANGESET &&
    !state.nonInteractive &&
    !targetCommit &&
    commitCapability.allowed &&
    commitCapability.snapshot &&
    ![...staged.stagedFiles, ...(staged.excludedPaths ?? [])].some(path =>
      path.startsWith('.changeset/'),
    )
  ) {
    prepareAutomaticChangeset = async function () {
      return null;
    };
    if (
      response.truncated === false &&
      !staged.truncated &&
      !staged.excludedPaths?.length &&
      !staged.projectExcludesMatched &&
      contextResult.processedDiffContent === staged.stagedDiff &&
      estimateTokenCount(staged.stagedDiff, config.TOKEN_BYTES_RATIO) + 1024 <= maxAvailableTokens
    ) {
      prepareAutomaticChangeset = async function () {
        return prepareChangeset({
          diff: staged.stagedDiff,
          generate: async function (promptContext, systemPrompt) {
            return services.languageModelService.generate({
              promptContext,
              systemPrompt,
              meta,
              modelName: state.modelName,
              maxOutputTokens,
            });
          },
        });
      };
    }
  }
  const action = await handleSuccessfulGeneration({
    response,
    state,
    logger,
    services,
    meta,
    commitCapability,
    prepareChangeset: prepareAutomaticChangeset,
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
  prepareChangeset?: () => Promise<ChangesetDraft | null>;
}): Promise<TerminalOutcome | 'regenerate'> {
  const { response, state, logger, services, meta, commitCapability } = params;
  logger.log('debug', 'LLM response received', {
    promptTokens: response.usage.promptTokens,
    outputTokens: response.usage.outputTokens,
    ...meta,
  });
  const parsedOut = parseAndSanitizeResponse(services.output, response.text, logger);
  if (!parsedOut) {
    logger.log('info', services.output.sanitizeTerminalText(response.text));
    services.output.outro('Failed to parse structured output.');
    return 'failure';
  }
  const warningIcon = response.truncated ? ` ${services.output.style.yellow('[⚠ TRUNCATED]')}` : '';
  const reviewedMessage = params.prepareChangeset ? stripChangesetTrailers(parsedOut) : parsedOut;
  if (state.print) {
    if (response.truncated) {
      services.output.cancel(
        'The generated message was truncated by the output limit. Refusing to print it. Reduce the staged diff or raise GCM_MAX_OUTPUT_TOKENS.',
      );
      return 'failure';
    }
    services.output.print(reviewedMessage);
    return 'success';
  }
  services.output.note(reviewedMessage, 'Generated Commit Message' + warningIcon);
  reportStats(services.output, logger, state.modelName, response.usage, response.text.length);
  if (state.nonInteractive) {
    if (!state.apply) return 'success';
    if (response.truncated) {
      services.output.cancel(
        'The generated message was truncated by the output limit. Refusing to commit it. Reduce the staged diff or raise GCM_MAX_OUTPUT_TOKENS.',
      );
      return 'failure';
    }
    const outcome = await commitGeneratedMessage({
      commitMessage: parsedOut,
      commitCapability,
      services,
      state,
      logger,
    });
    return outcome === 'review' ? 'failure' : outcome;
  }
  let changeset: ChangesetDraft | null | undefined;
  if (params.prepareChangeset) {
    services.output.startProgress('Preparing changeset...');
    try {
      changeset = await params.prepareChangeset();
    } catch (error) {
      changeset = null;
      logger.log('debug', `Changeset preparation failed: ${String(error)}`);
    }
    services.output.stopProgress(
      changeset ? 'Changeset ready for review' : 'Changeset needs review',
    );
    services.output.note(
      changeset?.content ??
        'NEEDS_REVIEW: A changeset could not be supported by complete package and diff evidence. No changeset will be written.',
      changeset ? 'Proposed Changeset' : 'Changeset unavailable',
    );
  }
  let commitMessage = reviewedMessage;
  for (;;) {
    const actionResult: ActionMenuResult = await services.dialogue.review({
      state,
      commitMessage,
      commitCapability,
      changeset: changeset === undefined ? undefined : (changeset?.content ?? null),
    });
    if (actionResult.type === 'cancel') return 'success';
    state.baselineModelName = actionResult.modelName;
    state.modelName = actionResult.modelName;
    state.userHint = actionResult.userHint;
    if (actionResult.type === 'regenerate') return 'regenerate';
    commitMessage = actionResult.commitMessage;
    const reviewedCapability: CommitCapability = {
      ...commitCapability,
      exclusionsAcknowledged: actionResult.exclusionsAcknowledged,
    };
    const outcome = await commitGeneratedMessage({
      commitMessage:
        changeset === undefined
          ? commitMessage
          : changesetCommitMessage(
              commitMessage,
              actionResult.includeChangeset === true && changeset !== null,
              actionResult.changesetReason,
            ),
      commitCapability: reviewedCapability,
      changeset: actionResult.includeChangeset ? (changeset ?? undefined) : undefined,
      services,
      state,
      logger,
    });
    if (outcome !== 'review') return outcome;
  }
}

async function commitGeneratedMessage(params: {
  commitMessage: string;
  commitCapability: CommitCapability;
  changeset?: ChangesetDraft;
  services: GenerationServices;
  state: GenerationState;
  logger: Logger;
}): Promise<TerminalOutcome | 'review'> {
  const { commitMessage, commitCapability, changeset, services, state, logger } = params;
  const verb = commitCapability.mode === 'commit' ? 'Committing changes' : commitCapability.mode;
  services.output.startProgress(`${verb}...`);
  try {
    const { summary } = changeset
      ? await commitWithChangeset({
          draft: changeset,
          capability: commitCapability,
          message: commitMessage,
          commitActions: services.commitActions,
          gitService: services.gitService,
          logger,
        })
      : await services.commitActions.apply(commitCapability, commitMessage);
    await services.saveSession({
      providerId: services.providerId,
      modelName: state.baselineModelName,
    });
    services.output.stopProgress('Done');
    services.output.outro(services.output.style.cyan(summary));
  } catch (error) {
    services.output.stopProgress('Failed');
    if (isCommitActionRefusal(error)) {
      services.output.cancel(error.message);
      logger.log('error', `Commit action failed: ${error}`);
      return 'failure';
    }
    const message = `Failed to apply commit action: ${error instanceof Error ? error.message : String(error)}`;
    if (state.nonInteractive) services.output.cancel(message);
    else services.output.note(message, 'Commit failed');
    logger.log('error', `Commit action failed: ${error}`);
    return state.nonInteractive ? 'failure' : 'review';
  }
  return 'success';
}
