import {
  integerInRange,
  normalizeRetryConfig,
  numberInRange,
  stringOrDefault,
} from './src/config-values.js';
import { MAX_CHILD_OUTPUT_BYTES } from './src/constants.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from './src/model-registry.js';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const DEFAULT_CHILD_PROCESS_MAX_BUFFER = 52_428_800;
const MAX_HUNKS_LIMIT = 10_000;
const DEFAULT_MAX_HUNKS = 40;
const DEFAULT_PER_FILE_BUFFER = 1_048_576;
const MIN_TOKEN_BYTES_RATIO = 0.1;
const MAX_TOKEN_BYTES_RATIO = 100;
const DEFAULT_TOKEN_BYTES_RATIO = 3.5;

function logLevel(value: string | undefined): string {
  const level = stringOrDefault(value, 'info');
  if (!LOG_LEVELS.includes(level)) {
    throw new Error('Invalid GCM_LOG_LEVEL');
  }
  return level;
}

export interface Config {
  CHILD_PROCESS_MAX_BUFFER: number;
  MAX_HUNKS: number;
  PER_FILE_BUFFER: number;
  MODEL: string;
  TEMP: number;
  TOKEN_BYTES_RATIO: number;
  MAX_OUTPUT_TOKENS: number;
  LOG_LEVEL: string;
  DEBUG_API: boolean;
  AUTO_CHANGESET: boolean;
  MAX_RETRIES: number;
  RETRY_BASE_MS: number;
  RETRY_MAX_MS: number;
  FREELLMAPI_URL: string;
  FREELLMAPI_MODEL: string;
  FREELLMAPI_TOKEN: string | undefined;
  OPENROUTER_MODEL: string;
  OPENROUTER_TOKEN: string | undefined;
  PROVIDER: string | undefined;
  LM_STUDIO_URL: string;
  LM_STUDIO_MODEL: string | undefined;
  LM_STUDIO_TOKEN: string | undefined;
  GEMINI_API_KEY: string;
}

function readConfig(env: Record<string, string | undefined>): Config {
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
    CHILD_PROCESS_MAX_BUFFER: integerInRange(env.GCM_MAX_BUFFER, {
      minimum: 1,
      maximum: MAX_CHILD_OUTPUT_BYTES,
      fallback: DEFAULT_CHILD_PROCESS_MAX_BUFFER,
      invalidName: 'GCM_MAX_BUFFER',
    }),
    MAX_HUNKS: integerInRange(env.GCM_MAX_HUNKS, {
      minimum: 1,
      maximum: MAX_HUNKS_LIMIT,
      fallback: DEFAULT_MAX_HUNKS,
      invalidName: 'GCM_MAX_HUNKS',
    }),
    PER_FILE_BUFFER: integerInRange(env.GCM_PER_FILE_BUFFER, {
      minimum: 1,
      maximum: MAX_CHILD_OUTPUT_BYTES,
      fallback: DEFAULT_PER_FILE_BUFFER,
      invalidName: 'GCM_PER_FILE_BUFFER',
    }),
    MODEL: stringOrDefault(env.GCM_GEMINI_MODEL, 'gemini-4-hydrogen'),
    TEMP: numberInRange(env.GCM_TEMP, {
      minimum: 0,
      maximum: 1,
      fallback: 1,
      invalidName: 'GCM_TEMP',
    }),
    TOKEN_BYTES_RATIO: numberInRange(env.GCM_TOKEN_BYTES_RATIO, {
      minimum: MIN_TOKEN_BYTES_RATIO,
      maximum: MAX_TOKEN_BYTES_RATIO,
      fallback: DEFAULT_TOKEN_BYTES_RATIO,
      invalidName: 'GCM_TOKEN_BYTES_RATIO',
    }),
    MAX_OUTPUT_TOKENS: integerInRange(env.GCM_MAX_OUTPUT_TOKENS, {
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      fallback: DEFAULT_MAX_OUTPUT_TOKENS,
      invalidName: 'GCM_MAX_OUTPUT_TOKENS',
    }),
    LOG_LEVEL: logLevel(env.GCM_LOG_LEVEL),
    DEBUG_API: env.GCM_DEBUG_API === 'true',
    AUTO_CHANGESET: env.GCM_AUTO_CHANGESET === 'true',
    MAX_RETRIES: retry.maxRetries,
    RETRY_BASE_MS: retry.retryBaseMs,
    RETRY_MAX_MS: retry.retryMaxMs,
    FREELLMAPI_URL: stringOrDefault(
      env.GCM_FREELLMAPI_URL,
      'http://127.0.0.1:3001',
    ),
    FREELLMAPI_MODEL: stringOrDefault(env.GCM_FREELLMAPI_MODEL, 'auto'),
    FREELLMAPI_TOKEN: env.GCM_FREELLMAPI_API_KEY,
    OPENROUTER_MODEL: stringOrDefault(
      env.GCM_OPENROUTER_MODEL,
      'google/gemini-4-hydrogen',
    ),
    OPENROUTER_TOKEN: env.GCM_OPENROUTER_API_KEY,
    PROVIDER: env.GCM_PROVIDER,
    LM_STUDIO_URL: stringOrDefault(
      env.GCM_LM_STUDIO_URL,
      'http://127.0.0.1:1234',
    ),
    LM_STUDIO_MODEL: env.GCM_LM_STUDIO_MODEL,
    LM_STUDIO_TOKEN: env.GCM_LM_STUDIO_API_KEY,
    GEMINI_API_KEY: env.GCM_GEMINI_API_KEY ?? '',
  };
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  return readConfig(env);
}
