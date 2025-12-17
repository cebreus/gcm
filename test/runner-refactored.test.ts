import { expect, test, mock, describe, beforeEach, afterEach } from 'bun:test';
import { executeCommitMessageGeneration } from '../src/runner-refactored.js';

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

    // Pre-flight: generate, Review: commit
    mockSelect.mockResolvedValueOnce('generate').mockResolvedValueOnce('commit');

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
    // Default is now Commit Only, so only message is shown
    expect(noteContent).toContain('test');
    expect(noteContent).not.toContain('BRANCH:');
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
    });
    expect(mockGeminiService.callGeminiAPI).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce('regenerate') // 2
      .mockResolvedValueOnce('gemini-2.5-pro') // 3
      .mockResolvedValueOnce('commit'); // 4

    await executeCommitMessageGeneration([], {
      logger: mockLogger as any,
      gitService: mockGitService,
      contextService: mockContextService,
      geminiService: mockGeminiService,
    });

    // Gemini should be called twice
    expect(mockGeminiService.callGeminiAPI).toHaveBeenCalledTimes(2);
    // Git commit called once
    expect(mockGitService.commitChanges).toHaveBeenCalled();
  });
});
