import { test, expect, mock, afterEach, afterAll, beforeAll } from 'bun:test';
import fs from 'fs/promises';
import { createLogger } from '../src/logger';
import type { Logger, LoggerConfig } from '../src/logger';

const TEST_LOG_FILE = './.telemetry_test.log';
const UNSAFE_TELEMETRY_FILE = './.telemetry_"; echo injected; #.log';

// --- Mocks Setup ---
const mockWriter = {
  write: mock(() => {}),
  end: mock(async () => {}),
};
const fileMock = mock(() => ({
  writer: () => mockWriter,
}));
const spawnSyncMock = mock(() => ({ success: true }));

const originalBunFile = Bun.file;
const originalSpawnSync = Bun.spawnSync;
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
const stdoutWriteMock = mock(() => true);
const stderrWriteMock = mock(() => true);

beforeAll(() => {
  Bun.file = fileMock as any;
  Bun.spawnSync = spawnSyncMock as any;
  process.stdout.write = stdoutWriteMock as any;
  process.stderr.write = stderrWriteMock as any;
});

afterAll(() => {
  Bun.file = originalBunFile;
  Bun.spawnSync = originalSpawnSync;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
});

afterEach(async () => {
  fileMock.mockClear();
  mockWriter.write.mockClear();
  mockWriter.end.mockClear();
  spawnSyncMock.mockClear();
  stdoutWriteMock.mockClear();
  stderrWriteMock.mockClear();
  try {
    await fs.unlink(TEST_LOG_FILE);
  } catch {}
  try {
    await fs.unlink(UNSAFE_TELEMETRY_FILE);
  } catch {}
});

test('logger: flush and redaction', async () => {
  const logger: Logger = createLogger({ LOG_LEVEL: 'info', TELEMETRY_FILE: TEST_LOG_FILE });
  logger.log('info', 'test info', { foo: 'bar' });
  logger.log('info', 'sensitive info', { token: 'sk-abcdef1234567890' });

  await logger.flush();

  expect(mockWriter.write).toHaveBeenCalled();
  const writtenContent = (mockWriter.write as any).mock.calls[0][0];
  expect(writtenContent).toContain('test info');
  expect(writtenContent).toContain('[REDACTED-KEY]');
  expect(mockWriter.end).toHaveBeenCalled();
});

test('logger: log level filtering', () => {
  const logger: Logger = createLogger({ LOG_LEVEL: 'warn', TELEMETRY_FILE: TEST_LOG_FILE });

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

test('logger: should flush when queue reaches maxQueueBytes', async () => {
  const logger: Logger = createLogger({
    LOG_LEVEL: 'info',
    TELEMETRY_FILE: TEST_LOG_FILE,
    LOG_FLUSH_MAX_BYTES: 100, // Small limit
  });

  // This will exceed the 100 byte limit
  logger.log('info', 'message 1 that is long enough to trigger flush');
  logger.log('info', 'message 2 that is also long enough');

  // Flush is triggered automatically, but it's async. We need to wait for it.
  await new Promise(resolve => setTimeout(resolve, 10));

  expect(mockWriter.write).toHaveBeenCalled();
});

test('logger: should handle disk full scenario gracefully', async () => {
  mockWriter.write.mockImplementation(() => {
    throw new Error('No space left on device');
  });

  const logger: Logger = createLogger({ LOG_LEVEL: 'info', TELEMETRY_FILE: TEST_LOG_FILE });
  logger.log('info', 'some data');
  await logger.flush();

  const calls = stderrWriteMock.mock.calls;
  const found = calls.some((call: any[]) => String(call[0]).includes('Failed to write telemetry'));
  expect(found).toBe(true);
});

test('logger: should handle permission errors gracefully', async () => {
  mockWriter.write.mockImplementation(() => {
    throw new Error('Permission denied');
  });

  const logger: Logger = createLogger({ LOG_LEVEL: 'info', TELEMETRY_FILE: TEST_LOG_FILE });
  logger.log('info', 'some data');
  await logger.flush();

  const calls = stderrWriteMock.mock.calls;
  const found = calls.some((call: any[]) => String(call[0]).includes('Failed to write telemetry'));
  expect(found).toBe(true);
});

test('logger: timer-based flush', async () => {
  const logger: Logger = createLogger({
    LOG_LEVEL: 'info',
    TELEMETRY_FILE: TEST_LOG_FILE,
    LOG_FLUSH_INTERVAL_MS: 50,
  });

  logger.log('info', 'a message');

  // Wait for the flush interval to pass
  await new Promise(resolve => setTimeout(resolve, 60));

  expect(mockWriter.write).toHaveBeenCalled();
});

test('logger: flushSync writes telemetry to a literal shell-like path', async () => {
  const logger = createLogger({ LOG_LEVEL: 'info', TELEMETRY_FILE: UNSAFE_TELEMETRY_FILE });

  logger.log('info', 'sync payload');
  logger.flushSync();

  expect(await fs.readFile(UNSAFE_TELEMETRY_FILE, 'utf8')).toContain('sync payload');
});
