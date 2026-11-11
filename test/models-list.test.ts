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
await mock.module('../src/gemini-models', () => ({ listGeminiModels: listMock }));

test('cli: --models-list prints available models', async () => {
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
    await executeCommitMessageGeneration(['--models-list']);
    expect(listMock.mock.calls[0] as unknown[]).toEqual(['test-key', expect.anything()]);
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

test('cli: --models-list without API key exits with code 1', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner.js');
  const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  const originalExitCode = process.exitCode;
  delete process.env.GOOGLE_GEMINI_API_KEY;

  const consoleErrorMock = mock(() => {});
  const originalConsoleError = console.error;
  console.error = consoleErrorMock;
  process.exitCode = 0;
  try {
    await executeCommitMessageGeneration(['--models-list']);
    expect(Number(process.exitCode)).toBe(1);
  } finally {
    console.error = originalConsoleError;
    process.exitCode = originalExitCode ?? 0;
    if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
    else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
  }
});

test('cli: --models-list uses the injected model list failure contract', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner.js');
  const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  const originalExitCode = process.exitCode;
  const originalStderrWrite = process.stderr.write;
  const injectedListModels = mock(() => Promise.reject(new Error('boom')));
  const stderrChunks: string[] = [];
  let exitCode: number | undefined;

  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  process.exitCode = 0;
  process.stderr.write = mock((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;
  try {
    await expect(
      executeCommitMessageGeneration(['--models-list'], { geminiModelLister: injectedListModels }),
    ).resolves.toBeUndefined();
    exitCode = Number(process.exitCode);
  } finally {
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode ?? 0;
    if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
    else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
  }

  expect(injectedListModels).toHaveBeenCalledWith('test-key');
  expect(stderrChunks.join('')).toContain('Failed to fetch models: Error: boom');
  expect(exitCode).toBe(2);
});
