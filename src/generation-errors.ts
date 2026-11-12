import type { GenerationServices } from './generation-types.js';
import {
  hasLanguageModelErrorKind,
  isLanguageModelApiError,
} from './language-model-service.js';
import { isRecord } from './utils.js';

export function describeLanguageModelApiError(
  error: unknown,
  output: GenerationServices['output'],
): string {
  if (!isLanguageModelApiError(error)) {
    return output.sanitizeTerminalText(String(error));
  }
  const { metadata } = error;
  const status =
    typeof metadata.status === 'string' || typeof metadata.status === 'number'
      ? String(metadata.status)
      : 'Unknown';
  const message = responseErrorMessage(metadata.snippet) ?? error.message;
  const safeMessage = output.sanitizeTerminalText(message);
  return status === 'Unknown' && hasLanguageModelErrorKind(error, 'timeout')
    ? safeMessage
    : `API Error (${status}): ${safeMessage}`;
}

function responseErrorMessage(snippet: unknown): string | null {
  try {
    const parsed: unknown = JSON.parse(
      typeof snippet === 'string' ? snippet : '{}',
    );
    const responseError = isRecord(parsed) ? parsed.error : undefined;
    const responseMessage = isRecord(responseError)
      ? responseError.message
      : undefined;
    if (typeof responseMessage === 'string' && responseMessage !== '') {
      return responseMessage;
    }
  } catch {
    return null;
  }
  return null;
}
