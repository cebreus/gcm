import type { GeminiClient, GeminiResponse } from '../gemini-client.js';
import type { Logger, LogMetadata } from '../logger.js';
import { renderPromptContext } from './context-service.js';
import type { PromptContextParts, RetryReductionResult } from './context-service.js';
import { CONFIG } from '../../gcm.config.js';
import type {
  GenerationAttemptState,
  LanguageModelGenerateParams,
  LanguageModelService,
} from '../language-model-service.js';
import {
  createLanguageModelApiError,
  generateWithContextRecovery,
} from '../language-model-service.js';
import { isGeminiApiError } from '../gemini-client/errors.js';
import { getEffectiveMaxOutputTokens } from '../model-registry.js';

const MAX_CONTEXT_REDUCTION_ATTEMPTS = 3;

export interface GeminiServiceDeps {
  client: GeminiClient;
  logger: Logger;
  apiKey: string;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

type CallGeminiOptions = NonNullable<LanguageModelGenerateParams['opts']>;
type CallGeminiApiParams = LanguageModelGenerateParams;

interface GeminiServiceRuntimeDeps extends GeminiServiceDeps {
  sleep: (milliseconds: number) => Promise<unknown>;
}

async function handleContextOverflow(params: {
  deps: GeminiServiceRuntimeDeps;
  reduceForRetry: CallGeminiApiParams['reduceForRetry'];
  promptParts: PromptContextParts;
  maxOutputTokens: number;
  maxOutputTokensLimit: number;
  attempt: number;
  summaryAttempted: boolean;
}): Promise<{
  input: string;
  promptParts: PromptContextParts;
  maxOutputTokens: number;
  summaryAttempted: boolean;
} | null> {
  const {
    deps,
    reduceForRetry,
    promptParts,
    maxOutputTokens,
    maxOutputTokensLimit,
    attempt,
    summaryAttempted,
  } = params;
  const result = await reduceForRetry({
    promptParts,
    summaryAttempted,
  });
  if (result.mode === 'unreducible') return null;
  const newMaxOutput = Math.min(maxOutputTokens, maxOutputTokensLimit);
  if (result.mode === 'summary') {
    deps.logger.log(
      'warn',
      'Gemini returned MAX_TOKENS or no text; switching to top-hunks summary and retrying',
      { attempt },
    );
  } else {
    deps.logger.log('warn', 'Gemini returned MAX_TOKENS or no text; retrying with smaller input', {
      attempt,
      newInputLength: result.promptContext.length,
      maxOutputOverride: newMaxOutput,
    });
  }
  await deps.sleep((result.mode === 'summary' ? 200 : 500) * attempt);
  return {
    input: result.promptContext,
    promptParts: result.promptParts,
    maxOutputTokens: newMaxOutput,
    summaryAttempted: result.summaryAttempted,
  };
}

async function callOnce(params: {
  deps: GeminiServiceRuntimeDeps;
  input: string;
  meta: LogMetadata;
  systemPrompt: string;
  maxOutputOverride: number;
  opts?: CallGeminiOptions;
}): Promise<GeminiResponse | null> {
  const { deps, input, meta, systemPrompt, maxOutputOverride, opts } = params;
  return deps.client.callGemini({
    apiKey: deps.apiKey,
    userContent: input,
    telemetryMeta: meta,
    callOptions: {
      maxOutputTokens: maxOutputOverride,
      systemInstructions: systemPrompt,
      timeoutMs: typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 60000,
    },
    modelOverride: opts?.modelOverride,
  });
}

async function maybeHandleOverflow(params: {
  deps: GeminiServiceRuntimeDeps;
  err: unknown;
  state: GenerationAttemptState;
  attempt: number;
  maxAttempts: number;
  reduceForRetry: CallGeminiApiParams['reduceForRetry'];
  maxOutputTokensLimit: number;
}): Promise<GenerationAttemptState | null> {
  const { deps, err, state, attempt, maxAttempts, reduceForRetry, maxOutputTokensLimit } = params;
  const errStr = String(err);
  const isMaxTokens = /MAX_TOKENS/i.test(errStr) || /returned no text/i.test(errStr);
  if (!(isMaxTokens && attempt < maxAttempts)) return null;
  const result = await handleContextOverflow({
    deps,
    reduceForRetry,
    promptParts: state.promptParts,
    maxOutputTokens: state.maxOutputTokens,
    maxOutputTokensLimit,
    attempt,
    summaryAttempted: state.summaryAttempted,
  });
  if (!result) return null;
  return {
    promptContext: result.input,
    promptParts: result.promptParts,
    maxOutputTokens: result.maxOutputTokens,
    summaryAttempted: result.summaryAttempted,
  };
}

async function generateWithDeps(params: {
  deps: GeminiServiceRuntimeDeps;
  promptContext: string;
  promptParts?: PromptContextParts;
  summaryAttempted?: boolean;
  systemPrompt: string;
  reduceForRetry: CallGeminiApiParams['reduceForRetry'];
  meta: LogMetadata;
  opts?: CallGeminiOptions;
}): Promise<GeminiResponse | null> {
  const {
    deps,
    promptContext,
    promptParts,
    summaryAttempted,
    systemPrompt,
    reduceForRetry,
    meta,
    opts,
  } = params;
  const maxOutputTokensLimit = opts?.maxOutputTokensLimit;
  if (!Number.isSafeInteger(maxOutputTokensLimit) || Number(maxOutputTokensLimit) <= 0) {
    throw createLanguageModelApiError('Gemini model output limit is required');
  }
  const validatedMaxOutputTokensLimit = Number(maxOutputTokensLimit);
  const initialMaxOutputTokens = getEffectiveMaxOutputTokens(
    CONFIG.MAX_OUTPUT_TOKENS,
    validatedMaxOutputTokensLimit,
  );
  const maxAttempts = MAX_CONTEXT_REDUCTION_ATTEMPTS;
  let overflowRetries = 0;
  const initialPromptParts = promptParts ?? {
    prefix: '',
    diffHeading: '',
    diffBody: promptContext,
    suffix: '',
  };
  return generateWithContextRecovery({
    params: {
      promptContext: renderPromptContext(initialPromptParts),
      promptParts: initialPromptParts,
      summaryAttempted,
      systemPrompt,
      reduceForRetry,
      meta,
      opts,
    },
    initialMaxOutputTokens,
    generateOnce: function (state) {
      return callOnce({
        deps,
        input: state.promptContext,
        meta,
        systemPrompt,
        maxOutputOverride: state.maxOutputTokens,
        opts,
      });
    },
    recoverError: async function (error, state) {
      const recovered = await maybeHandleOverflow({
        deps,
        err: error,
        state,
        attempt: overflowRetries + 1,
        maxAttempts,
        reduceForRetry,
        maxOutputTokensLimit: initialMaxOutputTokens,
      });
      if (recovered) overflowRetries += 1;
      return recovered;
    },
  });
}

export function createGeminiService({
  client,
  logger,
  apiKey,
  sleep = Bun.sleep,
}: GeminiServiceDeps): LanguageModelService {
  const deps: GeminiServiceRuntimeDeps = {
    client,
    logger,
    apiKey,
    sleep,
  };
  return {
    generate: async function (params: CallGeminiApiParams): Promise<GeminiResponse | null> {
      try {
        return await generateWithDeps({ deps, ...params });
      } catch (error) {
        if (isGeminiApiError(error)) {
          throw createLanguageModelApiError(error.message, error.metadata);
        }
        throw error;
      }
    },
  };
}
