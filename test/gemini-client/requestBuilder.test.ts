import { test, expect } from 'bun:test';
import { buildRequestBody } from '../../src/gemini-client/requestBuilder';
import { CONFIG } from '../../gcm.config';

// Create a deep copy of CONFIG to modify for tests
const testConfig = JSON.parse(JSON.stringify(CONFIG));

test('requestBuilder: should build a basic request structure', () => {
  const body = buildRequestBody('test content', testConfig, {}, false);

  expect(body.contents[0].role).toBe('user');
  expect(body.contents[0].parts[0].text).toBe('test content');
  expect(body.generationConfig.temperature).toBe(testConfig.TEMPERATURE);
  expect(body.generationConfig.maxOutputTokens).toBe(testConfig.MAX_OUTPUT_TOKENS);
  expect(body.systemInstruction.parts[0].text).toBe('');
});

test('requestBuilder: should enable thinking mode when requested', () => {
  const body = buildRequestBody('test content', testConfig, {}, true);
  expect(body.generationConfig.thinkingConfig).toEqual({ thinkingMode: 'THINKING_MODE_EXTENDED' });
});

test('requestBuilder: should not have thinking mode when disabled', () => {
  const body = buildRequestBody('test content', testConfig, {}, false);
  expect(body.generationConfig.thinkingConfig).toBeUndefined();
});

test('requestBuilder: should allow overriding maxOutputTokens', () => {
  const body = buildRequestBody('test content', testConfig, { maxOutputTokens: 1234 }, false);
  expect(body.generationConfig.maxOutputTokens).toBe(1234);
});

test('requestBuilder: should include system instructions when provided', () => {
  const instructions = 'You are a helpful assistant.';
  const body = buildRequestBody(
    'test content',
    testConfig,
    { systemInstructions: instructions },
    false,
  );
  expect(body.systemInstruction.parts[0].text).toBe(instructions);
});

test('requestBuilder: should use temperature from config', () => {
  testConfig.TEMPERATURE = 0.5;
  const body = buildRequestBody('test content', testConfig, {}, false);
  expect(body.generationConfig.temperature).toBe(0.5);
  // Reset for other tests
  testConfig.TEMPERATURE = CONFIG.TEMPERATURE;
});

test('requestBuilder: should build a valid request body with all options', () => {
  const instructions = 'System instructions here.';
  const body = buildRequestBody(
    'User content here.',
    testConfig,
    { systemInstructions: instructions, maxOutputTokens: 500 },
    true,
  );

  expect(body).toEqual({
    contents: [{ role: 'user', parts: [{ text: 'User content here.' }] }],
    systemInstruction: { parts: [{ text: instructions }] },
    generationConfig: {
      temperature: testConfig.TEMPERATURE,
      maxOutputTokens: 500,
      thinkingConfig: { thinkingMode: 'THINKING_MODE_EXTENDED' },
    },
  });
});
