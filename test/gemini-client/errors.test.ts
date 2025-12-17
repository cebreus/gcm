import { test, expect } from 'bun:test';
import { GeminiError, GeminiJsonError, GeminiApiError } from '../../src/gemini-client/errors';

test('errors: GeminiError - should instantiate with a message', () => {
  const err = new GeminiError('Test message');
  expect(err.message).toBe('Test message');
  expect(err.name).toBe('GeminiError');
  expect(err.metadata).toEqual({});
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(GeminiError);
});

test('errors: GeminiError - should instantiate with metadata', () => {
  const metadata = { code: 500, details: 'server error' };
  const err = new GeminiError('Test message', metadata);
  expect(err.metadata).toEqual(metadata);
});

test('errors: GeminiJsonError - should have correct name and inheritance', () => {
  const err = new GeminiJsonError('JSON parsing failed');
  expect(err.name).toBe('GeminiJsonError');
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(GeminiError);
  expect(err).toBeInstanceOf(GeminiJsonError);
});

test('errors: GeminiApiError - should have correct name and inheritance', () => {
  const err = new GeminiApiError('API call failed');
  expect(err.name).toBe('GeminiApiError');
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(GeminiError);
  expect(err).toBeInstanceOf(GeminiApiError);
});

test('errors: should serialize with message and metadata', () => {
  const err = new GeminiApiError('API call failed', { status: 429 });
  const errString = err.toString();
  expect(errString).toContain('GeminiApiError: API call failed');
  // Note: metadata is not part of the default .toString()
});
