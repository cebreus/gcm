import type { ParsedOptions } from './cli.js';
import type { CommitCapability } from './commit-capability.js';
import { runSingleGenerationAttempt } from './generation-attempt.js';
import { describeLanguageModelApiError } from './generation-errors.js';
import type {
  GenerationServices,
  TerminalOutcome,
} from './generation-types.js';
import type { GenerationState } from './interactive-generation-dialogue.js';
import {
  hasLanguageModelErrorKind,
  isLanguageModelApiError,
} from './language-model-service.js';
import type { LogMetadata, Logger } from './logger.js';
import type { CommitContextHints } from './scope-detector.js';
import type {
  RepositoryState,
  StagedChangesResult,
} from './services/git-service.js';
import { hasText } from './utils.js';

export async function runGenerationWorkflow(params: {
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
  const readyState = await resolveReadyRepositoryState({
    services,
    parsedArgs,
    targetCommit,
    logger,
  });
  if (readyState === null) {
    return 'failure';
  }
  const { repositoryState, staged } = readyState;
  if (
    reportBlockingProviderError(
      providerReadinessError,
      canSwitchProvider,
      services.output,
    )
  ) {
    return 'failure';
  }
  const inspection = await services.commitActions.inspect(
    targetCommit,
    staged.snapshot,
  );
  const preflightRepositoryState =
    inspection.repositoryState ?? repositoryState;
  if (
    reportInvalidInspection(
      preflightRepositoryState,
      inspection.observedSnapshotInvalid,
      inspection.capability,
      services.output,
    )
  ) {
    return 'failure';
  }

  showRepositoryWarnings(
    preflightRepositoryState,
    targetCommit,
    inspection.capability,
    services.output,
  );
  const configurationOutcome = await configureGeneration({
    services,
    parsedArgs,
    state,
    providerReadinessError,
    canSwitchProvider,
  });
  if (configurationOutcome !== null) {
    return configurationOutcome;
  }
  const commitCapability = {
    ...inspection.capability,
    excludedPaths: targetCommit === null ? (staged.excludedPaths ?? []) : [],
  };
  const meta = buildLogMetadata(staged, targetCommit);
  const commitContextHints = await resolveCommitContextHints(
    services,
    staged.stagedFiles,
    logger,
  );
  const shouldContinue =
    state.nonInteractive === true ||
    (await services.dialogue.confirmAtomicity(
      staged.stagedFiles,
      targetCommit,
    ));
  if (!shouldContinue) {
    return 'success';
  }
  return await runGenerationCycle({
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

function reportBlockingProviderError(
  providerReadinessError: string | undefined,
  canSwitchProvider: boolean | undefined,
  output: GenerationServices['output'],
): boolean {
  if (providerReadinessError === undefined || canSwitchProvider === true) {
    return false;
  }
  output.cancel(
    `Error: ${output.sanitizeTerminalText(providerReadinessError)}`,
  );
  return true;
}

function reportInvalidInspection(
  repositoryState: RepositoryState,
  observedSnapshotInvalid: boolean | undefined,
  capability: CommitCapability,
  output: GenerationServices['output'],
): boolean {
  if (reportUnresolvedConflicts(repositoryState, output)) {
    return true;
  }
  if (observedSnapshotInvalid !== true) {
    return false;
  }
  output.cancel(
    capability.reason ?? 'Staged changes could not be verified. Run gcm again.',
  );
  return true;
}

async function configureGeneration(params: {
  services: GenerationServices;
  parsedArgs: ParsedOptions;
  state: GenerationState;
  providerReadinessError?: string;
  canSwitchProvider?: boolean;
}): Promise<TerminalOutcome | null> {
  const {
    services,
    parsedArgs,
    state,
    providerReadinessError,
    canSwitchProvider,
  } = params;
  const shouldConfigure =
    canSwitchProvider === true
      ? parsedArgs.model === null || providerReadinessError !== undefined
      : state.nonInteractive !== true && parsedArgs.model === null;
  const preflight = shouldConfigure
    ? await services.dialogue.configure(state)
    : 'continue';
  if (preflight === 'exit') {
    return 'success';
  }
  if (typeof preflight === 'object') {
    return preflight;
  }
  if (providerReadinessError === undefined) {
    return null;
  }
  services.output.cancel(
    `Error: ${services.output.sanitizeTerminalText(providerReadinessError)}`,
  );
  return 'failure';
}

function logTargetCommitInfo(
  output: GenerationServices['output'],
  logger: Logger,
  targetCommit: string | null,
): void {
  if (!hasText(targetCommit)) {
    return;
  }
  logger.log(
    'info',
    output.style.dim(`Using commit ${targetCommit} for analysis`),
  );
}

async function resolveReadyRepositoryState(params: {
  services: GenerationServices;
  parsedArgs: ParsedOptions;
  targetCommit: string | null;
  logger: Logger;
}): Promise<{
  repositoryState: RepositoryState;
  staged: StagedChangesResult;
} | null> {
  const { services, parsedArgs, targetCommit, logger } = params;
  let repositoryState = await services.gitService.getRepositoryState(logger);
  if (reportUnresolvedConflicts(repositoryState, services.output)) {
    return null;
  }
  let staged = await loadStagedChanges({
    services,
    parsedArgs,
    targetCommit,
    logger,
    suppressNoChangesMessage: services.output.isInteractive,
  });

  if (staged === null && !services.output.isInteractive) {
    return null;
  }

  while (staged === null) {
    // eslint-disable-next-line no-await-in-loop -- user prompt must precede repository refresh
    const nextStep = await services.dialogue.handleEmptyStaging(
      targetCommit,
      repositoryState.changedFiles,
    );
    if (nextStep === 'cancel') {
      return null;
    }
    // eslint-disable-next-line no-await-in-loop -- repository refresh must follow user staging action
    repositoryState = await services.gitService.getRepositoryState(logger);
    if (reportUnresolvedConflicts(repositoryState, services.output)) {
      return null;
    }
    // eslint-disable-next-line no-await-in-loop -- diff load must follow repository refresh
    staged = await loadStagedChanges({
      services,
      parsedArgs,
      targetCommit,
      logger,
      suppressNoChangesMessage: true,
    });
  }

  if (staged.stagedFiles.length === 0) {
    const shown = (staged.excludedPaths ?? []).map((path) =>
      JSON.stringify(services.output.sanitizeTerminalText(path)),
    );
    services.output.cancel(
      `Only excluded files are staged: ${shown.join(', ')}. Nothing to analyse.`,
    );
    return null;
  }
  return { repositoryState, staged };
}

function reportUnresolvedConflicts(
  repositoryState: RepositoryState,
  output: GenerationServices['output'],
): boolean {
  if (!repositoryState.hasUnmergedPaths) {
    return false;
  }
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
  const hasTargetCommit = hasText(targetCommit);
  if (hasTargetCommit && commitCapability.mode === 'amend') {
    warnings.push(
      'Target is the unpublished HEAD: the commit action will amend it and rewrite that commit.',
    );
  }
  if (hasTargetCommit && commitCapability.mode === 'reword') {
    warnings.push(
      'Target is not an amendable HEAD: the commit action will add an `amend!` commit instead of rewriting history.',
    );
  }
  if (repositoryState.inProgressOperation !== null) {
    warnings.push(
      `Git operation in progress: ${repositoryState.inProgressOperation}. Commit action will be disabled.`,
    );
  }
  if (!commitCapability.allowed && commitCapability.reason !== undefined) {
    warnings.push(commitCapability.reason);
  }
  if (warnings.length === 0) {
    return;
  }
  output.warn(
    warnings.map((entry, idx) => `${idx + 1}. ${entry}`).join('\n'),
    'Repository warnings',
  );
}

function buildLogMetadata(
  staged: StagedChangesResult,
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
}): Promise<StagedChangesResult | null> {
  const {
    services,
    parsedArgs,
    targetCommit,
    logger,
    suppressNoChangesMessage,
  } = params;
  services.output.startProgress('Analyzing repository changes...');
  const staged = await services.gitService.retrieveStagedChanges(
    targetCommit,
    logger,
    parsedArgs.exclude,
    services.projectConfig?.exclude,
  );
  if (staged === null) {
    if (suppressNoChangesMessage === true) {
      services.output.stopProgress(
        services.output.style.yellow('No staged changes found'),
      );
    } else {
      services.output.stopProgress();
      services.output.cancel(
        'No staged changes found. Use "git add" to stage files.',
      );
    }
    return null;
  }
  if (staged.stagedFiles.length === 0) {
    services.output.stopProgress(
      services.output.style.yellow('Only excluded files found'),
    );
    return staged;
  }
  services.output.stopProgress(
    `Found ${staged.stagedFiles.length} file(s) changed`,
  );
  return staged;
}

async function resolveCommitContextHints(
  services: GenerationServices,
  stagedFiles: string[],
  logger: Logger,
): Promise<CommitContextHints> {
  try {
    return await services.getCommitContextHints(stagedFiles);
  } catch (error) {
    logger.log('debug', 'Failed to get commit context hints', {
      error: String(error),
    });
    return { scopeSuggestions: [], recentCommitSubjects: [] };
  }
}

async function runGenerationCycle(params: {
  services: GenerationServices;
  logger: Logger;
  state: GenerationState;
  staged: StagedChangesResult;
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
    try {
      // eslint-disable-next-line no-await-in-loop -- regeneration attempts must remain sequential
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
      if (outcome !== 'regenerate') {
        return outcome;
      }
    } catch (error) {
      if (state.nonInteractive === true || !isLanguageModelApiError(error)) {
        throw error;
      }
      services.output.stopProgress(
        hasLanguageModelErrorKind(error, 'timeout')
          ? 'Request timed out'
          : 'Request failed',
      );
      logger.log('error', `Commit helper request failed: ${error}`, {
        error: String(error),
      });
      // eslint-disable-next-line no-await-in-loop -- recovery prompt must follow failed attempt
      const recovery = await services.dialogue.recoverGeneration(
        describeLanguageModelApiError(error, services.output),
      );
      if (recovery === 'cancel') {
        return 'failure';
      }
      if (typeof recovery === 'object') {
        const { modelName } = recovery;
        state.baselineModelName = modelName;
        state.modelName = modelName;
      }
      continue;
    }
  }
}
