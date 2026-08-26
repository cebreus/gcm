import type { LogMetadata } from './logger.js';
import type { ModelSpec } from './model-registry.js';
import type { PromptContextParts, RetryReductionResult } from './services/context-service.js';
import { stripTerminalControlSequences } from './utils.js';

export type { ModelSpec } from './model-registry.js';

export interface LanguageModelResponse {
  text: string;
  usage: {
    promptTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
  };
  truncated?: boolean;
}

export type LanguageModelApiError = Error & {
  name: 'LanguageModelApiError';
  metadata: Record<string, unknown>;
};

export function createLanguageModelApiError(
  message: string,
  metadata: Record<string, unknown> = {},
): LanguageModelApiError {
  const error = new Error(message) as LanguageModelApiError;
  error.name = 'LanguageModelApiError';
  error.metadata = metadata;
  return error;
}

export function isLanguageModelApiError(error: unknown): error is LanguageModelApiError {
  return (
    error instanceof Error &&
    error.name === 'LanguageModelApiError' &&
    'metadata' in error &&
    typeof error.metadata === 'object' &&
    error.metadata !== null &&
    !Array.isArray(error.metadata)
  );
}

export function isLanguageModelProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value);
}

export function isLanguageModelName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[\r\n\t]/.test(value) &&
    stripTerminalControlSequences(value) === value
  );
}

export function getModelSpecValidationError(
  model: ModelSpec,
  expectedName = model.name,
): string | null {
  if (!isLanguageModelName(model.name) || model.name !== expectedName) {
    return 'Invalid model name';
  }
  if (
    !Number.isSafeInteger(model.maxInputTokens) ||
    !Number.isSafeInteger(model.maxOutputTokens) ||
    model.maxOutputTokens <= 0 ||
    model.maxInputTokens <= model.maxOutputTokens + 1_000
  ) {
    return 'Invalid model token limits';
  }
  return null;
}

export function getLanguageModelProviderValidationError(
  provider: LanguageModelProvider,
): string | null {
  if (!isLanguageModelProviderId(provider.id)) return 'Invalid language model provider id';
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(provider.label)) {
    return 'Invalid language model provider label';
  }
  if (!isLanguageModelName(provider.defaultModel)) return 'Invalid default model name';
  if (provider.fallbackModels.some(model => !isLanguageModelName(model.name))) {
    return 'Invalid fallback model name';
  }
  if (provider.fallbackModels.length === 0) return 'Provider requires a fallback model';
  try {
    const modelSpecs = [provider.getModelSpec(provider.defaultModel), ...provider.fallbackModels];
    const invalidSpec = modelSpecs.map(model => getModelSpecValidationError(model)).find(Boolean);
    if (invalidSpec) return invalidSpec;
  } catch {
    return 'Invalid model specification';
  }
  return null;
}

export interface LanguageModelService {
  generate(params: LanguageModelGenerateParams): Promise<LanguageModelResponse | null>;
}

export interface LanguageModelProvider {
  id: string;
  label: string;
  readinessError?: string;
  selectionNotice?: string;
  defaultModel: string;
  fallbackModels: ModelSpec[];
  service: LanguageModelService;
  /** Returns only models compatible with this application's text-generation contract. */
  listModels(): Promise<string[]>;
  getModelSpec(modelName: string): ModelSpec;
}

export interface LanguageModelProviderFactory {
  id: string;
  label: string;
  create(options?: { probeOnly?: boolean }): Promise<LanguageModelProvider>;
}

export interface LanguageModelGenerateParams {
  promptContext: string;
  promptParts?: PromptContextParts;
  summaryAttempted?: boolean;
  systemPrompt: string;
  reduceForRetry(params: {
    promptParts: PromptContextParts;
    summaryAttempted: boolean;
  }): Promise<RetryReductionResult>;
  meta: LogMetadata;
  opts?: {
    retryIfTruncated?: boolean;
    retryIfTruncatedMaxRetries?: number;
    retryIfTruncatedIncreaseTokens?: number;
    timeoutMs?: number;
    modelOverride?: string;
  };
}

export interface SemanticRetryState {
  promptContext: string;
  promptParts: PromptContextParts;
  summaryAttempted: boolean;
  maxOutputTokens: number;
}

export async function generateWithSemanticRetries<T extends LanguageModelResponse>(options: {
  params: LanguageModelGenerateParams;
  initialMaxOutputTokens: number;
  maxOutputTokensLimit: number;
  defaultRetryLimit: number;
  maximumRetryLimit: number;
  defaultTokenIncrease: number;
  reduceInputOnTruncation: boolean;
  retryWhenOutputLimitUnchanged?: boolean;
  generateOnce(state: SemanticRetryState): Promise<T | null>;
  recoverError?(error: unknown, state: SemanticRetryState): Promise<SemanticRetryState | null>;
  onTruncationRetry?(retry: number, limit: number, response: T): Promise<void>;
  onOutputLimit?(): void;
}): Promise<T | null> {
  const { params } = options;
  const configuredRetryLimit = params.opts?.retryIfTruncatedMaxRetries;
  const retryLimit =
    Number.isSafeInteger(configuredRetryLimit) &&
    Number(configuredRetryLimit) >= 0 &&
    Number(configuredRetryLimit) <= options.maximumRetryLimit
      ? Number(configuredRetryLimit)
      : options.defaultRetryLimit;
  const configuredIncrease = params.opts?.retryIfTruncatedIncreaseTokens;
  const tokenIncrease =
    Number.isSafeInteger(configuredIncrease) && Number(configuredIncrease) > 0
      ? Number(configuredIncrease)
      : options.defaultTokenIncrease;
  let retries = 0;
  let state: SemanticRetryState = {
    promptContext: params.promptContext,
    promptParts: params.promptParts ?? {
      prefix: '',
      diffHeading: '',
      diffBody: params.promptContext,
      suffix: '',
    },
    summaryAttempted: params.summaryAttempted ?? false,
    maxOutputTokens: options.initialMaxOutputTokens,
  };

  for (;;) {
    let response: T | null;
    try {
      response = await options.generateOnce(state);
    } catch (error) {
      const recovered = await options.recoverError?.(error, state);
      if (!recovered) throw error;
      state = recovered;
      continue;
    }
    if (!(response?.truncated && params.opts?.retryIfTruncated && retries < retryLimit)) {
      return response;
    }
    const nextMaxOutputTokens = Math.min(
      state.maxOutputTokens + tokenIncrease,
      options.maxOutputTokensLimit,
    );
    if (nextMaxOutputTokens <= state.maxOutputTokens && !options.retryWhenOutputLimitUnchanged) {
      options.onOutputLimit?.();
      return response;
    }
    if (options.reduceInputOnTruncation) {
      const reduction = await params.reduceForRetry({
        promptParts: state.promptParts,
        summaryAttempted: state.summaryAttempted,
      });
      if (reduction.mode === 'unreducible') return response;
      state = {
        ...state,
        promptContext: reduction.promptContext,
        promptParts: reduction.promptParts,
        summaryAttempted: reduction.summaryAttempted,
      };
    }
    retries += 1;
    state.maxOutputTokens = nextMaxOutputTokens;
    await options.onTruncationRetry?.(retries, retryLimit, response);
  }
}
