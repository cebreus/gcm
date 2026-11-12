import { hasText } from './utils.js';

const DEFAULT_RETRIES = 3;
const MAX_RETRIES = 10;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const MAX_RETRY_MS = 300_000;

type NumericInput = number | string | undefined;

export function stringOrDefault(
  value: string | undefined,
  fallback: string,
): string {
  if (!hasText(value)) {
    return fallback;
  }
  return value;
}

function parseNumber(value: NumericInput): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

interface RangeOptions {
  minimum: number;
  maximum: number;
  fallback: number;
  invalidName?: string;
}

export function integerInRange(
  value: NumericInput,
  options: RangeOptions,
): number {
  const { minimum, maximum, fallback, invalidName } = options;
  const parsed = parseNumber(value);
  if (value === undefined) {
    return fallback;
  }
  if (
    parsed === undefined ||
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    if (invalidName !== undefined) {
      throw new Error(`Invalid ${invalidName}`);
    }
    return fallback;
  }
  return parsed;
}

export function numberInRange(
  value: NumericInput,
  options: RangeOptions & { invalidName: string },
): number {
  const { minimum, maximum, fallback, invalidName } = options;
  const parsed = parseNumber(value);
  if (value === undefined) {
    return fallback;
  }
  if (parsed === undefined || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${invalidName}`);
  }
  return parsed;
}

export function normalizeRetryConfig(
  values: {
    maxRetries: NumericInput;
    retryBaseMs: NumericInput;
    retryMaxMs: NumericInput;
  },
  names: { maxRetries: string; retryBaseMs: string; retryMaxMs: string },
): {
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
} {
  const retryMaxMs = integerInRange(values.retryMaxMs, {
    minimum: 1,
    maximum: MAX_RETRY_MS,
    fallback: DEFAULT_RETRY_MAX_MS,
    invalidName: names.retryMaxMs,
  });
  return {
    maxRetries: integerInRange(values.maxRetries, {
      minimum: 0,
      maximum: MAX_RETRIES,
      fallback: DEFAULT_RETRIES,
      invalidName: names.maxRetries,
    }),
    retryBaseMs: integerInRange(values.retryBaseMs, {
      minimum: 1,
      maximum: retryMaxMs,
      fallback: Math.min(DEFAULT_RETRY_BASE_MS, retryMaxMs),
      invalidName: names.retryBaseMs,
    }),
    retryMaxMs,
  };
}
