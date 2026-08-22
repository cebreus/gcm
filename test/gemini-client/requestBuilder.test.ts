import { test, expect } from 'bun:test';
import { buildRequestBody } from '../../src/gemini-client/requestBuilder';
import { CONFIG } from '../../gcm.config';

// Create a deep copy of CONFIG to modify for tests
const testConfig = JSON.parse(JSON.stringify(CONFIG));

test('requestBuilder: should build a basic request structure', () => {
  const body = buildRequestBody('test content', testConfig, {}, false);

  expect(body.contents[0].role).toBe('user');
  // Expect markers to be present by default
  expect(body.contents[0].parts[0].text).toBe('<<START>>\ntest content\n<<END>>');
  expect(body.generationConfig.temperature).toBe(testConfig.TEMPERATURE);
  expect(body.generationConfig.maxOutputTokens).toBe(testConfig.MAX_OUTPUT_TOKENS);
  expect(body.systemInstruction.parts[0].text).toContain('<<START>>');
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
  // Should include the provided instructions and our marker-focused instruction
  expect(body.systemInstruction.parts[0].text).toContain(instructions);
  expect(body.systemInstruction.parts[0].text).toContain('<<START>>');
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

  // Content should be wrapped with markers
  expect(body.contents[0].parts[0].text).toBe('<<START>>\nUser content here.\n<<END>>');
  // System instruction should include both the provided instructions and our marker guidance
  expect(body.systemInstruction.parts[0].text).toContain(instructions);
  expect(body.systemInstruction.parts[0].text).toContain('<<START>>');
  expect(body.generationConfig).toEqual({
    temperature: testConfig.TEMPERATURE,
    maxOutputTokens: 500,
    thinkingConfig: { thinkingMode: 'THINKING_MODE_EXTENDED' },
  });
});

test('requestBuilder: redacts secrets from staged diff content without changing ordinary content', () => {
  const stagedDiff = '+ const apiKey = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890";\n+ const name = "ordinary";';
  const body = buildRequestBody(stagedDiff, testConfig, {}, false);

  expect(body.contents[0].parts[0].text).toContain('[REDACTED-KEY]');
  expect(body.contents[0].parts[0].text).not.toContain('sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890');
  expect(body.contents[0].parts[0].text).toContain('+ const name = "ordinary";');
});

test('requestBuilder: only redacts genuine secrets from outbound content', () => {
  const content = [
    'const opt = "sk-optional-flag";',
    'docs mention AIzaSyExample1234 in a doc',
    'const key = "AIzaSyD3m0K3yAbCdEfGhIjKlMnOpQrStUvWxYz";',
    'const token = "github_pat_11AaaBbbCccDddEeeFffGggHhhIiiJjjKkkLllMmmNnnOooPppQqqRrrSssTttUuuVvvWwwXxxYyyZzz";',
  ].join('\n');
  const body = buildRequestBody(content, testConfig, {}, false);
  const outbound = body.contents[0].parts[0].text;

  expect(outbound).toContain('sk-optional-flag');
  expect(outbound).toContain('AIzaSyExample1234');
  expect(outbound).not.toContain('AIzaSyD3m0K3yAbCdEfGhIjKlMnOpQrStUvWxYz');
  expect(outbound).not.toContain('github_pat_11AaaBbbCccDddEeeFffGggHhhIiiJjjKkkLllMmmNnnOooPppQqqRrrSssTttUuuVvvWwwXxxYyyZzz');
  expect(outbound.match(/\[REDACTED-KEY\]/g)).toHaveLength(2);
});

test('requestBuilder: redacts every supported genuine secret shape outbound', () => {
  const secrets = [
    'AQ.Abcdef1234567890QwertyUiop',
    'AIzaSyD3m0K3yAbCdEfGhIjKlMnOpQrStUvWxYz',
    'github_pat_11AaaBbbCccDddEeeFffGggHhhIiiJjjKkkLllMmmNnnOooPppQqqRrrSssTttUuuVvvWwwXxxYyyZzz',
    'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-123456-789012-AbCdEfGhIjKlMnOpQrStUvWxYz123456',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvZSJ9.c2lnbmF0dXJlVmFsdWUxMjM0NTY3ODkw',
    '-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----',
  ];
  const outbound = buildRequestBody(secrets.join('\n'), testConfig, {}, false).contents[0].parts[0].text;

  for (const secret of secrets) expect(outbound).not.toContain(secret);
  expect(outbound.match(/\[REDACTED-(?:KEY|JWT|PEM)\]/g)).toHaveLength(secrets.length);
});
