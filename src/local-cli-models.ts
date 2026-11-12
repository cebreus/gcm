import { BYTES_PER_KIBIBYTE, KIBIBYTES_PER_MEBIBYTE } from './constants.js';
import type { ModelTokenLimits } from './model-registry.js';

const CODEX_MAX_INPUT_TOKENS = 32_000;
const LOCAL_CLI_MAX_OUTPUT_TOKENS = 8_192;
const MAX_CLI_ERROR_KIBIBYTES = 64;

export const MAX_CLI_OUTPUT_BYTES = BYTES_PER_KIBIBYTE * KIBIBYTES_PER_MEBIBYTE;
export const MAX_CLI_ERROR_BYTES = MAX_CLI_ERROR_KIBIBYTES * BYTES_PER_KIBIBYTE;

export const LOCAL_CLI_LIMITS: ModelTokenLimits = {
  kind: 'separate',
  maxInputTokens: CODEX_MAX_INPUT_TOKENS,
  maxOutputTokens: LOCAL_CLI_MAX_OUTPUT_TOKENS,
};
