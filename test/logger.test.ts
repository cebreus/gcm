import { test, expect, mock, afterAll, beforeAll } from 'bun:test';
import { createLogger } from '../src/logger';

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
const stdoutWriteMock = mock((_text: string) => true);
const stderrWriteMock = mock((_text: string) => true);

beforeAll(() => {
  process.stdout.write = stdoutWriteMock as any;
  process.stderr.write = stderrWriteMock as any;
});

afterAll(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

test('logger: redacts secrets in console output', () => {
  const logger = createLogger({ LOG_LEVEL: 'info' });
  logger.log('info', 'sensitive info', { token: 'sk-abcdef1234567890' });

  const output = stdoutWriteMock.mock.calls.map(call => String(call[0])).join('');
  expect(output).toContain('[REDACTED-KEY]');
  expect(output).not.toContain('sk-abcdef1234567890');
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
