import { expect, test } from 'bun:test';
import {
  createLanguageModelApiError,
  getModelSpecValidationError,
  getLanguageModelProviderValidationError,
  isLanguageModelApiError,
  type LanguageModelProvider,
} from '../src/language-model-service.js';

function createProvider(overrides: Partial<LanguageModelProvider> = {}): LanguageModelProvider {
  const fallbackModel = {
    name: 'qwen/qwen3-8b',
    label: 'Qwen',
    maxInputTokens: 8_192,
    maxOutputTokens: 1_024,
  };
  return {
    id: 'local',
    label: 'Local',
    defaultModel: 'qwen/qwen3-8b',
    fallbackModels: [fallbackModel],
    service: {
      generate: async function () {
        return null;
      },
    },
    listModels: async function () {
      return [];
    },
    getModelSpec: function (name) {
      return { name, label: name, maxInputTokens: 8_192, maxOutputTokens: 1_024 };
    },
    ...overrides,
  };
}

test('language model errors require an explicit discriminator', function () {
  expect(
    isLanguageModelApiError(Object.assign(new Error('unrelated'), { metadata: {} })),
  ).toBeFalse();
  expect(isLanguageModelApiError(createLanguageModelApiError('provider failed'))).toBeTrue();
});

test('provider validation rejects terminal controls and unsafe model names', function () {
  expect(getLanguageModelProviderValidationError(createProvider())).toBeNull();
  expect(getLanguageModelProviderValidationError(createProvider({ label: 'Local\u001b[2J' }))).toBe(
    'Invalid language model provider label',
  );
  expect(getLanguageModelProviderValidationError(createProvider({ label: 'Local\nForged' }))).toBe(
    'Invalid language model provider label',
  );
  expect(
    getLanguageModelProviderValidationError(createProvider({ defaultModel: 'bad\nmodel' })),
  ).toBe('Invalid default model name');
  expect(getLanguageModelProviderValidationError(createProvider({ fallbackModels: [] }))).toBe(
    'Provider requires a fallback model',
  );
  expect(
    getLanguageModelProviderValidationError(
      createProvider({
        getModelSpec: function (name) {
          return { name, label: name, maxInputTokens: 1_000, maxOutputTokens: 1_000 };
        },
      }),
    ),
  ).toBe('Invalid model token limits');
});

test('model validation accepts provider-specific ids and rejects unsafe runtime specs', function () {
  expect(
    getModelSpecValidationError({
      name: 'org/model@q4 k m',
      label: 'Model',
      maxInputTokens: 8_192,
      maxOutputTokens: 1_024,
    }),
  ).toBeNull();
  expect(
    getModelSpecValidationError(
      { name: 'other', label: 'Other', maxInputTokens: 8_192, maxOutputTokens: 1_024 },
      'selected',
    ),
  ).toBe('Invalid model name');
});
