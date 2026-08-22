import { test, expect, mock, afterAll, afterEach, beforeEach } from 'bun:test';
import { executeCommitMessageGeneration as runnerRun } from '../src/runner.js';
import { createGitService } from '../src/services/git-service.js';
import { createGeminiService } from '../src/services/gemini-service.js';
import { createContextService } from '../src/services/context-service.js';

// Mock @clack/prompts
const mockIntro = mock();
const mockOutro = mock();
const mockSpinner = mock(() => ({ start: mock(), stop: mock() }));
const mockNote = mock();
const originalApiKey = process.env.GOOGLE_GEMINI_API_KEY;

async function selectIntegrationPrompt(options: {
  message: string;
  options: Array<{ value: string }>;
}): Promise<string> {
  const values = options.options.map(function (option) {
    return option.value;
  });
  if (
    options.message.startsWith('Settings:') &&
    values.join(',') === 'generate,configure,exit'
  ) {
    return 'generate';
  }
  if (
    options.message.startsWith('Staged files suggest multiple possible scopes:') &&
    values.join(',') === 'split,continue,cancel'
  ) {
    return 'continue';
  }
  if (options.message === 'What would you like to do?' && values.includes('cancel')) {
    return 'cancel';
  }
  throw new Error(`Unexpected select prompt: ${options.message}`);
}

async function rejectUnexpectedTextPrompt(options: { message: string }): Promise<never> {
  throw new Error(`Unexpected text prompt: ${options.message}`);
}

async function rejectUnexpectedConfirmPrompt(options: { message: string }): Promise<never> {
  throw new Error(`Unexpected confirm prompt: ${options.message}`);
}

const mockSelect = mock(selectIntegrationPrompt);
const mockText = mock(rejectUnexpectedTextPrompt);
const mockConfirm = mock(rejectUnexpectedConfirmPrompt);
const mockIsCancel = mock(() => false);
const mockCancel = mock();

mock.module('@clack/prompts', () => ({
  intro: mockIntro,
  outro: mockOutro,
  spinner: mockSpinner,
  note: mockNote,
  select: mockSelect,
  text: mockText,
  confirm: mockConfirm,
  isCancel: mockIsCancel,
  cancel: mockCancel,
}));

// Mock high-level application modules - using dependency injection instead of global mocks
const mockCallGemini = mock(async () => ({
  text: 'BRANCH: feat/test\nCOMMIT_MESSAGE: feat(test): initial commit\nPR_TITLE: Feat: initial commit\nPR_DESCRIPTION: Initial commit description.',
  usage: { promptTokens: 100, outputTokens: 50, thinkingTokens: 0 },
}));
const mockGeminiClient = { callGemini: mockCallGemini };
const mockCreateGeminiClient = mock(() => mockGeminiClient);

const mockLoggerInstance = {
  log: mock(() => {}),
};
const mockCreateLogger = mock(() => mockLoggerInstance);

const mockGetCommitContextHints = mock(async () => ({
  scopeSuggestions: ['feat'],
  recentCommitSubjects: ['feat(test): align existing style'],
}));

// Mock only the scope-detector to avoid polluting other tests
mock.module('../src/scope-detector', () => ({
  getCommitContextHints: mockGetCommitContextHints,
}));

const mockSummarizeLargeDiff = mock(async () => ({
  text: 'summary',
  numHunks: 1,
  totalTruncated: 0,
}));
mock.module('../src/summarizer', () => ({ summarizeLargeDiff: mockSummarizeLargeDiff }));

// DO NOT mock CLI or Logger globally - that causes issues in other tests.
// Instead, we'll pass mocks through dependency injection where needed.

beforeEach(() => {
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
});

afterAll(() => {
  if (originalApiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = originalApiKey;
});

afterEach(() => {
  mockCallGemini.mockClear();
  mockCreateGeminiClient.mockClear();
  mockLoggerInstance.log.mockClear();
  mockGetCommitContextHints.mockClear();

  mockIntro.mockClear();
  mockOutro.mockClear();
  mockSpinner.mockClear();
  mockNote.mockClear();
  mockSelect.mockClear();
  mockText.mockClear();
  mockConfirm.mockClear();
  mockCancel.mockClear();
});

// Mock spawn implementations for git commands
async function mockSpawnStreamImpl(args: string[]): Promise<{ text: string; truncated: boolean }> {
  // ... implementation ...
  const cmd = args.join(' ');
  if (cmd.includes('rev-parse --is-inside-work-tree')) {
    return { text: '', truncated: false };
  }
  if (cmd.includes('diff --staged') && cmd.includes('--name-only')) {
    return { text: 'file1.ts\nfile2.js', truncated: false };
  }
  if (cmd.includes('diff --staged -w')) {
    return {
      text: 'diff --git a/file1.ts b/file1.ts\n--- a/file1.ts\n+++ b/file1.ts\n@@ -1 +1 @@\n-old\n+new',
      truncated: false,
    };
  }
  if (cmd.includes('show --first-parent -w') && cmd.includes('--name-only')) {
    return { text: 'src/index.js', truncated: false };
  }
  if (cmd.includes('show --first-parent -w') && cmd.includes('a1b2c3d')) {
    return { text: 'diff for commit a1b2c3d', truncated: false };
  }
  return { text: '', truncated: false };
}

// --- Integration Tests ---
test('integration: end-to-end - stage files -> generate commit message', async () => {
  process.env.GOOGLE_GEMINI_API_KEY = 'test-key';
  const gitService = createGitService({ gitCommandRunner: mockSpawnStreamImpl as any });
  const geminiService = createGeminiService({
    client: mockGeminiClient as any,
    logger: mockLoggerInstance as any,
    apiKey: 'test-key',
  });
  const contextService = createContextService(); // Use real context service

  await runnerRun([], {
    logger: mockLoggerInstance as any,
    gitService,
    geminiService,
    contextService,
  });

  expect(mockCallGemini).toHaveBeenCalled();
  expect(mockGetCommitContextHints).toHaveBeenCalledWith(['file1.ts', 'file2.js']);
});

test('integration: end-to-end - analyze specific commit', async () => {
  const gitService = createGitService({ gitCommandRunner: mockSpawnStreamImpl as any });
  const geminiService = createGeminiService({
    client: mockGeminiClient as any,
    logger: mockLoggerInstance as any,
    apiKey: 'test-key',
  });
  const contextService = createContextService();

  await runnerRun(['-c', 'a1b2c3d'], {
    logger: mockLoggerInstance as any,
    gitService,
    geminiService,
    contextService,
  });

  expect(mockCallGemini).toHaveBeenCalled();
  expect(mockGetCommitContextHints).toHaveBeenCalledWith(['src/index.js']);
});

test('integration: token limit scenario - should trigger fallback', async () => {
  mockCallGemini.mockRejectedValueOnce(new Error('MAX_TOKENS')); // First call fails
  mockCallGemini.mockResolvedValueOnce({
    text: 'BRANCH: feat/success\nCOMMIT_MESSAGE: feat(success): it worked\nPR_TITLE: Success\nPR_DESCRIPTION: It worked.',
    usage: { promptTokens: 10, outputTokens: 5, thinkingTokens: 0 },
  }); // Second call succeeds

  const gitService = createGitService({ gitCommandRunner: mockSpawnStreamImpl as any });
  const geminiService = createGeminiService({
    client: mockGeminiClient as any,
    logger: mockLoggerInstance as any,
    apiKey: 'test-key',
  });
  const contextService = createContextService();

  await runnerRun([], {
    logger: mockLoggerInstance as any,
    gitService,
    geminiService,
    contextService,
  });

  expect(mockCallGemini).toHaveBeenCalledTimes(2);
});

test('integration: should handle various file types', async () => {
  async function customSpawnStreamImpl(
    args: string[],
  ): Promise<{ text: string; truncated: boolean }> {
    const cmd = args.join(' ');
    if (cmd.includes('rev-parse --is-inside-work-tree')) {
      return { text: '', truncated: false };
    }
    if (cmd.includes('diff --staged') && cmd.includes('--name-only')) {
      return { text: 'src/component.tsx\nstyles/main.css\nREADME.md', truncated: false };
    }
    if (cmd.includes('diff --staged -w')) {
      return { text: 'diff for multiple files', truncated: false };
    }
    return { text: '', truncated: false };
  }

  const gitService = createGitService({ gitCommandRunner: customSpawnStreamImpl as any });
  const geminiService = createGeminiService({
    client: mockGeminiClient as any,
    logger: mockLoggerInstance as any,
    apiKey: 'test-key',
  });
  const contextService = createContextService();

  await runnerRun([], {
    logger: mockLoggerInstance as any,
    gitService,
    geminiService,
    contextService,
  });

  expect(mockGetCommitContextHints).toHaveBeenCalledWith([
    'src/component.tsx',
    'styles/main.css',
    'README.md',
  ]);
  expect(mockCallGemini).toHaveBeenCalled();
});

test('integration: should handle concurrent execution safety', async () => {
  const gitService = createGitService({ gitCommandRunner: mockSpawnStreamImpl as any });
  const geminiService = createGeminiService({
    client: mockGeminiClient as any,
    logger: mockLoggerInstance as any,
    apiKey: 'test-key',
  });
  const contextService = createContextService();

  const results = await Promise.all([
    runnerRun([], {
      logger: mockLoggerInstance as any,
      gitService,
      geminiService,
      contextService,
    }),
    runnerRun([], {
      logger: mockLoggerInstance as any,
      gitService,
      geminiService,
      contextService,
    }),
  ]);

  expect(results).toHaveLength(2);
  expect(mockCallGemini).toHaveBeenCalledTimes(2);
});

test('integration: should not send whitespace-only staged changes to AI', async () => {
  async function whitespaceOnlyStagedSpawn(
    args: string[],
  ): Promise<{ text: string; truncated: boolean }> {
    const cmd = args.join(' ');
    if (cmd.includes('rev-parse --is-inside-work-tree')) {
      return { text: '', truncated: false };
    }
    if (cmd.includes('diff --staged --name-only')) {
      return { text: 'docs/README.md\ndocs/guide.md', truncated: false };
    }
    if (cmd.includes('diff --staged -w')) {
      return { text: '', truncated: false };
    }
    return { text: '', truncated: false };
  }

  const gitService = createGitService({ gitCommandRunner: whitespaceOnlyStagedSpawn as any });
  const geminiService = createGeminiService({
    client: mockGeminiClient as any,
    logger: mockLoggerInstance as any,
    apiKey: 'test-key',
  });
  const contextService = createContextService();
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await runnerRun([], {
      logger: mockLoggerInstance as any,
      gitService,
      geminiService,
      contextService,
    });

    expect(mockGetCommitContextHints).not.toHaveBeenCalled();
    expect(mockCallGemini).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith(
      'Only whitespace-only staged changes detected in 2 file(s). Nothing to send to AI.',
    );
    expect(Number(process.exitCode)).toBe(1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test('integration: should handle real git repository state', async () => {
  // This test would require a real git repo, but we can mock it
  async function realGitSpawnStreamImpl(
    args: string[],
  ): Promise<{ text: string; truncated: boolean }> {
    const cmd = args.join(' ');
    if (cmd.includes('rev-parse --is-inside-work-tree')) {
      return { text: '', truncated: false }; // Success
    }
    if (cmd.includes('diff --staged --name-only')) {
      return { text: 'package.json\nsrc/main.ts', truncated: false };
    }
    if (cmd.includes('diff --staged -w')) {
      return {
        text: 'diff --git a/package.json b/package.json\n@@ -1,3 +1,3 @@\n "version": "1.0.0"\n+"version": "1.1.0"',
        truncated: false,
      };
    }
    return { text: '', truncated: false };
  }

  const gitService = createGitService({ gitCommandRunner: realGitSpawnStreamImpl as any });
  const geminiService = createGeminiService({
    client: mockGeminiClient as any,
    logger: mockLoggerInstance as any,
    apiKey: 'test-key',
  });
  const contextService = createContextService();

  await runnerRun([], {
    logger: mockLoggerInstance as any,
    gitService,
    geminiService,
    contextService,
  });

  expect(mockCallGemini).toHaveBeenCalled();
});
