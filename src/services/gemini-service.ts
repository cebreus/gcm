import type { GeminiClient, GeminiResponse } from '../gemini-client.js';
import type { Logger, LogMetadata } from '../logger.js';
import { renderPromptContext } from './context-service.js';
import type { PromptContextParts, RetryReductionResult } from './context-service.js';
import { CONFIG } from '../../gcm.config.js';
import type {
  LanguageModelGenerateParams,
  LanguageModelService,
  SemanticRetryState,
} from '../language-model-service.js';
import {
  createLanguageModelApiError,
  generateWithSemanticRetries,
} from '../language-model-service.js';
import { isGeminiApiError } from '../gemini-client/errors.js';
import { getEffectiveMaxOutputTokens, getModelSpec } from '../model-registry.js';

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
  attempt: number;
  summaryAttempted: boolean;
}): Promise<{
  input: string;
  promptParts: PromptContextParts;
  maxOutputTokens: number;
  summaryAttempted: boolean;
} | null> {
  const { deps, reduceForRetry, promptParts, maxOutputTokens, attempt, summaryAttempted } = params;
  const result = await reduceForRetry({
    promptParts,
    summaryAttempted,
  });
  if (result.mode === 'unreducible') return null;
  const newMaxOutput = maxOutputTokens + 1024;
  if (result.mode === 'summary') {
    deps.logger.log(
      'warn',
      'Gemini returned MAX_TOKENS or no text; switching to top-hunks summary and retrying',
      { attempt },
    );
  } else {
    deps.logger.log(
      'warn',
      'Gemini returned MAX_TOKENS or no text; retrying with smaller input and lower maxOutputTokens',
      { attempt, newInputLength: result.promptContext.length, maxOutputOverride: newMaxOutput },
    );
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
  state: SemanticRetryState;
  attempt: number;
  maxAttempts: number;
  reduceForRetry: CallGeminiApiParams['reduceForRetry'];
}): Promise<SemanticRetryState | null> {
  const { deps, err, state, attempt, maxAttempts, reduceForRetry } = params;
  const errStr = String(err);
  const isMaxTokens = /MAX_TOKENS/i.test(errStr) || /returned no text/i.test(errStr);
  if (!(isMaxTokens && attempt < maxAttempts)) return null;
  const result = await handleContextOverflow({
    deps,
    reduceForRetry,
    promptParts: state.promptParts,
    maxOutputTokens: state.maxOutputTokens,
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
  const modelName = opts?.modelOverride ?? CONFIG.MODEL;
  const initialMaxOutputTokens = getEffectiveMaxOutputTokens(modelName, CONFIG.MAX_OUTPUT_TOKENS);
  const maxAttempts = CONFIG.GEMINI_MAX_RETRIES;
  let overflowRetries = 0;
  const initialPromptParts = promptParts ?? {
    prefix: '',
    diffHeading: '',
    diffBody: promptContext,
    suffix: '',
  };
  return generateWithSemanticRetries({
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
    maxOutputTokensLimit: getModelSpec(modelName).maxOutputTokens,
    defaultRetryLimit: 1,
    maximumRetryLimit: 10,
    defaultTokenIncrease: initialMaxOutputTokens,
    reduceInputOnTruncation: false,
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
      });
      if (recovered) overflowRetries += 1;
      return recovered;
    },
    onTruncationRetry: async function (retry, limit, response) {
      deps.logger.log(
        'warn',
        `Gemini response appeared truncated; retrying with higher maxOutputTokens (attempt ${retry}/${limit})`,
        { previousTextSnippet: response.text.slice(0, 256) },
      );
      await deps.sleep(50);
    },
    onOutputLimit: function () {
      deps.logger.log(
        'warn',
        "Gemini response was truncated because the model's output limit was reached.",
      );
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
