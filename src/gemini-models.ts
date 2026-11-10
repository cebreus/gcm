import { readPositiveTokenCount, requireDistinctModels, type ModelSpec } from './model-registry.js';
import { createLanguageModelApiError, isLanguageModelName } from './language-model-service.js';
import { isRecord } from './utils.js';
import { requestProviderText } from './provider-http.js';
import { CONFIG } from '../gcm.config.js';

const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_MODEL_PAGES = 20;

function discoveryError(message: string, status?: number): Error {
  return createLanguageModelApiError(message, {
    ...(status === undefined ? {} : { status }),
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

export async function listGeminiModels(apiKey: string): Promise<ModelSpec[]> {
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
          maxRetries: CONFIG.MAX_RETRIES,
          retryBaseMs: CONFIG.RETRY_BASE_MS,
          retryMaxMs: CONFIG.RETRY_MAX_MS,
        },
        retryNetworkErrors: true,
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && /abort|timeout/i.test(error.name + ' ' + error.message);
      if (error instanceof Error && error.message === 'response body too large') {
        throw discoveryError('Gemini model catalogue response body is too large');
      }
      throw discoveryError(
        timedOut ? 'Gemini model discovery timed out' : 'Gemini model discovery failed',
      );
    }
    const { response, body } = result;
    if (!response.ok) {
      throw discoveryError(
        'Failed to fetch models: ' + String(response.status) + ' ' + response.statusText,
        response.status,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(body) as unknown;
    } catch {
      throw discoveryError('Failed to parse Gemini model catalogue JSON');
    }
    if (!isRecord(data) || !Array.isArray(data.models)) {
      throw discoveryError('No models found in response');
    }
    for (const value of data.models) {
      const model = parseModel(value);
      if (model) models.push(model);
    }
    if (data.nextPageToken === undefined) {
      return requireDistinctModels(models, 'Gemini', discoveryError);
    }
    if (typeof data.nextPageToken !== 'string' || data.nextPageToken.length === 0) {
      throw discoveryError('Invalid model pagination token');
    }
    pageToken = data.nextPageToken;
  }
  throw discoveryError('Too many model catalogue pages');
}
