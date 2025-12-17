import { expect, test, mock, describe, beforeEach, afterEach } from 'bun:test';
import { executeCommitMessageGeneration } from '../src/runner-refactored.js';

// Mock @clack/prompts
const mockIntro = mock();
const mockOutro = mock();
const mockSpinner = mock(() => ({ start: mock(), stop: mock() }));
const mockNote = mock();
const mockSelect = mock(() => Promise.resolve('commit')); // Default to commit
const mockText = mock(() => Promise.resolve('edited message'));
const mockIsCancel = mock(() => false);
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

// Mocks
const mockLogger = { log: mock(), flush: mock(), flushSync: mock() };
const mockGitService = { retrieveStagedChanges: mock(), commitChanges: mock() };
const mockContextService = { constructLLMPromptContext: mock() };
const mockGeminiService = { callGeminiAPI: mock() };

describe('Refactored Runner', () => {
  beforeEach(() => {
    mockLogger.log.mockClear();
    mockGitService.retrieveStagedChanges.mockClear();
    mockContextService.constructLLMPromptContext.mockClear();
    mockGeminiService.callGeminiAPI.mockClear();

    // Clear clack mocks
    mockIntro.mockClear();
    mockOutro.mockClear();
    mockSpinner.mockClear();
    mockNote.mockClear();
    mockSelect.mockClear();
    mockText.mockClear();
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

    // Execute
    process.env.GOOGLE_GEMINI_API_KEY = 'test';
    await executeCommitMessageGeneration([], {
      logger: mockLogger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
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
    expect(noteContent).toContain('BRANCH: feat/test');
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
    mockSelect.mockResolvedValueOnce('edit').mockResolvedValueOnce('commit');
    mockText.mockResolvedValue('edited message');

    await executeCommitMessageGeneration([], {
      logger: mockLogger as any,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
    });

    // Verify text prompt called with initial value
    expect(mockText).toHaveBeenCalled();
    // Verify commit called with edited message
    expect(mockGitService.commitChanges).toHaveBeenCalledWith('edited message', expect.any(Object));
  });

  test('Should handle no staged changes', async () => {
    mockGitService.retrieveStagedChanges.mockResolvedValue(null);
    await executeCommitMessageGeneration([], {
      logger: mockLogger,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
    });
    expect(mockGeminiService.callGeminiAPI).not.toHaveBeenCalled();
  });
});
