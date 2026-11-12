import { expect, test } from 'bun:test';

import {
  createLanguageModelApiError,
  getModelSpecValidationError,
  isLanguageModelApiError,
  isModelUnavailableError,
} from '../src/language-model-service.js';

test('language model errors require an explicit discriminator', () => {
  expect(
    isLanguageModelApiError(
      Object.assign(new Error('unrelated'), { metadata: {} }),
    ),
  ).toBeFalse();
  expect(
    isLanguageModelApiError(createLanguageModelApiError('provider failed')),
  ).toBeTrue();
});

test('provider validation rejects bidirectional model-name controls', () => {
  expect(
    getModelSpecValidationError({
      name: 'safe\u202Etxt',
      label: 'safe',
      limits: { kind: 'shared-context', contextWindowTokens: 8_192 },
    }),
  ).toBe('Invalid model name');
});

test('model validation accepts provider-specific ids and rejects unsafe runtime specs', () => {
  expect(
    getModelSpecValidationError({
      name: 'org/model@q4 k m',
      label: 'Model',
      limits: {
        kind: 'separate' as const,
        maxInputTokens: 8_192,
        maxOutputTokens: 1_024,
      },
    }),
  ).toBeNull();
});

test('authentication and bad-request statuses never count as model unavailable', () => {
  for (const status of [400, 401, 403]) {
    const error = createLanguageModelApiError('rejected', {
      status,
      availability: true,
    });
    expect(isModelUnavailableError(error)).toBeFalse();
  }
  for (const status of [404, 503]) {
    expect(
      isModelUnavailableError(createLanguageModelApiError('down', { status })),
    ).toBeTrue();
  }
});
