import type { LogMetadata } from './logger.js';
import type { ModelSpec } from './model-registry.js';
import type { PromptContextParts, RetryReductionResult } from './services/context-service.js';
import { stripTerminalControlSequences } from './utils.js';

export type { ModelSpec } from './model-registry.js';

export const DEFAULT_LANGUAGE_MODEL_MAX_OUTPUT_TOKENS = 8_192;

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
