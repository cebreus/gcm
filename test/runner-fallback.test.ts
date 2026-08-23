import { test, expect, mock } from 'bun:test';
import { createLogger } from '../src/logger.ts';
import runner from '../src/runner.ts';
import type { SpawnGitStreamResult } from '../src/git-utils.ts';
import type { GeminiService } from '../src/services/gemini-service.ts';
import type { GitService } from '../src/services/git-service.ts';

void mock.module('@clack/prompts', () => ({
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
  function createGitServiceFake(): GitService {
    return {
      retrieveStagedChanges: async (
        commitHash: string | null,
        _logger: Parameters<GitService['retrieveStagedChanges']>[1],
        excludePatterns: string[] = [],
      ) => {
        return {
          stagedDiff: 'diff --staged content',
          stagedFiles: ['src/index.js', 'README.md'],
          truncated: false,
        };
      },
      commitChanges: async (
        _message: Parameters<GitService['commitChanges']>[0],
        _logger: Parameters<GitService['commitChanges']>[1],
      ) => {},
      amendCommit: async (
        _message: Parameters<GitService['amendCommit']>[0],
        _logger: Parameters<GitService['amendCommit']>[1],
      ) => {},
      rewordCommit: async (
        _target: Parameters<GitService['rewordCommit']>[0],
        _message: Parameters<GitService['rewordCommit']>[1],
        _logger: Parameters<GitService['rewordCommit']>[2],
      ) => {},
      inspectCommitTarget: async (
        _hash: Parameters<GitService['inspectCommitTarget']>[0],
        _logger: Parameters<GitService['inspectCommitTarget']>[1],
      ) => {
        throw new Error('not used in this test');
      },
      getIndexTree: async (_logger: Parameters<GitService['getIndexTree']>[0]) => '',
      getIndexEntries: async (_logger: Parameters<GitService['getIndexEntries']>[0]) => [],
      getRepositoryState: async (_logger: Parameters<GitService['getRepositoryState']>[0]) => ({
        hasStagedChanges: true,
        hasUnstagedChanges: false,
        hasUntrackedFiles: false,
        hasUnmergedPaths: false,
        inProgressOperation: null,
        changedFiles: ['src/index.js', 'README.md'],
      }),
    };
  }

  // Provide a service that returns null to trigger fallback
  function createGeminiServiceFake(): GeminiService {
    return {
      callGeminiAPI: async (_params: Parameters<GeminiService['callGeminiAPI']>[0]) => null,
    };
  }

  const logs: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    logs.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logs.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;

  // Ensure API key is present
  const origApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  process.env.GOOGLE_GEMINI_API_KEY = 'fake-key';
  try {
    await runner.executeCommitMessageGeneration(['--model', 'gemini-3.7-flash'], {
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
