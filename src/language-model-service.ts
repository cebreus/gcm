import {
  HTTP_STATUS_BAD_GATEWAY,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_GATEWAY_TIMEOUT,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
} from './constants.js';
import type { LogMetadata } from './logger.js';
import type { ModelSpec } from './model-registry.js';
import { stripTerminalControlSequences } from './utils.js';

export interface LanguageModelResponse {
  text: string;
  usage: {
    promptTokens?: number;
    outputTokens?: number;
  };
  truncated?: boolean;
}

/** Stored in `metadata.kind` where the error is created; consumers branch on it instead of the message text. */
export type LanguageModelErrorKind =
  'timeout' | 'missing-api-key' | 'no-models' | 'invalid-model' | 'connection';

export interface LanguageModelApiError extends Error {
  name: 'LanguageModelApiError';
  metadata: Record<string, unknown>;
}
const MAX_MODEL_NAME_LENGTH = 128;

export function createLanguageModelApiError(
  message: string,
  metadata: Record<string, unknown> = {},
): LanguageModelApiError {
  return Object.assign(new Error(message), {
    name: 'LanguageModelApiError',
    metadata,
  } satisfies Pick<LanguageModelApiError, 'name' | 'metadata'>);
}

export function isLanguageModelApiError(
  error: unknown,
): error is LanguageModelApiError {
  return (
    error instanceof Error &&
    error.name === 'LanguageModelApiError' &&
    'metadata' in error &&
    typeof error.metadata === 'object' &&
    error.metadata !== null &&
    !Array.isArray(error.metadata)
  );
}

export function hasLanguageModelErrorKind(
  error: unknown,
  kind: LanguageModelErrorKind,
): error is LanguageModelApiError {
  return isLanguageModelApiError(error) && error.metadata.kind === kind;
}

export function isModelUnavailableError(error: unknown): boolean {
  if (!isLanguageModelApiError(error)) {
    return false;
  }
  const status = Number(error.metadata.status);
  if (
    [
      HTTP_STATUS_BAD_REQUEST,
      HTTP_STATUS_UNAUTHORIZED,
      HTTP_STATUS_FORBIDDEN,
    ].includes(status)
  ) {
    return false;
  }
  return (
    error.metadata.availability === true ||
    [
      HTTP_STATUS_NOT_FOUND,
      HTTP_STATUS_REQUEST_TIMEOUT,
      HTTP_STATUS_TOO_MANY_REQUESTS,
      HTTP_STATUS_INTERNAL_SERVER_ERROR,
      HTTP_STATUS_BAD_GATEWAY,
      HTTP_STATUS_SERVICE_UNAVAILABLE,
      HTTP_STATUS_GATEWAY_TIMEOUT,
    ].includes(status)
  );
}

export function isLanguageModelProviderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z0-9][a-z0-9._\u002D]{0,63}$/iv.test(value)
  );
}

export function isLanguageModelName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MODEL_NAME_LENGTH &&
    value.trim() === value &&
    !/[\r\n\t\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/v.test(value) &&
    stripTerminalControlSequences(value) === value
  );
}

export function getModelSpecValidationError(model: ModelSpec): string | null {
  if (!isLanguageModelName(model.name)) {
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
    !Number.isSafeInteger(model.limits.contextWindowTokens) ||
    model.limits.contextWindowTokens <= 0
  ) {
    return 'Invalid model token limits';
  }
  return null;
}

export interface LanguageModelService {
  generate: (
    params: LanguageModelGenerateParams,
  ) => Promise<LanguageModelResponse | null>;
}

export interface LanguageModelProvider {
  id: string;
  label: string;
  readinessError?: string;
  defaultModel: string;
  service: LanguageModelService;
  /** Returns validated models compatible with this application's text-generation contract. */
  models: () => Promise<ModelSpec[]>;
}

export interface LanguageModelProviderFactory {
  id: string;
  label: string;
  create: (options?: { probeOnly?: boolean }) => Promise<LanguageModelProvider>;
}

export interface LanguageModelGenerateParams {
  promptContext: string;
  systemPrompt: string;
  meta: LogMetadata;
  /** Authoritative per-request output cap, already clamped to the model limits. */
  maxOutputTokens: number;
  modelName: string;
}
