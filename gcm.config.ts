import { DEFAULT_MAX_DEBUG_LOG_BYTES } from './src/constants.js';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const CONFIG = {
  CHILD_PROCESS_MAX_BUFFER: Number(process.env.GCM_MAX_BUFFER) || 50 * 1024 * 1024,
  MAX_HUNKS: positiveInteger(process.env.GCM_MAX_HUNKS, 40),
  PER_FILE_BUFFER: Number(process.env.GCM_PER_FILE_BUFFER || 1 * 1024 * 1024),
  MODEL_NAME: process.env.GCM_MODEL || process.env.GEMINI_MODEL || 'gemini-3.7-flash',
  TEMPERATURE: Number(process.env.GCM_TEMPERATURE || process.env.GEMINI_TEMP || 1),
  ENABLE_THINKING: (process.env.GCM_ENABLE_THINKING || 'false') === 'true',
  TOKEN_BYTES_RATIO: Number(process.env.GCM_TOKEN_BYTES_RATIO || 3.5),
  MAX_OUTPUT_TOKENS: Number(process.env.GCM_MAX_OUTPUT_TOKENS || 8192),
  ENABLE_HUNK_WEIGHTS: (process.env.GCM_ENABLE_HUNK_WEIGHTS || 'false') === 'true',
  LOG_LEVEL: process.env.GCM_LOG_LEVEL || 'info',
  DEBUG_API: (process.env.GCM_DEBUG_API || 'false') === 'true',
  DEBUG_FILE: process.env.GCM_DEBUG_FILE || '.debug.log',
  DEBUG_MAX_BODY_LOG_BYTES: Number(process.env.GCM_DEBUG_MAX_BODY_LOG_BYTES || DEFAULT_MAX_DEBUG_LOG_BYTES),
  GEMINI_MAX_RETRIES: Number(process.env.GCM_GEMINI_MAX_RETRIES || 3),
  GEMINI_RETRY_BASE_MS: Number(process.env.GCM_GEMINI_RETRY_BASE_MS || 1000),
  GEMINI_RETRY_MAX_MS: Number(process.env.GCM_GEMINI_RETRY_MAX_MS || 60000),
  // When true, request bodies will include <<START>>/<<END>> markers in the user content
  // and system instructions will ask the model to emit ONLY the content between markers.
  ADD_RESPONSE_MARKERS: (process.env.GCM_ADD_RESPONSE_MARKERS || 'true') === 'true',
};
