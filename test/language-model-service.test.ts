import { expect, test } from 'bun:test';
import {
  createLanguageModelApiError,
  getModelSpecValidationError,
  isLanguageModelApiError,
} from '../src/language-model-service.js';

test('language model errors require an explicit discriminator', function () {
  expect(
    isLanguageModelApiError(Object.assign(new Error('unrelated'), { metadata: {} })),
  ).toBeFalse();
  expect(isLanguageModelApiError(createLanguageModelApiError('provider failed'))).toBeTrue();
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
