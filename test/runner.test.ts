import { expect, test, mock, describe, beforeEach, afterEach } from 'bun:test';
import { executeCommitMessageGeneration } from '../src/runner.js';

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
const mockLoadSession = mock(() => Promise.resolve({ modelName: null, outputMode: null }));
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
const mockLogger = { log: mock(), flush: mock(), flushSync: mock() };
const mockGitService = { retrieveStagedChanges: mock(), commitChanges: mock() };
const mockContextService = { constructLLMPromptContext: mock() };
const mockGeminiService = { callGeminiAPI: mock() };
const mockListModels = mock(() =>
  Promise.resolve(['models/gemini-2.5-flash', 'models/gemini-2.5-pro']),
);

describe('Refactored Runner', () => {
  beforeEach(() => {
    mockLogger.log.mockClear();
    mockGitService.retrieveStagedChanges.mockClear();
    mockContextService.constructLLMPromptContext.mockClear();
    mockGeminiService.callGeminiAPI.mockClear();
    mockListModels.mockClear();

    // Clear clack mocks
    mockIntro.mockClear();
    mockOutro.mockClear();
    mockSpinner.mockClear();
    mockNote.mockClear();
    mockSelect.mockClear();
    mockText.mockClear();

    // Clear clipboardy mock
    mockClipboardyWrite.mockClear();
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
      processedDiffContent: 'diff',
      tokens: 10,
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
      expect(output).toContain('0.6.0');
      expect(mockIntro).not.toHaveBeenCalled();
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
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
      expect(output).toContain('0.6.0');
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
    expect(mockGitService.commitChanges).toHaveBeenCalledWith('edited message', expect.any(Object));
  });

  test('Should handle no staged changes', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue(null);
    mockSelect.mockResolvedValueOnce('generate'); // Pre-flight

    await executeCommitMessageGeneration([], {
      logger: mockLogger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
      listModels: mockListModels,
    });
    expect(mockGeminiService.callGeminiAPI).not.toHaveBeenCalled();
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
