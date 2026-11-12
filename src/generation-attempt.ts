import type { ChangesetDraft } from './auto-changeset.js';
import {
  commitWithChangeset,
  reviewedChangesetCommit,
  stripChangesetTrailers,
} from './auto-changeset.js';
import { isCommitActionRefusal } from './commit-action-service.js';
import type { CommitCapability } from './commit-capability.js';
import {
  createAutomaticChangesetPreparation,
  reportEmptyResponse,
  resolveGenerationTokenBudget,
} from './generation-changeset.js';
import { buildSystemPrompt } from './generation-prompt.js';
import type {
  GenerationServices,
  TerminalOutcome,
} from './generation-types.js';
import type {
  ActionMenuResult,
  GenerationState,
} from './interactive-generation-dialogue.js';
import type { LanguageModelResponse } from './language-model-service.js';
import type { LogMetadata, Logger } from './logger.js';
import { parseLanguageModelOutput } from './parser.js';
import type { CommitContextHints } from './scope-detector.js';
import type { StagedChangesResult } from './services/git-service.js';

function reportStats(params: {
  output: GenerationServices['output'];
  logger: Logger;
  modelName: string;
  usage?: { promptTokens?: number; outputTokens?: number };
  outputLength: number;
}): void {
  const { output, logger, modelName, usage = {}, outputLength } = params;
  logger.log(
    'info',
    `${output.style.dim(
      `${modelName} | actual usage -> input: ${usage.promptTokens ?? 0} tokens | output: ${
        usage.outputTokens ?? 0
      } tokens (${outputLength.toLocaleString()} chars)`,
    )}\n`,
  );
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
    logger.log('error', `Parse failed: ${String(error)}`);
    return null;
  }
}

export async function runSingleGenerationAttempt(params: {
  services: GenerationServices;
  logger: Logger;
  state: GenerationState;
  staged: StagedChangesResult;
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
  const systemPrompt = buildSystemPrompt(services.projectConfig);
  const tokenBudget = await resolveGenerationTokenBudget(
    services,
    state,
    systemPrompt,
  );
  if (tokenBudget === null) {
    return 'failure';
  }
  const { maxOutputTokens, maxAvailableTokens } = tokenBudget;
  const contextResult = await services.contextService.constructLLMPromptContext(
    {
      diffContent: staged.stagedDiff,
      promptSuffix: staged.truncated ? 'truncated diff' : 'diff',
      maxAvailableTokens,
      tokenBytesRatio: services.config.TOKEN_BYTES_RATIO,
      stagedFiles: staged.stagedFiles,
      scopeSuggestions: commitContextHints.scopeSuggestions,
      recentCommitSubjects: commitContextHints.recentCommitSubjects,
      logger,
      customHeader:
        'Generate a professional conventional commit message based on the following',
      userHint: state.userHint,
      targetCommit: targetCommit ?? undefined,
    },
  );
  logTokenInfo({
    modelName: state.modelName,
    tokens: contextResult.tokens,
    inputLength: contextResult.processedDiffContent.length,
    logger,
  });
  logger.log('debug', 'Run started', { targetCommit });
  services.output.startProgress(
    `Generating commit message with ${state.modelName}...`,
  );
  const response = await services.languageModelService.generate({
    promptContext: contextResult.promptContext,
    systemPrompt,
    meta,
    modelName: state.modelName,
    maxOutputTokens,
  });
  if (reportEmptyResponse(response, services)) {
    return 'failure';
  }
  services.output.stopProgress(`${services.providerLabel} response received`);
  return await handleSuccessfulGeneration({
    response,
    state,
    logger,
    services,
    meta,
    commitCapability,
    prepareChangeset: createAutomaticChangesetPreparation({
      services,
      state,
      staged,
      targetCommit,
      commitCapability,
      responseTruncated: response.truncated,
      processedDiffContent: contextResult.processedDiffContent,
      maxAvailableTokens,
      maxOutputTokens,
      meta,
    }),
  });
}

interface SuccessfulGenerationOptions {
  response: LanguageModelResponse;
  state: GenerationState;
  logger: Logger;
  services: GenerationServices;
  meta: LogMetadata;
  commitCapability: CommitCapability;
  prepareChangeset?: () => Promise<ChangesetDraft | null>;
}

async function handleSuccessfulGeneration(
  params: SuccessfulGenerationOptions,
): Promise<TerminalOutcome | 'regenerate'> {
  const { response, state, logger, services, meta, commitCapability } = params;
  logger.log('debug', 'LLM response received', {
    promptTokens: response.usage.promptTokens,
    outputTokens: response.usage.outputTokens,
    ...meta,
  });
  const parsedOut = parseAndSanitizeResponse(
    services.output,
    response.text,
    logger,
  );
  if (parsedOut === null) {
    logger.log('info', services.output.sanitizeTerminalText(response.text));
    services.output.cancel('Failed to parse structured output.');
    return 'failure';
  }
  const reviewedMessage =
    params.prepareChangeset === undefined
      ? parsedOut
      : stripChangesetTrailers(parsedOut);
  const directOutcome = await handleDirectOutput({
    response,
    parsedOut,
    reviewedMessage,
    state,
    logger,
    services,
    commitCapability,
  });
  if (directOutcome !== null) {
    return directOutcome;
  }
  const changeset = await prepareChangesetForReview(
    params.prepareChangeset,
    services,
    logger,
  );
  return await reviewGeneratedMessage({
    reviewedMessage,
    changeset,
    state,
    services,
    logger,
    commitCapability,
  });
}

async function handleDirectOutput(params: {
  response: LanguageModelResponse;
  parsedOut: string;
  reviewedMessage: string;
  state: GenerationState;
  logger: Logger;
  services: GenerationServices;
  commitCapability: CommitCapability;
}): Promise<TerminalOutcome | null> {
  const { response, state, logger, services, commitCapability } = params;
  if (state.print === true) {
    if (response.truncated === true) {
      services.output.cancel(
        'The generated message was truncated by the output limit. Refusing to print it. Reduce the staged diff or raise GCM_MAX_OUTPUT_TOKENS.',
      );
      return 'failure';
    }
    services.output.print(params.reviewedMessage);
    return 'success';
  }
  const warningIcon =
    response.truncated === true
      ? ` ${services.output.style.yellow('[⚠ TRUNCATED]')}`
      : '';
  services.output.note(
    params.reviewedMessage,
    `Generated Commit Message${warningIcon}`,
  );
  reportStats({
    output: services.output,
    logger,
    modelName: state.modelName,
    usage: response.usage,
    outputLength: response.text.length,
  });
  if (state.nonInteractive !== true) {
    return null;
  }
  if (state.apply !== true) {
    return 'success';
  }
  if (response.truncated === true) {
    services.output.cancel(
      'The generated message was truncated by the output limit. Refusing to commit it. Reduce the staged diff or raise GCM_MAX_OUTPUT_TOKENS.',
    );
    return 'failure';
  }
  const outcome = await commitGeneratedMessage({
    commitMessage: params.parsedOut,
    commitCapability,
    services,
    state,
    logger,
  });
  return outcome === 'review' ? 'failure' : outcome;
}

async function prepareChangesetForReview(
  prepareChangeset: (() => Promise<ChangesetDraft | null>) | undefined,
  services: GenerationServices,
  logger: Logger,
): Promise<ChangesetDraft | null | undefined> {
  if (prepareChangeset === undefined) {
    return undefined;
  }
  services.output.startProgress('Preparing changeset...');
  const changeset = await loadPreparedChangeset(prepareChangeset, logger);
  services.output.stopProgress(
    changeset === null
      ? 'Changeset needs review'
      : 'Changeset ready for review',
  );
  services.output.note(
    changeset?.content ??
      'NEEDS_REVIEW: A changeset could not be supported by complete package and diff evidence. No changeset will be written.',
    changeset === null ? 'Changeset unavailable' : 'Proposed Changeset',
  );
  return changeset;
}

async function loadPreparedChangeset(
  prepareChangeset: () => Promise<ChangesetDraft | null>,
  logger: Logger,
): Promise<ChangesetDraft | null> {
  try {
    return await prepareChangeset();
  } catch (error) {
    logger.log('debug', `Changeset preparation failed: ${String(error)}`);
    return null;
  }
}

async function reviewGeneratedMessage(params: {
  reviewedMessage: string;
  changeset: ChangesetDraft | null | undefined;
  state: GenerationState;
  services: GenerationServices;
  logger: Logger;
  commitCapability: CommitCapability;
}): Promise<TerminalOutcome | 'regenerate'> {
  const {
    reviewedMessage,
    changeset,
    state,
    services,
    logger,
    commitCapability,
  } = params;
  const changesetText =
    changeset === undefined ? undefined : (changeset?.content ?? null);
  let commitMessage = reviewedMessage;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- review prompts must remain ordered
    const actionResult: ActionMenuResult = await services.dialogue.review({
      state,
      commitMessage,
      commitCapability,
      changeset: changesetText,
    });
    if (actionResult.type === 'cancel') {
      return 'success';
    }
    const { modelName, userHint } = actionResult;
    state.baselineModelName = modelName;
    state.modelName = modelName;
    state.userHint = userHint;
    if (actionResult.type === 'regenerate') {
      return 'regenerate';
    }
    ({ commitMessage } = actionResult);
    const reviewedCapability: CommitCapability = {
      ...commitCapability,
      exclusionsAcknowledged: actionResult.exclusionsAcknowledged,
    };
    const commit = reviewedChangesetCommit(
      commitMessage,
      changeset,
      actionResult,
    );
    // eslint-disable-next-line no-await-in-loop -- commit attempt must follow review prompt
    const outcome = await commitGeneratedMessage({
      commitMessage: commit.message,
      commitCapability: reviewedCapability,
      changeset: commit.changeset,
      services,
      state,
      logger,
    });
    if (outcome !== 'review') {
      return outcome;
    }
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
  const {
    commitMessage,
    commitCapability,
    changeset,
    services,
    state,
    logger,
  } = params;
  const verb =
    commitCapability.mode === 'commit'
      ? 'Committing changes'
      : commitCapability.mode;
  services.output.startProgress(`${verb}...`);
  try {
    const { summary } =
      changeset === undefined
        ? await services.commitActions.apply(commitCapability, commitMessage)
        : await commitWithChangeset({
            draft: changeset,
            capability: commitCapability,
            message: commitMessage,
            commitActions: services.commitActions,
            gitService: services.gitService,
            logger,
          });
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
    if (state.nonInteractive === true) {
      services.output.cancel(message);
    } else {
      services.output.warn(message, 'Commit failed');
    }
    logger.log('error', `Commit action failed: ${String(error)}`);
    return state.nonInteractive === true ? 'failure' : 'review';
  }
  return 'success';
}
