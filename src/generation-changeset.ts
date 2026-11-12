import type { ChangesetDraft } from './auto-changeset.js';
import { prepareChangeset } from './auto-changeset.js';
import type { CommitCapability } from './commit-capability.js';
import type { GenerationServices } from './generation-types.js';
import type { GenerationState } from './interactive-generation-dialogue.js';
import type { LanguageModelResponse } from './language-model-service.js';
import type { LogMetadata } from './logger.js';
import { resolveTokenBudget } from './model-registry.js';
import type { StagedChangesResult } from './services/git-service.js';
import { estimateTokenCount } from './utils.js';

const CHANGESET_TOKEN_MARGIN = 1_024;

export async function resolveGenerationTokenBudget(
  services: GenerationServices,
  state: GenerationState,
  systemPrompt: string,
): Promise<{ maxOutputTokens: number; maxAvailableTokens: number } | null> {
  const modelSpec = (await services.models()).find(
    (model) => model.name === state.modelName,
  );
  if (modelSpec === undefined) {
    services.output.cancel(`Error: Unknown ${services.providerLabel} model.`);
    return null;
  }
  const budget = resolveTokenBudget(
    modelSpec.limits,
    services.config.MAX_OUTPUT_TOKENS,
    estimateTokenCount(systemPrompt, services.config.TOKEN_BYTES_RATIO),
  );
  if (budget.maxAvailableTokens > 0) {
    return budget;
  }
  services.output.cancel(
    `Error: ${services.providerLabel} model has no capacity for configured output.`,
  );
  return null;
}

export function reportEmptyResponse(
  response: LanguageModelResponse | null,
  services: GenerationServices,
): response is null {
  if (response !== null && response.text.trim() !== '') {
    return false;
  }
  services.output.stopProgress(
    `${services.providerLabel} returned no usable response`,
  );
  services.output.cancel(
    `Error: ${services.providerLabel} did not return a usable response.`,
  );
  return true;
}

interface AutomaticChangesetOptions {
  services: GenerationServices;
  state: GenerationState;
  staged: StagedChangesResult;
  targetCommit: string | null;
  commitCapability: CommitCapability;
  responseTruncated?: boolean;
  processedDiffContent: string;
  maxAvailableTokens: number;
  maxOutputTokens: number;
  meta: LogMetadata;
}

export function createAutomaticChangesetPreparation(
  options: AutomaticChangesetOptions,
): (() => Promise<ChangesetDraft | null>) | undefined {
  if (!canOfferAutomaticChangeset(options)) {
    return undefined;
  }
  if (!hasCompleteChangesetEvidence(options)) {
    return async function () {
      return await Promise.resolve(null);
    };
  }
  return async function () {
    return await prepareChangeset({
      diff: options.staged.stagedDiff,
      generate: async function (promptContext, systemPrompt) {
        return await options.services.languageModelService.generate({
          promptContext,
          systemPrompt,
          meta: options.meta,
          modelName: options.state.modelName,
          maxOutputTokens: options.maxOutputTokens,
        });
      },
    });
  };
}

function canOfferAutomaticChangeset(
  options: AutomaticChangesetOptions,
): boolean {
  const { services, state, staged, targetCommit, commitCapability } = options;
  const stagedPaths = [...staged.stagedFiles, ...(staged.excludedPaths ?? [])];
  return (
    services.config.AUTO_CHANGESET &&
    state.nonInteractive !== true &&
    targetCommit === null &&
    commitCapability.allowed &&
    commitCapability.snapshot !== undefined &&
    !stagedPaths.some((path) => path.startsWith('.changeset/'))
  );
}

function hasCompleteChangesetEvidence(
  options: AutomaticChangesetOptions,
): boolean {
  const { services, staged } = options;
  const estimatedTokens =
    estimateTokenCount(staged.stagedDiff, services.config.TOKEN_BYTES_RATIO) +
    CHANGESET_TOKEN_MARGIN;
  return (
    options.responseTruncated !== true &&
    !staged.truncated &&
    (staged.excludedPaths === undefined || staged.excludedPaths.length === 0) &&
    staged.projectExcludesMatched !== true &&
    options.processedDiffContent === staged.stagedDiff &&
    estimatedTokens <= options.maxAvailableTokens
  );
}
