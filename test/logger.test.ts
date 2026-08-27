import { test, expect, mock, afterAll, beforeAll, beforeEach } from 'bun:test';
import { createLogger } from '../src/logger';

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
const stdoutWriteMock = mock((_text: string) => true);
const stderrWriteMock = mock((_text: string) => true);

beforeAll(() => {
  process.stdout.write = stdoutWriteMock as unknown as typeof process.stdout.write;
  process.stderr.write = stderrWriteMock as unknown as typeof process.stderr.write;
});

afterAll(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

beforeEach(() => {
  stdoutWriteMock.mockClear();
  stderrWriteMock.mockClear();
});

test('logger: redacts secrets in console output', () => {
  const logger = createLogger({ LOG_LEVEL: 'info' });
  logger.log('info', 'sensitive info', {
    token: 'sk-abcdef1234567890',
    apiKey: 'plain-api-credential',
    password: 'plain-password',
  });

  const output = stdoutWriteMock.mock.calls.map(call => String(call[0])).join('');
  expect(output).toContain('[REDACTED-KEY]');
  expect(output).not.toContain('sk-abcdef1234567890');
  expect(output).not.toContain('plain-api-credential');
  expect(output).not.toContain('plain-password');
});

test('logger: redacts secrets in log messages', () => {
  const logger = createLogger({ LOG_LEVEL: 'info' });
  logger.log('info', 'Model output: sk-abcdef1234567890');

  const output = stdoutWriteMock.mock.calls.map(call => String(call[0])).join('');
  expect(output).toContain('[REDACTED-KEY]');
  expect(output).not.toContain('sk-abcdef1234567890');
});

test('logger: redacts current GitHub and Google keys in messages', () => {
  stdoutWriteMock.mockClear();
  const githubKey = 'github_pat_AaBbCcDdEeFfGgHhIiJjKkLl';
  const googleKey = 'AQ.ZzTestOnly_cDeFgHiJkLmNoPqRsTuVwXyZ1234';
  const logger = createLogger({ LOG_LEVEL: 'info' });

  logger.log('info', 'GitHub key: ' + githubKey + ' is invalid.');
  logger.log('info', JSON.stringify({ provider: 'google', key: googleKey }));
  logger.log('info', 'Google key at end: ' + googleKey);

  const output = stdoutWriteMock.mock.calls.map(call => String(call[0])).join('');
  expect(output.match(/\[REDACTED-KEY\]/g)).toHaveLength(3);
  expect(output).not.toContain(githubKey);
  expect(output).not.toContain(googleKey);
});

test('logger: sanitises terminal controls and nested metadata secrets', () => {
  stdoutWriteMock.mockClear();
  const secret = 'sk-abcdef1234567890';
  const logger = createLogger({ LOG_LEVEL: 'info' });

  logger.log('info', `model\x1B]0;owned\x07 output`, {
    error: { message: `request failed with ${secret}\x1B[31m` },
  });

  const output = stdoutWriteMock.mock.calls.map(call => String(call[0])).join('');
  expect(output).toContain('model output');
  expect(output).toContain('[REDACTED-KEY]');
  expect(output).not.toContain(secret);
  expect(output).not.toContain('\x1B');
});

test('logger: preserves arrays while redacting their values', () => {
  stdoutWriteMock.mockClear();
  const logger = createLogger({ LOG_LEVEL: 'info' });

  logger.log('info', 'array metadata', {
    values: ['safe', { token: 'private' }],
  });

  const output = stdoutWriteMock.mock.calls.map(call => String(call[0])).join('');
  expect(output).toContain('"values":["safe",{"token":"[REDACTED]"}]');
});

test('logger: keeps full redacted messages while truncating metadata', () => {
  stdoutWriteMock.mockClear();
  const logger = createLogger({ LOG_LEVEL: 'info' });
  const messageTail = 'message-tail';
  const metadataTail = 'metadata-tail';
  logger.log('info', 'x'.repeat(256) + messageTail + ' sk-abcdef1234567890', {
    detail: 'x'.repeat(256) + metadataTail,
  });

  const output = stdoutWriteMock.mock.calls.map(call => String(call[0])).join('');
  expect(output).toContain(messageTail);
  expect(output).toContain('[REDACTED-KEY]');
  expect(output).not.toContain('sk-abcdef1234567890');
  expect(output).toContain('...[TRUNCATED]');
  expect(output).not.toContain(metadataTail);
});

test('logger: log level filtering', () => {
  stdoutWriteMock.mockClear();
  stderrWriteMock.mockClear();
  const logger = createLogger({ LOG_LEVEL: 'warn' });

  logger.log('info', 'this should be ignored');
  logger.log('debug', 'this should also be ignored');
  logger.log('warn', 'this is a warning');
  logger.log('error', 'this is an error');

  const stdoutCalls = stdoutWriteMock.mock.calls as unknown as Array<unknown[]>;
  const stderrCalls = stderrWriteMock.mock.calls as unknown as Array<unknown[]>;
  const stdoutOutput = stdoutCalls.map(call => String(call[0])).join('\n');
  const stderrOutput = stderrCalls.map(call => String(call[0])).join('\n');
  expect(stdoutOutput).not.toContain('this should be ignored');
  expect(stdoutOutput).not.toContain('this should also be ignored');
  expect(stdoutOutput).toContain('this is a warning');
  expect(stderrOutput).toContain('this is an error');
});

test('logger: empty log level uses the default', () => {
  stdoutWriteMock.mockClear();
  createLogger({ LOG_LEVEL: '' }).log('info', 'default level');
  const output = stdoutWriteMock.mock.calls.map(call => String(call[0])).join('');
  expect(output).toContain('default level');
});

test('logger: serialises circular and bigint metadata without throwing', () => {
  stdoutWriteMock.mockClear();
  const circular: Record<string, unknown> = { count: 1n, token: 'private' };
  circular.self = circular;

  expect(() => {
    createLogger({ LOG_LEVEL: 'info' }).log('info', 'safe', circular);
  }).not.toThrow();

  const output = stdoutWriteMock.mock.calls.map(call => String(call[0])).join('');
  expect(output).toContain('"count":"1"');
  expect(output).toContain('"token":"[REDACTED]"');
  expect(output).toContain('"self":"[Circular]"');
});
