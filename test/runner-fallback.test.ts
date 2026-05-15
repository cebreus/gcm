import { test, expect, mock } from 'bun:test';
import { createLogger } from '../src/logger.ts';
import runner from '../src/runner.ts';
import type { SpawnGitStreamResult } from '../src/git-utils.ts';
import type { GeminiClient } from '../src/gemini-client.ts';

mock.module('@clack/prompts', () => ({
  intro: mock(() => {}),
  outro: mock(() => {}),
  spinner: mock(() => ({ start: mock(() => {}), stop: mock(() => {}) })),
  note: mock(() => {}),
  select: mock(() => Promise.resolve('continue')),
  text: mock(() => Promise.resolve('')),
  isCancel: mock((value: unknown) => value === 'cancel'),
  cancel: mock(() => {}),
}));

async function runnerFallbackStructuredOutputTest(): Promise<void> {
  // Stubbed spawnStream implementation to simulate a staged diff and file list
  async function spawnStreamImpl(args: string[]): Promise<SpawnGitStreamResult> {
    const argStr = args.join(' ');
    if (argStr.includes('--stat')) {
      return await Promise.resolve({ text: ' 2 files changed\n', truncated: false });
    }
    if (argStr.includes('--name-only')) {
      return await Promise.resolve({ text: 'src/index.js\nREADME.md', truncated: false });
    }
    if (argStr.includes('diff --staged')) {
      return await Promise.resolve({ text: 'diff --staged content', truncated: false });
    }
    return await Promise.resolve({ text: '', truncated: false });
  }

  // Provide a git service that returns staged changes
  function createGitServiceFake() {
    return {
      retrieveStagedChanges: async (
        commitHash: string | null,
        logger: any,
        excludePatterns: string[] = [],
      ) => {
        return {
          stagedDiff: 'diff --staged content',
          stagedFiles: ['src/index.js', 'README.md'],
          truncated: false,
        };
      },
      commitChanges: async (message: string, logger: any) => {},
    };
  }

  // Provide a service that returns null to trigger fallback
  function createGeminiServiceFake() {
    return {
      callGeminiAPI: async () => null,
    };
  }

  const logs: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: any) => {
    logs.push(String(chunk));
    return true;
  }) as any;
  process.stderr.write = ((chunk: any) => {
    logs.push(String(chunk));
    return true;
  }) as any;

  // Ensure API key is present
  const origApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  process.env.GOOGLE_GEMINI_API_KEY = 'fake-key';
  try {
    await runner.executeCommitMessageGeneration(['--model', 'gemini-2.5-flash'], {
      gitService: createGitServiceFake(),
      geminiService: createGeminiServiceFake(),
      logger: createLogger({ LOG_LEVEL: 'info' }),
    });
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.env.GOOGLE_GEMINI_API_KEY = origApiKey;
  }

  const joined = logs.join('\n');
  expect(joined).toContain('BRANCH');
  expect(joined).toMatch(/COMMIT_MESSAGE|chore\/update-/);
  console.log('  fallbackTest -> passed');
}
test('runner: fallback structured output', runnerFallbackStructuredOutputTest);
