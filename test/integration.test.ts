import { test, expect, mock, afterEach } from 'bun:test';
import { run as runnerRun } from '../src/runner';

// Mock high-level application modules - using dependency injection instead of global mocks
const mockCallGemini = mock(async () => ({
  text: 'BRANCH: feat/test\nCOMMIT_MESSAGE: feat(test): initial commit\nPR_TITLE: Feat: initial commit\nPR_DESCRIPTION: Initial commit description.',
  usage: { promptTokens: 100, outputTokens: 50, thinkingTokens: 0 },
}));
const mockGeminiClient = { callGemini: mockCallGemini };
const mockCreateGeminiClient = mock(() => mockGeminiClient);

const mockLoggerInstance = {
  log: mock(() => {}),
  flush: mock(async () => {}),
};
const mockCreateLogger = mock(() => mockLoggerInstance);

const mockGetScopeSuggestions = mock(async () => ['feat', 'fix']);

// Mock only the scope-detector to avoid polluting other tests
mock.module('../src/scope-detector', () => ({ getScopeSuggestions: mockGetScopeSuggestions }));

// DO NOT mock CLI or Logger globally - that causes issues in other tests.
// Instead, we'll pass mocks through dependency injection where needed.

afterEach(() => {
  mockCallGemini.mockClear();
  mockCreateGeminiClient.mockClear();
  mockLoggerInstance.log.mockClear();
  mockGetScopeSuggestions.mockClear();
});

// Mock spawn implementations for git commands
async function mockSpawnStreamImpl(args: string[]): Promise<{ text: string; truncated: boolean }> {
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
  if (cmd.includes('show -w') && cmd.includes('--name-only')) {
    return { text: 'src/index.js', truncated: false };
  }
  if (cmd.includes('show -w') && cmd.includes('a1b2c3d')) {
    return { text: 'diff for commit a1b2c3d', truncated: false };
  }
  return { text: '', truncated: false };
}

// --- Integration Tests ---
test('integration: end-to-end - stage files -> generate commit message', async () => {
  await runnerRun([], {
    logger: mockLoggerInstance,
    spawnStreamImpl: mockSpawnStreamImpl,
    createGeminiClient: mockCreateGeminiClient,
  });

  expect(mockCreateGeminiClient).toHaveBeenCalled();
  expect(mockGeminiClient.callGemini).toHaveBeenCalled();
  expect(mockGetScopeSuggestions).toHaveBeenCalledWith(['file1.ts', 'file2.js']);
});

test('integration: end-to-end - analyze specific commit', async () => {
  await runnerRun(['-c', 'a1b2c3d'], {
    logger: mockLoggerInstance,
    spawnStreamImpl: mockSpawnStreamImpl,
    createGeminiClient: mockCreateGeminiClient,
  });

  expect(mockGeminiClient.callGemini).toHaveBeenCalled();
  expect(mockGetScopeSuggestions).toHaveBeenCalledWith(['src/index.js']);
});

test('integration: token limit scenario - should trigger fallback', async () => {
  mockCallGemini.mockRejectedValueOnce(new Error('MAX_TOKENS')); // First call fails
  mockCallGemini.mockResolvedValueOnce({
    text: 'BRANCH: feat/success\nCOMMIT_MESSAGE: feat(success): it worked\nPR_TITLE: Success\nPR_DESCRIPTION: It worked.',
    usage: { promptTokens: 10, outputTokens: 5, thinkingTokens: 0 },
  }); // Second call succeeds

  await runnerRun([], {
    logger: mockLoggerInstance,
    spawnStreamImpl: mockSpawnStreamImpl,
    createGeminiClient: mockCreateGeminiClient,
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

  await runnerRun([], {
    logger: mockLoggerInstance,
    spawnStreamImpl: customSpawnStreamImpl,
    createGeminiClient: mockCreateGeminiClient,
  });

  expect(mockGetScopeSuggestions).toHaveBeenCalledWith([
    'src/component.tsx',
    'styles/main.css',
    'README.md',
  ]);
  expect(mockGeminiClient.callGemini).toHaveBeenCalled();
});

test('integration: should handle concurrent execution safety', async () => {
  const results = await Promise.all([
    runnerRun([], {
      logger: mockLoggerInstance,
      spawnStreamImpl: mockSpawnStreamImpl,
      createGeminiClient: mockCreateGeminiClient,
    }),
    runnerRun([], {
      logger: mockLoggerInstance,
      spawnStreamImpl: mockSpawnStreamImpl,
      createGeminiClient: mockCreateGeminiClient,
    }),
  ]);

  expect(results).toHaveLength(2);
  expect(mockCallGemini).toHaveBeenCalledTimes(2);
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

  await runnerRun([], {
    logger: mockLoggerInstance,
    spawnStreamImpl: realGitSpawnStreamImpl,
    createGeminiClient: mockCreateGeminiClient,
  });

  expect(mockGeminiClient.callGemini).toHaveBeenCalled();
});
