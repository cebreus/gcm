const DEFAULT_RETRIES = 3;
const MAX_RETRIES = 10;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const MAX_RETRY_MS = 300_000;

type NumericInput = number | string | undefined;

export function stringOrDefault(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return value;
}

function parseNumber(value: NumericInput): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export function integerInRange(
  value: NumericInput,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = parseNumber(value);
  if (parsed === undefined) return fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

export function numberInRange(
  value: NumericInput,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = parseNumber(value);
  if (parsed === undefined || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

export function normalizeRetryConfig(values: {
  maxRetries: NumericInput;
  retryBaseMs: NumericInput;
  retryMaxMs: NumericInput;
}): { maxRetries: number; retryBaseMs: number; retryMaxMs: number } {
  const retryMaxMs = integerInRange(values.retryMaxMs, 1, MAX_RETRY_MS, DEFAULT_RETRY_MAX_MS);
  return {
    maxRetries: integerInRange(values.maxRetries, 0, MAX_RETRIES, DEFAULT_RETRIES),
    retryBaseMs: integerInRange(
      values.retryBaseMs,
      1,
      retryMaxMs,
      Math.min(DEFAULT_RETRY_BASE_MS, retryMaxMs),
    ),
    retryMaxMs,
  };
}
