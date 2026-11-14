import { expect, mock, spyOn, test } from 'bun:test';

// Mock the listGeminiModels module before importing the runner
const listMock = mock(
  async () =>
    await Promise.resolve([
      {
        name: 'models/gemini-3.7-flash',
        label: 'Gemini 3.7 Flash',
        limits: {
          kind: 'separate' as const,
          maxInputTokens: 1_000_000,
          maxOutputTokens: 65_536,
        },
      },
      {
        name: 'models/gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro Preview',
        limits: {
          kind: 'separate' as const,
          maxInputTokens: 1_000_000,
          maxOutputTokens: 65_536,
        },
      },
      {
        name: 'models/gemini-3-pro-image',
        label: 'Gemini 3 Pro Image',
        limits: {
          kind: 'separate' as const,
          maxInputTokens: 1_000_000,
          maxOutputTokens: 65_536,
        },
      },
      {
        name: 'models/gemini-3.1-flash-tts-preview',
        label: 'Gemini 3.1 Flash TTS Preview',
        limits: {
          kind: 'separate' as const,
          maxInputTokens: 1_000_000,
          maxOutputTokens: 65_536,
        },
      },
      {
        name: 'models/gemini-robotics-er-2-preview',
        label: 'Gemini Robotics ER 2 Preview',
        limits: {
          kind: 'separate' as const,
          maxInputTokens: 1_000_000,
          maxOutputTokens: 65_536,
        },
      },
    ]),
);
await mock.module('../src/gemini-models', () => ({
  listGeminiModels: listMock,
}));

test('cli: --models-list prints available models', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner.js'); // Use named export
  const {
    env: { GCM_GEMINI_API_KEY: originalApiKey },
    exitCode: originalExitCode,
    stdout: { write: originalStdoutWrite, columns: originalColumns },
  } = process;
  const stdoutChunks: string[] = [];
  // A zero-width pseudo-terminal makes clack wrap the note one character per line.
  process.stdout.columns = 80;
  process.env.GCM_GEMINI_API_KEY = 'test-key';
  process.exitCode = 0;
  process.stdout.write = mock((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  });

  try {
    await executeCommitMessageGeneration(['--models-list']);
    expect(listMock.mock.calls[0] as unknown[]).toEqual([
      'test-key',
      expect.anything(),
    ]);
    expect(stdoutChunks.join('')).toContain('gemini-3.7-flash');
    expect(stdoutChunks.join('')).not.toContain('image');
    expect(stdoutChunks.join('')).not.toContain('tts');
    expect(stdoutChunks.join('')).not.toContain('robotics');
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stdout.columns = originalColumns;
    process.exitCode = originalExitCode ?? 0;
    if (originalApiKey === undefined) {
      delete process.env.GCM_GEMINI_API_KEY;
    } else {
      process.env.GCM_GEMINI_API_KEY = originalApiKey;
    }
  }
});

test('cli: --models-list without API key exits with code 1', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner.js');
  const {
    env: { GCM_GEMINI_API_KEY: originalApiKey },
    exitCode: originalExitCode,
  } = process;
  delete process.env.GCM_GEMINI_API_KEY;

  const consoleErrorMock = spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
  try {
    await executeCommitMessageGeneration(['--models-list']);
    expect(process.exitCode).toBe(1);
  } finally {
    consoleErrorMock.mockRestore();
    process.exitCode = originalExitCode ?? 0;
    if (originalApiKey === undefined) {
      delete process.env.GCM_GEMINI_API_KEY;
    } else {
      process.env.GCM_GEMINI_API_KEY = originalApiKey;
    }
  }
});

test('cli: --models-list uses the injected model list failure contract', async () => {
  const { executeCommitMessageGeneration } = await import('../src/runner.js');
  const {
    env: { GCM_GEMINI_API_KEY: originalApiKey },
    exitCode: originalExitCode,
    stderr: { write: originalStderrWrite },
  } = process;
  const injectedListModels = mock(
    async () => await Promise.reject(new Error('boom')),
  );
  const stderrChunks: string[] = [];

  process.env.GCM_GEMINI_API_KEY = 'test-key';
  process.exitCode = 0;
  process.stderr.write = mock((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  try {
    await expect(
      executeCommitMessageGeneration(['--models-list'], {
        geminiModelLister: injectedListModels,
      }),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(2);
  } finally {
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode ?? 0;
    if (originalApiKey === undefined) {
      delete process.env.GCM_GEMINI_API_KEY;
    } else {
      process.env.GCM_GEMINI_API_KEY = originalApiKey;
    }
  }

  expect(injectedListModels).toHaveBeenCalledWith('test-key');
  expect(stderrChunks.join('')).toContain(
    'Failed to fetch models: Error: boom',
  );
});
