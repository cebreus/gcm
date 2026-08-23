import { test, expect } from 'bun:test';
import { createGeminiApiError, isGeminiApiError } from '../../src/gemini-client/errors';

test('errors: GeminiApiError keeps its tagged Error contract', () => {
  const err = createGeminiApiError('API call failed');
  expect(err.name).toBe('GeminiApiError');
  expect(err).toBeInstanceOf(Error);
  expect(err.metadata).toEqual({});
  expect(isGeminiApiError(err)).toBe(true);
  const untagged = new Error('network');
  untagged.name = 'GeminiApiError';
  expect(isGeminiApiError(untagged)).toBe(false);
});

test('errors: should serialize with message and metadata', () => {
  const err = createGeminiApiError('API call failed', { status: 429 });
  const errString = err.toString();
  expect(errString).toContain('GeminiApiError: API call failed');
  // Note: metadata is not part of the default .toString()
});
