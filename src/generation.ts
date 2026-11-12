import type { ParsedOptions } from './cli.js';
import { describeLanguageModelApiError } from './generation-errors.js';
import type {
  GenerationServices,
  TerminalOutcome,
} from './generation-types.js';
import { runGenerationWorkflow } from './generation-workflow.js';
import { isGitFailure } from './git-utils.js';
import type { GenerationState } from './interactive-generation-dialogue.js';
import { isLanguageModelApiError } from './language-model-service.js';
import type { Logger } from './logger.js';
import type { GCMSession } from './session.js';

export interface CreateGenerationStateOptions {
  parsedArgs: ParsedOptions;
  session: GCMSession;
  defaultModel: string;
  providerId: string;
  configuredModel?: string;
}

export function createGenerationState({
  parsedArgs,
  session,
  defaultModel,
  providerId,
  configuredModel,
}: CreateGenerationStateOptions): {
  targetCommit: string | null;
  state: GenerationState;
} {
  const sessionModel =
    session.providerId === providerId ? session.modelName : null;
  const initialModelName =
    parsedArgs.model ?? configuredModel ?? sessionModel ?? defaultModel;
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
  createServices: () => Omit<GenerationServices, 'output'>;
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
    if (isGitFailure(error, 'not-a-repository')) {
      output.cancel('Error: Not inside a git repository.');
    } else if (isGitFailure(error, 'unknown-revision')) {
      output.cancel(`Error: Invalid commit SHA: ${targetCommit}`);
    } else if (isLanguageModelApiError(error)) {
      logger.log('debug', `Commit helper failed: ${error.message}`, {
        error: errStr,
        snippet: error.metadata.snippet,
      });
      output.cancel(describeLanguageModelApiError(error, output));
    } else {
      logger.log('error', `Commit helper failed: ${String(error)}`, {
        error: errStr,
      });
      output.cancel(
        `An unexpected error occurred: ${output.sanitizeTerminalText(errStr)}`,
      );
    }
    // Reported above; rethrowing would make the entrypoint print it again.
    return 'failure';
  }
}
