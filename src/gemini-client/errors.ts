export type GeminiErrorMetadata = Record<string, unknown>;

export type GeminiApiError = Error & { metadata: GeminiErrorMetadata };

export function createGeminiApiError(
  message: string,
  metadata: GeminiErrorMetadata = {},
): GeminiApiError {
  const error = new Error(message) as GeminiApiError;
  error.name = 'GeminiApiError';
  error.metadata = metadata;
  return error;
}

export function isGeminiApiError(error: unknown): error is GeminiApiError {
  return (
    error instanceof Error &&
    error.name === 'GeminiApiError' &&
    'metadata' in error &&
    typeof error.metadata === 'object' &&
    error.metadata !== null &&
    !Array.isArray(error.metadata)
  );
}
