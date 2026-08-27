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
    !/[\r\n\t\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(value) &&
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
  if (model.limits.kind === 'separate') {
    if (
      !Number.isSafeInteger(model.limits.maxInputTokens) ||
      !Number.isSafeInteger(model.limits.maxOutputTokens) ||
      model.limits.maxInputTokens <= 0 ||
      model.limits.maxOutputTokens <= 0
    ) {
      return 'Invalid model token limits';
    }
  } else if (
    model.limits.kind !== 'shared-context' ||
    !Number.isSafeInteger(model.limits.contextWindowTokens) ||
    model.limits.contextWindowTokens <= 0
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
  if (typeof provider.models !== 'function') return 'Provider requires a model catalogue';
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
  service: LanguageModelService;
  /** Returns validated models compatible with this application's text-generation contract. */
  models(): Promise<ModelSpec[]>;
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
    timeoutMs?: number;
    modelOverride?: string;
    maxOutputTokensLimit?: number;
  };
}

export interface GenerationAttemptState {
  promptContext: string;
  promptParts: PromptContextParts;
  summaryAttempted: boolean;
  maxOutputTokens: number;
}

export async function generateWithContextRecovery<T extends LanguageModelResponse>(options: {
  params: LanguageModelGenerateParams;
  initialMaxOutputTokens: number;
  generateOnce(state: GenerationAttemptState): Promise<T | null>;
  recoverError(
    error: unknown,
    state: GenerationAttemptState,
  ): Promise<GenerationAttemptState | null>;
}): Promise<T | null> {
  const { params } = options;
  let state: GenerationAttemptState = {
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
    try {
      return await options.generateOnce(state);
    } catch (error) {
      const recovered = await options.recoverError(error, state);
      if (!recovered) throw error;
      state = recovered;
    }
  }
}
