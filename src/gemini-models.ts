import { readPositiveTokenCount, requireDistinctModels, type ModelSpec } from './model-registry.js';
import {
  createLanguageModelApiError,
  isLanguageModelName,
  type LanguageModelErrorKind,
} from './language-model-service.js';
import { isRecord } from './utils.js';
import {
  isRequestTimeout,
  requestProviderText,
  ResponseBodyTooLargeError,
} from './provider-http.js';
import type { Config } from '../gcm.config.js';

const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_MODEL_PAGES = 20;

function discoveryError(message: string, status?: number, kind?: LanguageModelErrorKind): Error {
  return createLanguageModelApiError(message, {
    ...(status === undefined ? {} : { status }),
    ...(kind === undefined ? {} : { kind }),
  });
}

function parseModel(value: unknown): ModelSpec | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  if (
    !Array.isArray(value.supportedGenerationMethods) ||
    !value.supportedGenerationMethods.includes('generateContent')
  ) {
    return null;
  }
  const maxInputTokens = readPositiveTokenCount(value.inputTokenLimit);
  const maxOutputTokens = readPositiveTokenCount(value.outputTokenLimit);
  if (maxInputTokens === null || maxOutputTokens === null) {
    return null;
  }
  const label =
    typeof value.displayName === 'string' && isLanguageModelName(value.displayName)
      ? value.displayName
      : value.name;
  return {
    name: value.name,
    label,
    limits: { kind: 'separate', maxInputTokens, maxOutputTokens },
  };
}

export async function listGeminiModels(
  apiKey: string,
  config: Pick<Config, 'MAX_RETRIES' | 'RETRY_BASE_MS' | 'RETRY_MAX_MS'>,
): Promise<ModelSpec[]> {
  const models: ModelSpec[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const url = new URL(MODELS_URL);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let result;
    try {
      result = await requestProviderText({
        url,
        init: { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
        timeoutMs: 10_000,
        retry: {
          maxRetries: config.MAX_RETRIES,
          retryBaseMs: config.RETRY_BASE_MS,
          retryMaxMs: config.RETRY_MAX_MS,
        },
        retryNetworkErrors: true,
      });
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw discoveryError('Gemini model catalogue response body is too large');
      }
      if (isRequestTimeout(error)) {
        throw discoveryError('Gemini model discovery timed out', undefined, 'timeout');
      }
      throw discoveryError('Gemini model discovery failed');
    }
    const { response, body } = result;
    if (!response.ok) {
      throw discoveryError(
        'Failed to fetch models: ' + String(response.status) + ' ' + response.statusText,
        response.status,
        'connection',
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(body) as unknown;
    } catch {
      throw discoveryError('Failed to parse Gemini model catalogue JSON');
    }
    if (!isRecord(data) || !Array.isArray(data.models)) {
      throw discoveryError('No models found in response', undefined, 'no-models');
    }
    for (const value of data.models) {
      const model = parseModel(value);
      if (model) models.push(model);
    }
    if (data.nextPageToken === undefined) {
      return requireDistinctModels(models, 'Gemini', (message, metadata) =>
        discoveryError(message, undefined, metadata?.kind),
      );
    }
    if (typeof data.nextPageToken !== 'string' || data.nextPageToken.length === 0) {
      throw discoveryError('Invalid model pagination token', undefined, 'invalid-model');
    }
    pageToken = data.nextPageToken;
  }
  throw discoveryError('Too many model catalogue pages');
}
