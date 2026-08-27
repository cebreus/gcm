import type { ModelSpec } from '../model-registry.js';
import { createLanguageModelApiError, isLanguageModelName } from '../language-model-service.js';
import { requestProviderText } from '../provider-http.js';
import { CONFIG } from '../../gcm.config.js';

const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_MODEL_PAGES = 20;

function discoveryError(
  message: string,
  category: 'auth' | 'data' | 'network' | 'timeout' | 'unavailable',
  status?: number,
): Error {
  return createLanguageModelApiError(message, {
    category,
    ...(status === undefined ? {} : { status }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function httpErrorCategory(status: number): 'auth' | 'data' | 'unavailable' {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'data';
}

function parseModel(value: unknown): ModelSpec | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  if (
    !Array.isArray(value.supportedGenerationMethods) ||
    !value.supportedGenerationMethods.includes('generateContent')
  ) {
    return null;
  }
  const maxInputTokens = readPositiveInteger(value.inputTokenLimit);
  const maxOutputTokens = readPositiveInteger(value.outputTokenLimit);
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
  const names = new Set<string>();
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
        throw discoveryError('Gemini model catalogue response body is too large', 'data');
      }
      throw discoveryError(
        timedOut ? 'Gemini model discovery timed out' : 'Gemini model discovery failed',
        timedOut ? 'timeout' : 'network',
      );
    }
    const { response, body } = result;
    if (!response.ok) {
      throw discoveryError(
        'Failed to fetch models: ' + String(response.status) + ' ' + response.statusText,
        httpErrorCategory(response.status),
        response.status,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(body) as unknown;
    } catch {
      throw discoveryError('Failed to parse Gemini model catalogue JSON', 'data');
    }
    if (!isRecord(data) || !Array.isArray(data.models)) {
      throw discoveryError('No models found in response', 'data');
    }
    for (const value of data.models) {
      const model = parseModel(value);
      if (!model) continue;
      if (names.has(model.name)) {
        throw discoveryError('Duplicate Gemini model identifier', 'data');
      }
      names.add(model.name);
      models.push(model);
    }
    if (data.nextPageToken === undefined) {
      if (models.length === 0) {
        throw discoveryError('Gemini returned no compatible text models', 'data');
      }
      return models;
    }
    if (typeof data.nextPageToken !== 'string' || data.nextPageToken.length === 0) {
      throw discoveryError('Invalid model pagination token', 'data');
    }
    pageToken = data.nextPageToken;
  }
  throw discoveryError('Too many model catalogue pages', 'data');
}
