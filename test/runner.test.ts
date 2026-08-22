import { expect, test, mock, describe, beforeEach, afterEach } from 'bun:test';
import { executeCommitMessageGeneration } from '../src/runner.js';
import packageJson from '../package.json';

// Mock @clack/prompts
const mockIntro = mock();
const mockOutro = mock();
const mockSpinner = mock(() => ({ start: mock(), stop: mock() }));
const mockNote = mock();
const mockSelect = mock(arg => {
  console.log('Unexpected Select:', arg.message);
  return Promise.resolve('cancel');
});
const mockText = mock(() => Promise.resolve('edited message'));
const mockIsCancel = mock(val => val === 'cancel');
const mockCancel = mock();

mock.module('@clack/prompts', () => ({
  intro: mockIntro,
  outro: mockOutro,
  spinner: mockSpinner,
  note: mockNote,
  select: mockSelect,
  text: mockText,
  isCancel: mockIsCancel,
  cancel: mockCancel,
}));

// Mock ../src/session.js
const mockLoadSession = mock(() =>
  Promise.resolve({
    modelName: null as string | null,
    outputMode: null as 'full' | 'commit-only' | null,
  }),
);
const mockSaveSession = mock(() => Promise.resolve());
mock.module('../src/session.js', () => ({
  loadSession: mockLoadSession,
  saveSession: mockSaveSession,
}));

// Mock clipboardy
const mockClipboardyWrite = mock(() => Promise.resolve());
mock.module('clipboardy', () => ({
  default: {
    write: mockClipboardyWrite,
  },
}));

// Mocks
const mockLogger = { log: mock() };
const mockGitService = {
  retrieveStagedChanges: mock(),
  commitChanges: mock(),
  amendCommit: mock(),
  rewordCommit: mock(),
  inspectCommitTarget: mock(),
  getIndexTree: mock(),
  getIndexEntries: mock(),
  getRepositoryState: mock(),
};
const mockContextService = {
  constructLLMPromptContext: mock(),
  reduceForRetry: mock(
    async (params: {
      promptParts: { prefix: string; diffHeading: string; diffBody: string; suffix: string };
      stagedFiles?: string[];
      summaryAttempted: boolean;
    }) => ({
      promptContext:
        params.promptParts.prefix +
        params.promptParts.diffHeading +
        params.promptParts.diffBody +
        params.promptParts.suffix,
      promptParts: params.promptParts,
      mode: 'truncation' as const,
      summaryAttempted: params.summaryAttempted,
      summaryUsed: false,
    }),
  ),
};
const mockGeminiService = { callGeminiAPI: mock() };
const mockListModels = mock(() =>
  Promise.resolve(['models/gemini-3.7-flash', 'models/gemini-3.1-pro-preview']),
);

describe('Refactored Runner', () => {
  beforeEach(() => {
    mockLogger.log.mockClear();
    mockGitService.retrieveStagedChanges.mockClear();
    mockGitService.commitChanges.mockClear();
    mockGitService.getIndexTree.mockClear();
    mockGitService.getIndexTree.mockResolvedValue('index-tree');
    mockGitService.getIndexEntries.mockClear();
    mockGitService.getIndexEntries.mockResolvedValue([]);
    mockGitService.getRepositoryState.mockClear();
    mockGitService.getRepositoryState.mockResolvedValue({
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUnmergedPaths: false,
      inProgressOperation: null,
      changedFiles: ['file.ts'],
    });
    mockContextService.constructLLMPromptContext.mockClear();
    mockGeminiService.callGeminiAPI.mockClear();
    mockListModels.mockClear();

    // Clear clack mocks
    mockIntro.mockClear();
    mockOutro.mockClear();
    mockSpinner.mockClear();
    mockNote.mockClear();
    mockSelect.mockReset();
    mockSelect.mockImplementation(arg => {
      console.log('Unexpected Select:', arg.message);
      return Promise.resolve('cancel');
    });
    mockText.mockReset();
    mockText.mockImplementation(() => Promise.resolve('edited message'));

    // Clear clipboardy mock
    mockClipboardyWrite.mockClear();
    mockCancel.mockClear();
  });

  test('Should orchestrate services correctly', async () => {
    // Setup
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      promptParts: { prefix: 'prefix', diffHeading: 'Diff:\n', diffBody: 'diff', suffix: 'suffix' },
      processedDiffContent: 'diff',
      tokens: 10,
      summaryAttempted: true,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: 'BRANCH: feat/test\nCOMMIT_MESSAGE: test',
      usage: {},
    });

    // Pre-flight: generate, Review: commit
    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

    // Execute
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    await executeCommitMessageGeneration([], {
      logger: mockLogger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      listModels: mockListModels,
    });

    // Verify
    expect(mockGitService.retrieveStagedChanges).toHaveBeenCalled();
    expect(mockContextService.constructLLMPromptContext).toHaveBeenCalled();
    expect(mockGeminiService.callGeminiAPI).toHaveBeenCalled();
    expect(mockGeminiService.callGeminiAPI).toHaveBeenCalledWith(
      expect.objectContaining({ summaryAttempted: true }),
    );

    // Check logging
    const logs = mockLogger.log.mock.calls.map(c => c[1]).join(' ');
    // expect(logs).toContain('BRANCH:'); // No longer logged, now shown in note

    expect(mockNote).toHaveBeenCalled();
    const noteContent = mockNote.mock.calls[0][0];
    // Default is now Commit Only, so only message is shown
    expect(noteContent).toContain('test');
    expect(noteContent).not.toContain('BRANCH:');
  });

  test('Should print package version and exit on --version', async () => {
    const originalStdoutWrite = process.stdout.write;
    const stdoutChunks: string[] = [];
    process.stdout.write = mock((chunk: any) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as any;

    try {
      await executeCommitMessageGeneration(['--version'], {
        logger: mockLogger as any,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        listModels: mockListModels,
      });

      const output = stdoutChunks.join('');
      expect(output).toContain('gcm');
      expect(output).toContain(packageJson.version);
      expect(mockIntro).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
  });

  test('Should report argument validation failures without throwing', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await expect(
        executeCommitMessageGeneration(['--commmit', 'abc'], {
          logger: mockLogger as any,
          gitService: mockGitService,
          contextService: mockContextService,
          geminiService: mockGeminiService,
          listModels: mockListModels,
        }),
      ).resolves.toBeUndefined();

      expect(mockCancel).toHaveBeenCalledWith(
        'Error: Unknown flag: --commmit. Run gcm --help for usage.',
      );
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  test('Should report duck-typed Gemini API errors', async () => {
    const error = Object.assign(new Error('quota exhausted'), {
      name: 'GeminiApiError',
      metadata: { status: 429, snippet: '{"error":{"message":"quota exhausted"}}' },
    });
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockRejectedValueOnce(error);
    mockSelect.mockResolvedValueOnce('generate');

    await expect(
      executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        listModels: mockListModels,
      }),
    ).rejects.toBe(error);

    expect(mockCancel).toHaveBeenCalledWith('API Error (429): quota exhausted');
  });

  test('Should report truthy non-string Gemini API error messages', async () => {
    const error = Object.assign(new Error('quota exhausted'), {
      name: 'GeminiApiError',
      metadata: { status: 429, snippet: '{"error":{"message":429}}' },
    });
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockRejectedValueOnce(error);
    mockSelect.mockResolvedValueOnce('generate');

    await expect(
      executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        listModels: mockListModels,
      }),
    ).rejects.toBe(error);

    expect(mockCancel).toHaveBeenCalledWith('API Error (429): 429');
  });

  test('Should remove terminal controls from Gemini API error messages', async () => {
    const error = Object.assign(new Error('quota exhausted'), {
      name: 'GeminiApiError',
      metadata: { status: 429, snippet: '{"error":{"message":"bad\\u001b]8;;https://example.test\\u0007link\\u001b]8;;\\u0007"}}' },
    });
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockRejectedValueOnce(error);
    mockSelect.mockResolvedValueOnce('generate');

    await expect(
      executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        listModels: mockListModels,
      }),
    ).rejects.toBe(error);

    expect(mockCancel).toHaveBeenCalledWith('API Error (429): badlink');
  });

  test('Should include version details in --help output', async () => {
    const originalStdoutWrite = process.stdout.write;
    const stdoutChunks: string[] = [];
    process.stdout.write = mock((chunk: any) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as any;

    try {
      await executeCommitMessageGeneration(['--help'], {
        logger: mockLogger as any,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        listModels: mockListModels,
      });

      const output = stdoutChunks.join('');
      expect(output).toContain('Version:');
      expect(output).toContain(packageJson.version);
      expect(output).toContain('--version');
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
  });

  test('Should handle Edit flow', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: 'BRANCH: branch\nCOMMIT_MESSAGE: initial message',
      usage: {},
    });

    // Sequence: 'edit' -> 'commit'
    // BUT first we have Pre-flight: 'generate'
    // Then Review Menu: 'edit' -> 'commit'
    mockSelect
      .mockResolvedValueOnce('generate') // Pre-flight
      .mockResolvedValueOnce('edit') // Review
      .mockResolvedValueOnce('commit'); // Review loop
    mockText.mockResolvedValue('edited message');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as any,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      listModels: mockListModels,
    });

    // Verify text prompt called with initial value
    expect(mockText).toHaveBeenCalled();
    // Verify commit called with edited message
    expect(mockGitService.commitChanges).toHaveBeenCalledWith(
      'edited message',
      expect.any(Object),
      expect.any(Object),
    );
  });

  test('Should reject a stale index through the commit workflow', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
      snapshot: {
        tree: 'original-tree',
        entries: [{ path: 'file.ts', mode: '100644', objectId: '1'.repeat(40) }],
      },
    });
    mockGitService.getIndexTree
      .mockResolvedValueOnce('changed-tree')
      .mockResolvedValueOnce('changed-tree');
    mockGitService.getIndexEntries
      .mockResolvedValueOnce([
        { path: 'file.ts', mode: '100644', objectId: '1'.repeat(40) },
        { path: 'later.ts', mode: '100644', objectId: '2'.repeat(40) },
      ])
      .mockResolvedValueOnce([
        { path: 'file.ts', mode: '100644', objectId: '1'.repeat(40) },
        { path: 'later.ts', mode: '100644', objectId: '2'.repeat(40) },
      ]);
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: 'COMMIT_MESSAGE: initial message',
      usage: {},
    });
    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as any,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      listModels: mockListModels,
    });

    expect(mockGitService.commitChanges).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith(
      'Staged changes were modified while this message was on screen, so the message no longer describes what would be committed. Added: "later.ts". Regenerate the message, review it, then commit.',
    );
  });

  test('Should handle no staged changes', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue(null);
    mockSelect.mockResolvedValueOnce('generate'); // Pre-flight
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await executeCommitMessageGeneration([], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        listModels: mockListModels,
      });
      expect(mockGeminiService.callGeminiAPI).not.toHaveBeenCalled();
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  test('Should fail when Git has unresolved conflicts', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    const originalExitCode = process.exitCode;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    process.exitCode = undefined;
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockGitService.getRepositoryState.mockResolvedValue({
      hasStagedChanges: true,
      hasUnstagedChanges: false,
      hasUntrackedFiles: false,
      hasUnmergedPaths: true,
      inProgressOperation: null,
      changedFiles: ['file.ts'],
    });

    try {
      await executeCommitMessageGeneration(['--mode', 'commit-only'], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        listModels: mockListModels,
      });

      expect(mockCancel).toHaveBeenCalledWith(
        'Git index has unresolved conflicts. Resolve conflicts before generating or committing.',
      );
      expect(mockGeminiService.callGeminiAPI).not.toHaveBeenCalled();
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  test('Should fail when Gemini returns malformed full output', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    const originalExitCode = process.exitCode;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    process.exitCode = undefined;
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: 'COMMIT_MESSAGE: missing branch',
      usage: {},
    });

    try {
      await executeCommitMessageGeneration(['--mode', 'full'], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        listModels: mockListModels,
      });

      expect(mockOutro).toHaveBeenCalledWith('Failed to parse structured output.');
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  test('Should remove terminal controls before logging an unparseable model response', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    const originalExitCode = process.exitCode;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    process.exitCode = undefined;
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: '\u001B[2Junparseable\u0000 response',
      usage: {},
    });

    try {
      await executeCommitMessageGeneration(['--mode', 'full'], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        listModels: mockListModels,
      });

      expect(mockLogger.log).toHaveBeenCalledWith('info', 'unparseable response');
    } finally {
      process.exitCode = originalExitCode;
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  test('Should fail when the commit action fails', async () => {
    const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    const originalExitCode = process.exitCode;
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    process.exitCode = undefined;
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: 'COMMIT_MESSAGE: test message',
      usage: {},
    });
    mockGitService.commitChanges.mockRejectedValueOnce(new Error('git commit failed'));
    mockSelect.mockResolvedValueOnce('commit');

    try {
      await executeCommitMessageGeneration(['--mode', 'commit-only'], {
        logger: mockLogger,
        gitService: mockGitService,
        contextService: mockContextService,
        geminiService: mockGeminiService,
        listModels: mockListModels,
      });

      expect(mockCancel).toHaveBeenCalledWith('Failed to apply commit action: git commit failed');
      expect(Number(process.exitCode)).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
    }
  });

  test('Should handle Copy to clipboard flow', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['file.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: 'COMMIT_MESSAGE: test message',
      usage: {},
    });

    // Flow: 'generate' -> 'copy' -> 'commit'
    mockSelect
      .mockResolvedValueOnce('generate') // Pre-flight
      .mockResolvedValueOnce('copy') // Review - copy to clipboard
      .mockResolvedValueOnce('commit'); // Review - commit

    await executeCommitMessageGeneration([], {
      logger: mockLogger as any,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      listModels: mockListModels,
    });

    // Verify clipboardy.write was called with correct message (extracted)
    expect(mockClipboardyWrite).toHaveBeenCalledWith('test message');
    // Verify note was shown about successful copy
    expect(mockNote).toHaveBeenCalledWith('Commit message copied to clipboard!', 'Success');
    // Verify commit was eventually called
    expect(mockGitService.commitChanges).toHaveBeenCalled();
  });

  test('Should handle Regeneration flow', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    // Context service called twice (initial + regen)
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: 'COMMIT_MESSAGE: msg',
      usage: {},
    });

    // Flow:
    // 1. Pre-flight: 'generate'
    // 2. Review: 'regenerate'
    // 3. Select Model: 'gemini-2.5-pro'
    // -- Loop restarts --
    // 4. Review (2nd run): 'commit'

    mockSelect
      .mockResolvedValueOnce('generate') // 1
      .mockResolvedValueOnce('switch') // 2 (Changed from 'regenerate' to 'switch')
      .mockResolvedValueOnce('gemini-2.5-pro') // 3
      .mockResolvedValueOnce('commit'); // 4

    await executeCommitMessageGeneration([], {
      logger: mockLogger as any,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      listModels: mockListModels,
    });

    // Gemini should be called twice
    expect(mockGeminiService.callGeminiAPI).toHaveBeenCalledTimes(2);
    expect(mockListModels).toHaveBeenCalled();
    // Git commit called once
    expect(mockGitService.commitChanges).toHaveBeenCalled();
  });

  test('Should handle Regenerate with Hint flow', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: 'COMMIT_MESSAGE: msg',
      usage: {},
    });

    // Flow: 'generate' -> 'regenerate-hint' -> enter hint -> 'commit'
    mockSelect
      .mockResolvedValueOnce('generate')
      .mockResolvedValueOnce('regenerate-hint')
      .mockResolvedValueOnce('commit');
    mockText.mockResolvedValue('make it shorter');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as any,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      listModels: mockListModels,
    });

    // Verify hint was passed to context service in second call
    expect(mockContextService.constructLLMPromptContext).toHaveBeenCalledTimes(2);
    expect(mockContextService.constructLLMPromptContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userHint: 'make it shorter',
      }),
    );
  });

  test('Should save session on successful commit', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: 'COMMIT_MESSAGE: msg',
      usage: {},
    });

    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

    await executeCommitMessageGeneration(['--model', 'gemini-special'], {
      logger: mockLogger as any,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      listModels: mockListModels,
    });

    // Verify session was saved with the model used
    expect(mockSaveSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelName: 'gemini-special' }),
    );
  });

  test('Should migrate legacy session flash model to faster default', async () => {
    mockLoadSession.mockResolvedValueOnce({ modelName: 'gemini-2.5-flash', outputMode: null });
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });
    mockGeminiService.callGeminiAPI.mockResolvedValue({
      text: 'COMMIT_MESSAGE: msg',
      usage: {},
    });
    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as any,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      listModels: mockListModels,
    });

    expect(mockGeminiService.callGeminiAPI).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({ modelOverride: 'gemini-3.7-flash' }),
      }),
    );
  });

  test('Should perform auto-retry on truncated response', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue({
      stagedDiff: 'diff',
      stagedFiles: ['a.ts'],
      truncated: false,
    });
    mockContextService.constructLLMPromptContext.mockResolvedValue({
      promptContext: 'ctx',
      processedDiffContent: 'diff',
      tokens: 10,
    });

    // First call returns full (internal retry logic is handled by the client/service)
    mockGeminiService.callGeminiAPI.mockResolvedValueOnce({
      text: 'COMMIT_MESSAGE: full message',
      truncated: false,
      usage: { outputTokens: 20, promptTokens: 10 },
    });

    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as any,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      listModels: mockListModels,
    });

    // Gemini should be called once with retryIfTruncated flag
    expect(mockGeminiService.callGeminiAPI).toHaveBeenCalledTimes(1);
    expect(mockGeminiService.callGeminiAPI).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({ retryIfTruncated: true }),
      }),
    );
    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining('full message'),
      expect.any(String),
    );
  });
});
