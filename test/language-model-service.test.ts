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
    limits: { kind: 'separate' as const, maxInputTokens: 8_192, maxOutputTokens: 1_024 },
  };
  return {
    id: 'local',
    label: 'Local',
    defaultModel: 'qwen/qwen3-8b',
    models: async function () {
      return [fallbackModel];
    },
    service: {
      generate: async function () {
        return null;
      },
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
  expect(
    getLanguageModelProviderValidationError(createProvider({ models: undefined as never })),
  ).toBe('Provider requires a model catalogue');
});

test('provider validation rejects bidirectional model-name controls', function () {
  expect(
    getModelSpecValidationError({
      name: 'safe\u202Etxt',
      label: 'safe',
      limits: { kind: 'shared-context', contextWindowTokens: 8_192 },
    }),
  ).toBe('Invalid model name');
});

test('model validation accepts provider-specific ids and rejects unsafe runtime specs', function () {
  expect(
    getModelSpecValidationError({
      name: 'org/model@q4 k m',
      label: 'Model',
      limits: { kind: 'separate' as const, maxInputTokens: 8_192, maxOutputTokens: 1_024 },
    }),
  ).toBeNull();
  expect(
    getModelSpecValidationError(
      {
        name: 'other',
        label: 'Other',
        limits: { kind: 'separate' as const, maxInputTokens: 8_192, maxOutputTokens: 1_024 },
      },
      'selected',
    ),
  ).toBe('Invalid model name');
});
