import { test, expect, mock, afterEach, afterAll, beforeAll } from 'bun:test';
import fs from 'fs/promises';
import { createLogger } from '../src/logger';
import type { Logger, LoggerConfig } from '../src/logger';

const TEST_LOG_FILE = './.telemetry_test.log';

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
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

beforeAll(() => {
  Bun.file = fileMock as any;
  Bun.spawnSync = spawnSyncMock as any;
  console.log = mock(() => {});
  console.error = mock(() => {});
});

afterAll(() => {
  Bun.file = originalBunFile;
  Bun.spawnSync = originalSpawnSync;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

afterEach(async () => {
  fileMock.mockClear();
  mockWriter.write.mockClear();
  mockWriter.end.mockClear();
  spawnSyncMock.mockClear();
  (console.log as any).mockClear();
  (console.error as any).mockClear();
  try {
    await fs.unlink(TEST_LOG_FILE);
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
});

test('logger: log level filtering', () => {
  const logger: Logger = createLogger({ LOG_LEVEL: 'warn', TELEMETRY_FILE: TEST_LOG_FILE });

  logger.log('info', 'this should be ignored');
  logger.log('debug', 'this should also be ignored');
  logger.log('warn', 'this is a warning');
  logger.log('error', 'this is an error');

  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('this should be ignored'));
  expect(console.log).not.toHaveBeenCalledWith(
    expect.stringContaining('this should also be ignored'),
  );
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('this is a warning'));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('this is an error'));
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

  expect(console.error).toHaveBeenCalledWith(
    'Failed to write telemetry:',
    'Error: No space left on device',
  );
});

test('logger: should handle permission errors gracefully', async () => {
  mockWriter.write.mockImplementation(() => {
    throw new Error('Permission denied');
  });

  const logger: Logger = createLogger({ LOG_LEVEL: 'info', TELEMETRY_FILE: TEST_LOG_FILE });
  logger.log('info', 'some data');
  await logger.flush();

  expect(console.error).toHaveBeenCalledWith(
    'Failed to write telemetry:',
    'Error: Permission denied',
  );
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
