import { test, expect } from 'bun:test';
import fs from 'fs/promises';
import { createLogger } from '../src/logger';
import type { Logger } from '../src/logger';

async function loggerFlushAndRedactionTest(): Promise<void> {
  const tmpFile = './.telemetry_test.log';
  // Cleanup just in case
  try {
    await fs.unlink(tmpFile);
     
  } catch (__e) {
    /* ignore */
  }
  const logger: Logger = createLogger({ LOG_LEVEL: 'info', TELEMETRY_FILE: tmpFile });
  logger.log('info', 'test info', { foo: 'bar' });
  // Log something with a token-like field which should be redacted in telemetry
  logger.log('info', 'sensitive info', { token: 'sk-abcdef1234567890' });
  logger.log('error', 'test error', { code: 123 });
  // Ensure queued lines have been flushed
  await logger.flush();
  // Check that flushSync also works.
  const tmpFile2 = './.telemetry_test2.log';
  try {
    await fs.unlink(tmpFile2);
     
  } catch (__e) {
    /* ignore */
  }
  const logger2: Logger = createLogger({
    LOG_LEVEL: 'info',
    TELEMETRY_FILE: tmpFile2,
    LOG_FLUSH_INTERVAL_MS: 100,
  });
  logger2.log('info', 'test info 2', { foo: 'bar2' });
  logger2.log('error', 'test error 2', { code: 456 });
  // Force synchronous flush
  logger2.flushSync();
  const content2 = await fs.readFile(tmpFile2, { encoding: 'utf8' });
  expect(content2).toContain('test info 2');
  expect(content2).toContain('test error 2');
  await fs.unlink(tmpFile2);
  const content = await fs.readFile(tmpFile, { encoding: 'utf8' });
  expect(content).toContain('test info');
  expect(content).toContain('test error');
  // ensure that the token was redacted in telemetry
  expect(content.includes('[REDACTED]') || content.includes('[REDACTED-KEY]')).toBe(true);
  await fs.unlink(tmpFile);
  console.log('logger test passed');
}
test('logger: flush and redaction', loggerFlushAndRedactionTest);
