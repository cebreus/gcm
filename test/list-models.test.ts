import { test, expect, mock } from 'bun:test';

// Mock the listGeminiModels module before importing the runner
const listMock = mock(() =>
  Promise.resolve([
    {
      name: 'models/gemini-3.7-flash',
      label: 'Gemini 3.7 Flash',
      limits: { kind: 'separate' as const, maxInputTokens: 1_000_000, maxOutputTokens: 65_536 },
    },
    {
      name: 'models/gemini-3.1-pro-preview',
      label: 'Gemini 3.1 Pro Preview',
      limits: { kind: 'separate' as const, maxInputTokens: 1_000_000, maxOutputTokens: 65_536 },
    },
    {
      name: 'models/gemini-3-pro-image',
      label: 'Gemini 3 Pro Image',
      limits: { kind: 'separate' as const, maxInputTokens: 1_000_000, maxOutputTokens: 65_536 },
    },
    {
      name: 'models/gemini-3.1-flash-tts-preview',
      label: 'Gemini 3.1 Flash TTS Preview',
      limits: { kind: 'separate' as const, maxInputTokens: 1_000_000, maxOutputTokens: 65_536 },
    },
    {
      name: 'models/gemini-robotics-er-2-preview',
      label: 'Gemini Robotics ER 2 Preview',
      limits: { kind: 'separate' as const, maxInputTokens: 1_000_000, maxOutputTokens: 65_536 },
    },
  ]),
);
await mock.module('../src/gemini-client/listModels', () => ({ listGeminiModels: listMock }));

test('cli: --list-models prints available models', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner.js'); // Use named export
  const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  const originalExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write;
  const stdoutChunks: string[] = [];
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  process.exitCode = 0;
  process.stdout.write = mock((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;

  try {
    await executeCommitMessageGeneration(['--list-models']);
    expect(listMock).toHaveBeenCalledWith('test-key');
    expect(stdoutChunks.join('')).toContain('gemini-3.7-flash');
    expect(stdoutChunks.join('')).not.toContain('image');
    expect(stdoutChunks.join('')).not.toContain('tts');
    expect(stdoutChunks.join('')).not.toContain('robotics');
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.exitCode = originalExitCode ?? 0;
    if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
    else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
  }
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
  try {
    await executeCommitMessageGeneration(['--list-models']);
    expect(Number(process.exitCode)).toBe(1);
  } finally {
    console.error = originalConsoleError;
    process.exitCode = originalExitCode ?? 0;
    if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
    else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
  }
});

test('cli: --list-models uses the injected model list failure contract', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner.js');
  const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  const originalExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write;
  const injectedListModels = mock(() => Promise.reject(new Error('boom')));
  const stdoutChunks: string[] = [];
  let exitCode: number | undefined;

  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  process.exitCode = undefined;
  process.stdout.write = mock((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
  try {
    await expect(
      executeCommitMessageGeneration(['--list-models'], { geminiModelLister: injectedListModels }),
    ).resolves.toBeUndefined();
    exitCode = Number(process.exitCode);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.exitCode = originalExitCode;
    if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
    else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
  }

  expect(injectedListModels).toHaveBeenCalledWith('test-key');
  expect(stdoutChunks.join('')).toContain('Failed to fetch models: Error: boom');
  expect(exitCode).toBe(2);
});
