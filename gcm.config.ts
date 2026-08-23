import {
  DEFAULT_MAX_DEBUG_LOG_BYTES,
  MAX_CHILD_OUTPUT_BYTES,
  MAX_DEBUG_LOG_BYTES,
} from './src/constants.js';
import {
  integerInRange,
  normalizeRetryConfig,
  numberInRange,
  stringOrDefault,
} from './src/config-values.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './src/model-registry.js';

const retry = normalizeRetryConfig({
  maxRetries: process.env.GCM_GEMINI_MAX_RETRIES,
  retryBaseMs: process.env.GCM_GEMINI_RETRY_BASE_MS,
  retryMaxMs: process.env.GCM_GEMINI_RETRY_MAX_MS,
});

export const CONFIG = {
  CHILD_PROCESS_MAX_BUFFER: integerInRange(
    process.env.GCM_MAX_BUFFER,
    1,
    MAX_CHILD_OUTPUT_BYTES,
    50 * 1024 * 1024,
  ),
  MAX_HUNKS: integerInRange(process.env.GCM_MAX_HUNKS, 1, 10_000, 40),
  PER_FILE_BUFFER: integerInRange(
    process.env.GCM_PER_FILE_BUFFER,
    1,
    MAX_CHILD_OUTPUT_BYTES,
    1024 * 1024,
  ),
  MODEL: stringOrDefault(process.env.GCM_MODEL, 'gemini-3.7-flash'),
  TEMP: numberInRange(process.env.GCM_TEMP, 0, 1, 1),
  TOKEN_BYTES_RATIO: numberInRange(process.env.GCM_TOKEN_BYTES_RATIO, 0.1, 100, 3.5),
  MAX_OUTPUT_TOKENS: integerInRange(
    process.env.GCM_MAX_OUTPUT_TOKENS,
    1,
    Number.MAX_SAFE_INTEGER,
    DEFAULT_MAX_OUTPUT_TOKENS,
  ),
  ENABLE_HUNK_WEIGHTS: process.env.GCM_ENABLE_HUNK_WEIGHTS === 'true',
  LOG_LEVEL: stringOrDefault(process.env.GCM_LOG_LEVEL, 'info'),
  DEBUG_API: process.env.GCM_DEBUG_API === 'true',
  DEBUG_FILE: stringOrDefault(process.env.GCM_DEBUG_FILE, '.debug.log'),
  DEBUG_MAX_BODY_LOG_BYTES: integerInRange(
    process.env.GCM_DEBUG_MAX_BODY_LOG_BYTES,
    1,
    MAX_DEBUG_LOG_BYTES,
    DEFAULT_MAX_DEBUG_LOG_BYTES,
  ),
  GEMINI_MAX_RETRIES: retry.maxRetries,
  GEMINI_RETRY_BASE_MS: retry.retryBaseMs,
  GEMINI_RETRY_MAX_MS: retry.retryMaxMs,
};
