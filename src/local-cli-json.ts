import { createLanguageModelApiError } from './language-model-service.js';
import { isRecord } from './utils.js';

export function parseLocalCliJson(text: string, message: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw createLanguageModelApiError(message, { cause: error });
  }
}

export function tryParseLocalCliRecord(
  text: string,
): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
