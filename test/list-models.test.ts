import { test, expect, mock } from 'bun:test';

// Mock the listGeminiModels module before importing the runner
const listMock = mock(() =>
  Promise.resolve(['models/gemini-3.7-flash', 'models/gemini-3.1-pro-preview']),
);
mock.module('../src/gemini-client/listModels', () => ({ listGeminiModels: listMock }));

test('cli: --list-models prints available models', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner.js'); // Use named export
  const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  const originalExitCode = process.exitCode;
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  process.exitCode = 0;

  await executeCommitMessageGeneration(['--list-models']);

  expect(listMock).toHaveBeenCalledWith('test-key');

  // restore
  process.exitCode = originalExitCode ?? 0;
  if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
});

test('cli: --list-models without API key exits with code 1', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner.js');
  const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  const originalExitCode = process.exitCode;
  delete process.env.GOOGLE_GEMINI_API_KEY;

  const consoleErrorMock = mock(() => {});
  const originalConsoleError = console.error;
  console.error = consoleErrorMock;
  process.exitCode = undefined;
  await executeCommitMessageGeneration(['--list-models']);
  expect(Number(process.exitCode)).toBe(1);

  // restore
  console.error = originalConsoleError;
  process.exitCode = originalExitCode ?? 0;
  if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
});
