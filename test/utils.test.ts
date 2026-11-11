import { test, expect } from 'bun:test';
import {
  estimateTokenCount,
  pushHunkToTop,
  formatCommitMessage,
  shouldExcludeFile,
  sanitizeForDisplay,
  stripTerminalControlSequences,
  redactSensitiveText,
  redactSensitiveTextForPrompt,
} from '../src/utils';
import type { Hunk } from '../src/utils';

// --- Tests for pushHunkToTop ---
const createHunk = (file: string, score: number): Hunk => ({
  file,
  score,
  header: '',
  content: '',
  added: 0,
  removed: 0,
});

test('utils: pushHunkToTop - should add hunk if array is not full', () => {
  const array: Hunk[] = [];
  pushHunkToTop(array, createHunk('file1', 10), 3);
  expect(array.length).toBe(1);
  expect(array[0].file).toBe('file1');
});

test('utils: pushHunkToTop - should not add hunk if score is too low and array is full', () => {
  const array = [createHunk('f1', 10), createHunk('f2', 20)];
  pushHunkToTop(array, createHunk('f3', 5), 2);
  expect(array.length).toBe(2);
  expect(array.find(h => h.file === 'f3')).toBeUndefined();
});

test('utils: pushHunkToTop - should replace lowest score hunk if array is full', () => {
  const array = [createHunk('f1', 10), createHunk('f2', 20)];
  pushHunkToTop(array, createHunk('f3', 15), 2);
  expect(array.length).toBe(2);
  expect(array.find(h => h.file === 'f1')).toBeUndefined();
  expect(array.find(h => h.file === 'f3')).toBeDefined();
});

test('utils: pushHunkToTop - should handle empty array', () => {
  const array: Hunk[] = [];
  pushHunkToTop(array, createHunk('f1', 10), 1);
  expect(array.length).toBe(1);
});

test('utils: pushHunkToTop - ignores zero capacity', () => {
  const array: Hunk[] = [];
  pushHunkToTop(array, createHunk('f1', 10), 0);
  expect(array).toEqual([]);
});

// --- Tests for formatCommitMessage ---
test('utils: formatCommitMessage - should preserve short messages', () => {
  const msg = 'feat: add new feature';
  expect(formatCommitMessage(msg)).toBe(msg);
});

test('utils: formatCommitMessage - should preserve long single-line messages without wrapping', () => {
  const msg =
    'feat: this is a very long commit message that exceeds the maximum allowed first line length';
  const result = formatCommitMessage(msg);
  expect(result).toBe(msg);
});

test('utils: formatCommitMessage - should ensure empty line between subject and body', () => {
  const msg = `feat: add feature\nThis is the body line`;
  const result = formatCommitMessage(msg);
  expect(result).toBe('feat: add feature\n\nThis is the body line');
});

test('utils: formatCommitMessage - should preserve bullet points without wrapping', () => {
  const msg = `feat: add feature\n\n- This is a long bullet point item that might exceed the eighty character limit and should be preserved`;
  const result = formatCommitMessage(msg);
  expect(result).toBe(msg);
});

test('utils: formatCommitMessage - should preserve backticks', () => {
  const msg = `feat: add \`formatCommitMessage\` function\n\nImplemented a new formatter that wraps long lines while preserving \`backtick-enclosed\` code spans`;
  const result = formatCommitMessage(msg);
  expect(result).toContain('`formatCommitMessage`');
  expect(result).toContain('`backtick-enclosed`');
});

test('utils: formatCommitMessage - should ensure double newline separating subject and body', () => {
  const msg = `feat: add feature\n\nBody paragraph one\nBody paragraph two`;
  const result = formatCommitMessage(msg);
  expect(result).toBe('feat: add feature\n\nBody paragraph one\nBody paragraph two');
});

test('utils: formatCommitMessage - should handle multiple short bullet points', () => {
  const msg = `feat: add feature\n\n- Item 1\n- Item 2\n- Item 3`;
  const result = formatCommitMessage(msg);
  expect(result).toContain('- Item 1');
  expect(result).toContain('- Item 2');
  expect(result).toContain('- Item 3');
});

test('utils: formatCommitMessage - should preserve long bullet continuation without wrapping', () => {
  const msg = `fix: resolve issues\n\n- This is an extremely long bullet point that definitely exceeds eighty characters and must be preserved without manual wrapping`;
  const result = formatCommitMessage(msg);
  expect(result).toBe(msg);
});

test('utils: formatCommitMessage - should handle empty string', () => {
  expect(formatCommitMessage('')).toBe('');
});

// --- Tests for shouldExcludeFile ---
test('utils: shouldExcludeFile - should match exact patterns', () => {
  expect(shouldExcludeFile('manifest.json', ['manifest.json'])).toBe(true);
  expect(shouldExcludeFile('package.json', ['manifest.json'])).toBe(false);
});

test('utils: shouldExcludeFile - should match wildcard patterns', () => {
  expect(shouldExcludeFile('manifest.json', ['*manifest*'])).toBe(true);
  expect(shouldExcludeFile('src/manifest.json', ['*manifest*'])).toBe(true);
  expect(shouldExcludeFile('manifest-prod.json', ['*manifest*'])).toBe(true);
  expect(shouldExcludeFile('package.json', ['*manifest*'])).toBe(false);
});

test('utils: shouldExcludeFile - asterisk crosses directory separators', () => {
  expect(shouldExcludeFile('a/b/c.env', ['*.env'])).toBe(true);
});

test('utils: shouldExcludeFile - asterisk alone matches every path', () => {
  expect(shouldExcludeFile('a/b/c.env', ['*'])).toBe(true);
});

test('utils: shouldExcludeFile - question mark matches exactly one character', () => {
  expect(shouldExcludeFile('file1.env', ['file?.env'])).toBe(true);
  expect(shouldExcludeFile('file12.env', ['file?.env'])).toBe(false);
});

test('utils: shouldExcludeFile - patterns are case-sensitive', () => {
  expect(shouldExcludeFile('UPPER.ENV', ['*.env'])).toBe(false);
});

test('utils: shouldExcludeFile - patterns are anchored at both ends', () => {
  expect(shouldExcludeFile('config/.env', ['.env'])).toBe(false);
});

test('utils: shouldExcludeFile - a question mark filename character matches question mark', () => {
  expect(shouldExcludeFile('file?.env', ['file?.env'])).toBe(true);
});

test('utils: shouldExcludeFile - should match multiple patterns', () => {
  expect(shouldExcludeFile('manifest.json', ['*manifest*', '*lock*'])).toBe(true);
  expect(shouldExcludeFile('package-lock.json', ['*manifest*', '*lock*'])).toBe(true);
  expect(shouldExcludeFile('src/app.ts', ['*manifest*', '*lock*'])).toBe(false);
});

test('utils: shouldExcludeFile - should match extension patterns', () => {
  expect(shouldExcludeFile('file.lock', ['*.lock'])).toBe(true);
  expect(shouldExcludeFile('package-lock.json', ['*.lock'])).toBe(false);
});

test('utils: shouldExcludeFile - should handle empty patterns', () => {
  expect(shouldExcludeFile('manifest.json', [])).toBe(false);
  expect(shouldExcludeFile('manifest.json', [''])).toBe(false);
});

test('utils: shouldExcludeFile - should handle path-based patterns', () => {
  expect(shouldExcludeFile('dist/manifest.json', ['dist/*'])).toBe(true);
  expect(shouldExcludeFile('src/manifest.json', ['dist/*'])).toBe(false);
});

test('utils: shouldExcludeFile - should be case-sensitive', () => {
  expect(shouldExcludeFile('Manifest.json', ['*manifest*'])).toBe(false);
  expect(shouldExcludeFile('manifest.json', ['*manifest*'])).toBe(true);
});

// --- Tests for sanitizeForDisplay ---
test('utils: sanitizeForDisplay - should pass marker-like literals through unchanged', () => {
  const input = 'Docs: explain what <<END>> marker means for parser behavior';
  const result = sanitizeForDisplay(input);
  expect(result).toBe(input);
});

test('utils: sanitizeForDisplay - should preserve regular content', () => {
  const input = 'feat(api): add new endpoint\n\n- Add authentication\n- Update tests';
  const result = sanitizeForDisplay(input);
  expect(result).toBe(input);
});

test('utils: sanitizeForDisplay - should remove non-printable characters', () => {
  const input = 'content\x00with\x01special\x02chars';
  const result = sanitizeForDisplay(input);
  expect(result).toBe('contentwithspecialchars');
});

test('utils: sanitizeForDisplay - should remove complete ANSI escape sequences', () => {
  expect(sanitizeForDisplay('\u001B[31mfeat: red\u001B[0m')).toBe('feat: red');
});

test('utils: sanitizeForDisplay - should preserve tabs, newlines, and carriage returns', () => {
  const input = 'line1\nline2\tindented\rcarriage';
  const result = sanitizeForDisplay(input);
  expect(result).toBe(input);
});

test('utils: sanitizeForDisplay - should handle empty string', () => {
  const result = sanitizeForDisplay('');
  expect(result).toBe('');
});

test('utils: stripTerminalControlSequences removes ANSI and controls but keeps newlines and tabs', () => {
  expect(
    stripTerminalControlSequences(
      'first\tline\n\u001B]8;;https://example.test\u0007link\u001B]8;;\u0007\u009B2J\u0000',
    ),
  ).toBe('first\tline\nlink');
});

test('utils: redactSensitiveText keeps broad log redaction', () => {
  expect(
    redactSensitiveText('const opt = "sk-optional-flag"; docs mention AIzaSyExample1234'),
  ).toBe('const opt = "[REDACTED-KEY]"; docs mention [REDACTED-KEY]');
});

test('utils: secret redaction removes Authorization credentials', () => {
  const input = [
    'Authorization: Bearer arbitrary-secret',
    'Authorization: Basic dXNlcjpwYXNz',
    'Authorization: Digest opaque-secret',
  ].join('\n');
  const expected = [
    'Authorization: Bearer [REDACTED]',
    'Authorization: Basic [REDACTED]',
    'Authorization: Digest [REDACTED]',
  ].join('\n');

  expect(redactSensitiveText(input)).toBe(expected);
  expect(redactSensitiveTextForPrompt(input)).toBe(expected);
});

test('utils: prompt redaction removes URL credentials, vendor tokens and secret assignments', () => {
  const glpat = 'glpat-' + 'aB3dE5gH7jK9mN1pQ3rS5';
  const stripe = 'sk_live_' + 'aB3dE5gH7jK9mN1p';
  const cases: [string, string][] = [
    ['postgres://user:p4ssw0rd@host/db', 'postgres://user:[REDACTED]@host/db'],
    ['redis://:x@h', 'redis://:[REDACTED]@h'],
    [glpat, '[REDACTED-KEY]'],
    [stripe, '[REDACTED-KEY]'],
    ['rk_live_' + 'aB3dE5gH7jK9mN1p', '[REDACTED-KEY]'],
    ['gho_' + 'aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5', '[REDACTED-KEY]'],
    ['ghs_' + 'aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5', '[REDACTED-KEY]'],
    ['npm_' + 'aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5', '[REDACTED-KEY]'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'AWS_SECRET_ACCESS_KEY=[REDACTED]'],
    ['+export DB_PASSWORD="hunter2Pass!"', '+export DB_PASSWORD="[REDACTED]"'],
    ['-API_KEY=abcdefgh1234', '-API_KEY=[REDACTED]'],
    [' STRIPE_TOKEN=abcdefgh1234', ' STRIPE_TOKEN=[REDACTED]'],
    ['+  API_KEY=abcdefgh1234', '+  API_KEY=[REDACTED]'],
    ['+token=opaque-value-123', '+token=[REDACTED]'],
    ['spring.datasource.password=opaque-value-123', 'spring.datasource.password=[REDACTED]'],
    ['+PASSWORD="abcdefgh1234 restsecret5678"', '+PASSWORD="[REDACTED]"'],
    ["export  DB_PASSWD='abcdefgh1234'\r", "export  DB_PASSWD='[REDACTED]'\r"],
    ['const apiKey = "abcdefgh12345";', 'const apiKey = "[REDACTED]";'],
    ['{"client_secret": "abcdefgh12345"}', '{"client_secret": "[REDACTED]"}'],
    ["password: 'abcdefgh12345'", "password: '[REDACTED]'"],
  ];
  for (const [input, expected] of cases) expect(redactSensitiveTextForPrompt(input)).toBe(expected);
});

test('utils: prompt redaction replaces PEM private key blocks', () => {
  expect(
    redactSensitiveTextForPrompt(
      'a\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nb',
    ),
  ).toBe('a\n[REDACTED-PEM]\nb');
});

test('utils: prompt redaction leaves ordinary code and placeholders untouched', () => {
  const inputs = [
    'const token = getToken(request);',
    '  token = getToken(request);',
    'fix: preserve token=optional',
    'fix(auth): reject password: shorter than 8 chars',
    'API_KEY=$OTHER_VAR',
    'PASSWORD=<your-password>',
    'TOKEN=aaaaaaaa',
    'https://example.com/path?user=a@b',
    'password: "short"',
    'password: "Password must be at least 8 characters"',
    '@@ -1,3 +1,4 @@\n function add(a: number, b: number) {\n-  return a + b;\n+  const sum = a + b;\n+  return sum;\n }',
  ];
  for (const input of inputs) expect(redactSensitiveTextForPrompt(input)).toBe(input);
});

test('utils: prompt redaction covers unquoted, spaced and vendor secrets', () => {
  const cases: [string, string][] = [
    ['+password: hunter2correct', '+password: [REDACTED]'],
    ['+  token: abcdefghij12345', '+  token: [REDACTED]'],
    ['MY_PASSWORD = abcdefgh1234', 'MY_PASSWORD = [REDACTED]'],
    ['DB_PASS=abcdefgh1234', 'DB_PASS=[REDACTED]'],
    ['pass=abcdefgh1234', 'pass=[REDACTED]'],
    ['token=abcdefgh1234', 'token=[REDACTED]'],
    ['DB_PWD: abcdefgh1234', 'DB_PWD: [REDACTED]'],
    ['curl -H "x: Bearer abcdefghijklmnop1234"', 'curl -H "x: Bearer [REDACTED]"'],
    ['xoxb-' + '123456789012-123456789012-aB3dE5gH7jK9mN1pQ3rS5tU7', '[REDACTED-KEY]'],
    ['xoxp-' + '123456789012-aB3dE5gH7jK9mN1pQ3rS5tU7', '[REDACTED-KEY]'],
    ['xoxa-2-' + 'aB3dE5gH7jK9mN1pQ3rS5tU7', '[REDACTED-KEY]'],
    ['sk_test_' + 'aB3dE5gH7jK9mN1p', '[REDACTED-KEY]'],
    ['rk_test_' + 'aB3dE5gH7jK9mN1p', '[REDACTED-KEY]'],
    ['ya29.' + 'aB3dE5gH7jK9mN1pQ3rS5tU7', '[REDACTED-KEY]'],
    ['a\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef', 'a\n[REDACTED-PEM]'],
    [
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\nxyz',
      '[REDACTED-PEM]\n[REDACTED-PEM]',
    ],
  ];
  for (const [input, expected] of cases) expect(redactSensitiveTextForPrompt(input)).toBe(expected);
});

test('utils: prompt redaction leaves non-secret values untouched', () => {
  const inputs = [
    'password: ""',
    'token: null',
    'password: string',
    'passwordField = input.value',
    'password = req.body.password',
    'password: ${DB_PASSWORD}',
    'token: process.env.TOKEN_VALUE2',
    'DB_PASS=short1',
    'password: [REDACTED]',
    'bypass = abcdefgh1234',
    'passenger: abcdefgh1234',
    'Bearer authentication scheme',
    'Bearer token',
    'ya29.short',
    '-----BEGIN CERTIFICATE-----\nabc',
  ];
  for (const input of inputs) expect(redactSensitiveTextForPrompt(input)).toBe(input);
});

test('utils: prompt redaction runs in linear time on abusive input', () => {
  const inputs = ['A_'.repeat(100_000) + '=', '://a:'.repeat(40_000), '"'.repeat(200_000)];
  for (const input of inputs) {
    const start = performance.now();
    redactSensitiveTextForPrompt(input);
    expect(performance.now() - start).toBeLessThan(1000);
  }
});

test('utils: prompt redaction truncated PEM keeps surrounding text', () => {
  const cases: [string, string][] = [
    [
      'see -----BEGIN RSA PRIVATE KEY----- mention and more code after',
      'see [REDACTED-PEM] mention and more code after',
    ],
    [
      'k = "-----BEGIN PRIVATE KEY-----"\nconst next = 1;\n+++ b/other.ts',
      'k = "[REDACTED-PEM]"\nconst next = 1;\n+++ b/other.ts',
    ],
    [
      '+-----BEGIN PRIVATE KEY-----\n+MIIEvQIBADANBg\n+kqhkiG9w0BAQE=\n+const x = 1;',
      '+[REDACTED-PEM]\n+const x = 1;',
    ],
    [
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nMIIabc\nafter code here',
      '[REDACTED-PEM]\nafter code here',
    ],
  ];
  for (const [input, expected] of cases) expect(redactSensitiveTextForPrompt(input)).toBe(expected);
  const long =
    '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(64).concat('\n').repeat(500) + 'tail code';
  const out = redactSensitiveTextForPrompt(long);
  expect(out.startsWith('[REDACTED-PEM]')).toBe(true);
  expect(out.endsWith('tail code')).toBe(true);
});

test('utils: prompt redaction handles key-name suffixes and skips code-like values', () => {
  const redacted: [string, string][] = [
    ['SECRET_KEY = "django-insecure-abc123xyz"', 'SECRET_KEY = "[REDACTED]"'],
    ['SECRET_KEY: abc123xyz456', 'SECRET_KEY: [REDACTED]'],
    ['secret_key: "abcd1234efgh"', 'secret_key: "[REDACTED]"'],
    ['DB_PASSWORD_HASH: abc123xyz456', 'DB_PASSWORD_HASH: [REDACTED]'],
  ];
  for (const [input, expected] of redacted)
    expect(redactSensitiveTextForPrompt(input)).toBe(expected);
  const untouched = [
    'password = getPass1()',
    'passwd: /etc/passwd2',
    'PWD=/home/user2',
    'token: tokens[0]1',
    'token: ./dir/file1.txt',
    'token: ~/file1.txt',
    'token: {a1b2c3d4e5}',
    'token: foo.bar1.baz()',
  ];
  for (const input of untouched) expect(redactSensitiveTextForPrompt(input)).toBe(input);
});

test('utils: prompt redaction is fast on 100k-character lines', () => {
  for (const input of ['a'.repeat(100_000), ' '.repeat(100_000)]) {
    const start = performance.now();
    redactSensitiveTextForPrompt(input);
    expect(performance.now() - start).toBeLessThan(100);
  }
});

// --- Tests for estimateTokenCount ---
test('utils: estimateTokenCount - should estimate tokens for various lengths', () => {
  const ratio = 4; // Simple ratio for testing
  expect(estimateTokenCount('', ratio)).toBe(0);
  expect(estimateTokenCount('hello', ratio)).toBe(2); // 5 bytes / 4 -> ceil(1.25) = 2
  expect(estimateTokenCount('a b c d', ratio)).toBe(2); // 7 bytes / 4 -> ceil(1.75) = 2
});

test('utils: estimateTokenCount - should handle unicode characters', () => {
  const ratio = 4;
  // '你好' is 6 bytes
  expect(estimateTokenCount('你好', ratio)).toBe(2); // 6 bytes / 4 -> ceil(1.5) = 2
  // 'a你好b' is 8 bytes
  expect(estimateTokenCount('a你好b', ratio)).toBe(2); // 8 bytes / 4 -> ceil(2) = 2
});

test('utils: sanitizeForDisplay - trims in linear time on long whitespace runs', () => {
  const single = 'a' + ' '.repeat(200_000) + 'x';
  const multi = ('a' + ' '.repeat(50_000) + '\n').repeat(4) + 'b' + ' \t'.repeat(100_000) + 'x';
  const start = performance.now();
  expect(sanitizeForDisplay(single)).toBe(single);
  expect(sanitizeForDisplay(multi)).toBe(multi);
  expect(sanitizeForDisplay('  a \t b \t \n ')).toBe('a \t b \t \n');
  expect(sanitizeForDisplay('x' + ' \t'.repeat(100_000))).toBe('x');
  expect(performance.now() - start).toBeLessThan(200);
});

test('utils: secret literal entropy boundary is 8 distinct characters', () => {
  expect(redactSensitiveTextForPrompt('password = "abcdefgh"')).toBe('password = "[REDACTED]"');
  expect(redactSensitiveTextForPrompt('password = "abcdefgg"')).toBe('password = "abcdefgg"');
});
