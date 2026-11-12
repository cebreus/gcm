import { runCommitBatch } from './batch-generation.js';
import type { ParsedOptions } from './cli.js';
import type { GenerationServices } from './generation-types.js';
import { runGenerationCommand } from './generation.js';
import type { GenerationState } from './interactive-generation-dialogue.js';
import type { Logger } from './logger.js';
import type { GitService } from './services/git-service.js';
import { hasText } from './utils.js';

export async function runCommitRangeCommand(params: {
  gitService: GitService;
  range: string;
  createServices: () => Omit<GenerationServices, 'output'>;
  parsedArgs: ParsedOptions;
  logger: Logger;
  providerReadinessError?: string;
  state: GenerationState;
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
        repositoryState.inProgressOperation !== null)
    ) {
      output.cancel(
        'Commit range apply requires a clean index with no Git operation in progress.',
      );
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
      getHead: async () => await gitService.getHeadHash(logger),
      hasAmendment: async (hash) =>
        parsedArgs.apply
          ? await gitService.hasAmendment(hash, logger)
          : await Promise.resolve(false),
      runOne: async (hash) => {
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
          logger.log('error', `Commit range target failed: ${String(error)}`);
          return false;
        }
      },
      report: (message) => {
        logger.log('info', message);
      },
    });
    const summary = `Commit range: ${result.completed.length} completed, ${result.skipped.length} skipped.`;
    if (hasText(result.failed)) {
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
