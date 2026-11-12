import type { Config } from '../gcm.config.js';
import {
  type LanguageModelErrorKind,
  createLanguageModelApiError,
  isLanguageModelName,
} from './language-model-service.js';
import {
  type ModelSpec,
  readPositiveTokenCount,
  requireDistinctModels,
} from './model-registry.js';
import {
  ResponseBodyTooLargeError,
  isRequestTimeout,
  requestProviderText,
} from './provider-http.js';
import { isRecord } from './utils.js';

const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_MODEL_PAGES = 20;
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

function discoveryError(
  message: string,
  status?: number,
  kind?: LanguageModelErrorKind,
): Error {
  return createLanguageModelApiError(message, {
    ...(status === undefined ? {} : { status }),
    ...(kind === undefined ? {} : { kind }),
  });
}

function parseModel(value: unknown): ModelSpec | null {
  if (!isRecord(value) || typeof value.name !== 'string') {
    return null;
  }
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
    typeof value.displayName === 'string' &&
    isLanguageModelName(value.displayName)
      ? value.displayName
      : value.name;
  return {
    name: value.name,
    label,
    limits: { kind: 'separate', maxInputTokens, maxOutputTokens },
  };
}

async function requestModelPage(options: {
  apiKey: string;
  pageToken: string | null;
  config: Pick<Config, 'MAX_RETRIES' | 'RETRY_BASE_MS' | 'RETRY_MAX_MS'>;
}): Promise<Awaited<ReturnType<typeof requestProviderText>>> {
  const { apiKey, pageToken, config } = options;
  const url = new URL(MODELS_URL);
  if (pageToken !== null) {
    url.searchParams.set('pageToken', pageToken);
  }
  try {
    return await requestProviderText({
      url,
      init: { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
      timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
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
      throw discoveryError(
        'Gemini model discovery timed out',
        undefined,
        'timeout',
      );
    }
    throw discoveryError('Gemini model discovery failed');
  }
}

interface ModelPage {
  models: unknown[];
  nextPageToken?: unknown;
}

function parseModelPage(body: string): ModelPage {
  const data = parseJson(body);
  if (!isRecord(data) || !Array.isArray(data.models)) {
    throw discoveryError('No models found in response', undefined, 'no-models');
  }
  return { models: data.models, nextPageToken: data.nextPageToken };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw discoveryError('Failed to parse Gemini model catalogue JSON');
  }
}

export async function listGeminiModels(
  apiKey: string,
  config: Pick<Config, 'MAX_RETRIES' | 'RETRY_BASE_MS' | 'RETRY_MAX_MS'>,
): Promise<ModelSpec[]> {
  const models: ModelSpec[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- each page token comes from the previous ordered response
    const result = await requestModelPage({ apiKey, pageToken, config });
    const { response, body } = result;
    if (!response.ok) {
      throw discoveryError(
        `Failed to fetch models: ${String(response.status)} ${
          response.statusText
        }`,
        response.status,
        'connection',
      );
    }
    const data = parseModelPage(body);
    for (const value of data.models) {
      const model = parseModel(value);
      if (model !== null) {
        models.push(model);
      }
    }
    const { nextPageToken } = data;
    if (nextPageToken === undefined) {
      return requireDistinctModels(models, 'Gemini', (message, metadata) =>
        discoveryError(message, undefined, metadata?.kind),
      );
    }
    if (typeof nextPageToken !== 'string' || nextPageToken.length === 0) {
      throw discoveryError(
        'Invalid model pagination token',
        undefined,
        'invalid-model',
      );
    }
    pageToken = nextPageToken;
  }
  throw discoveryError('Too many model catalogue pages');
}
