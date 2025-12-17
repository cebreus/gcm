import { test, expect, mock } from 'bun:test';

// Mock the listGeminiModels module before importing the runner
const listMock = mock(() => Promise.resolve(['models/gemini-2.5-flash', 'models/gemini-1.5-pro']));
mock.module('../src/gemini-client/listModels', () => ({ listGeminiModels: listMock }));

test('cli: --list-models prints available models', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner-refactored.js'); // Use named export
  const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';

  const consoleLogMock = mock((...args: unknown[]) => {});
  const originalConsoleLog = console.log;
  console.log = consoleLogMock;

  await executeCommitMessageGeneration(['--list-models']);

  expect(listMock).toHaveBeenCalledWith('test-key');
  expect(consoleLogMock).toHaveBeenCalled();
  const firstCall = String(consoleLogMock.mock.calls[0][0]);
  expect(firstCall).toContain('Available Gemini models:');
  const allCallsJoined = consoleLogMock.mock.calls
    .map(c => (Array.isArray(c) ? c.join(' ') : String(c)))
    .join('\n');
  expect(allCallsJoined).toContain('models/gemini-2.5-flash');
  expect(allCallsJoined).toContain('models/gemini-1.5-pro');

  // restore
  console.log = originalConsoleLog;
  if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
});

test('cli: --list-models without API key exits with code 1', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner-refactored.js');
  const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  delete process.env.GOOGLE_GEMINI_API_KEY;

  const consoleErrorMock = mock(() => {});
  const originalConsoleError = console.error;
  console.error = consoleErrorMock;

  const exitMock = mock((code?: number) => {
    throw new Error('EXIT:' + String(code));
  });
  const originalProcessExit = process.exit;
  // @ts-ignore - override for test
  process.exit = exitMock as any;

  await expect(executeCommitMessageGeneration(['--list-models'])).rejects.toThrow('EXIT:1');

  // restore
  console.error = originalConsoleError;
  // @ts-ignore
  process.exit = originalProcessExit;
  if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
});
