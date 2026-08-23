import { DEFAULT_MAX_DEBUG_LOG_BYTES, MAX_DEBUG_LOG_BYTES } from './src/constants.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './src/model-registry.js';

function integerInRange(
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function numberInRange(
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

const retryMaxMs = integerInRange(process.env.GCM_GEMINI_RETRY_MAX_MS, 1, 300_000, 60_000);
const retryBaseMs = integerInRange(
  process.env.GCM_GEMINI_RETRY_BASE_MS,
  1,
  retryMaxMs,
  Math.min(1000, retryMaxMs),
);

export const CONFIG = {
  CHILD_PROCESS_MAX_BUFFER: integerInRange(
    process.env.GCM_MAX_BUFFER,
    1,
    1024 * 1024 * 1024,
    50 * 1024 * 1024,
  ),
  MAX_HUNKS: integerInRange(process.env.GCM_MAX_HUNKS, 1, 10_000, 40),
  PER_FILE_BUFFER: integerInRange(
    process.env.GCM_PER_FILE_BUFFER,
    1,
    1024 * 1024 * 1024,
    1024 * 1024,
  ),
  MODEL: process.env.GCM_MODEL || 'gemini-3.7-flash',
  TEMP: numberInRange(process.env.GCM_TEMP, 0, 1, 1),
  ENABLE_THINKING: (process.env.GCM_ENABLE_THINKING || 'false') === 'true',
  TOKEN_BYTES_RATIO: numberInRange(process.env.GCM_TOKEN_BYTES_RATIO, 0.1, 100, 3.5),
  MAX_OUTPUT_TOKENS: integerInRange(
    process.env.GCM_MAX_OUTPUT_TOKENS,
    1,
    Number.MAX_SAFE_INTEGER,
    DEFAULT_MAX_OUTPUT_TOKENS,
  ),
  ENABLE_HUNK_WEIGHTS: (process.env.GCM_ENABLE_HUNK_WEIGHTS || 'false') === 'true',
  LOG_LEVEL: process.env.GCM_LOG_LEVEL || 'info',
  DEBUG_API: (process.env.GCM_DEBUG_API || 'false') === 'true',
  DEBUG_FILE: process.env.GCM_DEBUG_FILE || '.debug.log',
  DEBUG_MAX_BODY_LOG_BYTES: integerInRange(
    process.env.GCM_DEBUG_MAX_BODY_LOG_BYTES,
    1,
    MAX_DEBUG_LOG_BYTES,
    DEFAULT_MAX_DEBUG_LOG_BYTES,
  ),
  GEMINI_MAX_RETRIES: integerInRange(process.env.GCM_GEMINI_MAX_RETRIES, 1, 10, 3),
  GEMINI_RETRY_BASE_MS: retryBaseMs,
  GEMINI_RETRY_MAX_MS: retryMaxMs,
  // When true, request bodies will include <<START>>/<<END>> markers in the user content
  // and system instructions will ask the model to emit ONLY the content between markers.
  ADD_RESPONSE_MARKERS: (process.env.GCM_ADD_RESPONSE_MARKERS || 'true') === 'true',
};
