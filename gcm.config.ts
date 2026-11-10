import { MAX_CHILD_OUTPUT_BYTES } from './src/constants.js';
import {
  integerInRange,
  normalizeRetryConfig,
  numberInRange,
  stringOrDefault,
} from './src/config-values.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './src/model-registry.js';

export function loadConfig(env: Record<string, string | undefined>) {
  const retry = normalizeRetryConfig(
    {
      maxRetries: env.GCM_MAX_RETRIES,
      retryBaseMs: env.GCM_RETRY_BASE_MS,
      retryMaxMs: env.GCM_RETRY_MAX_MS,
    },
    {
      maxRetries: 'GCM_MAX_RETRIES',
      retryBaseMs: 'GCM_RETRY_BASE_MS',
      retryMaxMs: 'GCM_RETRY_MAX_MS',
    },
  );
  return {
    CHILD_PROCESS_MAX_BUFFER: integerInRange(
      env.GCM_MAX_BUFFER,
      1,
      MAX_CHILD_OUTPUT_BYTES,
      50 * 1024 * 1024,
      'GCM_MAX_BUFFER',
    ),
    MAX_HUNKS: integerInRange(env.GCM_MAX_HUNKS, 1, 10_000, 40, 'GCM_MAX_HUNKS'),
    PER_FILE_BUFFER: integerInRange(
      env.GCM_PER_FILE_BUFFER,
      1,
      MAX_CHILD_OUTPUT_BYTES,
      1024 * 1024,
      'GCM_PER_FILE_BUFFER',
    ),
    MODEL: stringOrDefault(env.GCM_MODEL, 'gemini-3.7-flash'),
    TEMP: numberInRange(env.GCM_TEMP, 0, 1, 1, 'GCM_TEMP'),
    TOKEN_BYTES_RATIO: numberInRange(
      env.GCM_TOKEN_BYTES_RATIO,
      0.1,
      100,
      3.5,
      'GCM_TOKEN_BYTES_RATIO',
    ),
    MAX_OUTPUT_TOKENS: integerInRange(
      env.GCM_MAX_OUTPUT_TOKENS,
      1,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_OUTPUT_TOKENS,
      'GCM_MAX_OUTPUT_TOKENS',
    ),
    LOG_LEVEL: stringOrDefault(env.GCM_LOG_LEVEL, 'info'),
    DEBUG_API: env.GCM_DEBUG_API === 'true',
    AUTO_CHANGESET: env.GCM_AUTO_CHANGESET === 'true',
    MAX_RETRIES: retry.maxRetries,
    RETRY_BASE_MS: retry.retryBaseMs,
    RETRY_MAX_MS: retry.retryMaxMs,
    FREELLMAPI_URL: stringOrDefault(env.GCM_FREELLMAPI_URL, 'http://127.0.0.1:3001'),
    FREELLMAPI_MODEL: env.GCM_FREELLMAPI_MODEL ?? 'auto',
    FREELLMAPI_TOKEN: env.GCM_FREELLMAPI_TOKEN,
    PROVIDER: env.GCM_PROVIDER,
    LM_STUDIO_URL: stringOrDefault(env.GCM_LM_STUDIO_URL, 'http://127.0.0.1:1234'),
    LM_STUDIO_MODEL: env.GCM_LM_STUDIO_MODEL,
    LM_STUDIO_TOKEN: env.LM_API_TOKEN,
    GEMINI_API_KEY: env.GOOGLE_GEMINI_API_KEY ?? '',
  };
}

export type Config = ReturnType<typeof loadConfig>;
