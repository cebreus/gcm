import { expect, mock, test } from 'bun:test';

import type {
  LanguageModelResponse,
  LanguageModelService,
} from '../src/language-model-service.ts';
import { createLogger } from '../src/logger.ts';
import runner from '../src/runner.ts';
import type { GitService } from '../src/services/git-service.ts';

void mock.module('@clack/prompts', () => ({
  intro: mock(() => {}),
  outro: mock(() => {}),
  spinner: mock(() => ({ start: mock(() => {}), stop: mock(() => {}) })),
  note: mock(() => {}),
  select: mock(async (prompt: { options: Array<{ value: string }> }) => {
    const values = prompt.options.map((option) => option.value);
    return await Promise.resolve(
      values.includes('generate') ? 'generate' : 'continue',
    );
  }),
  text: mock(async () => await Promise.resolve('')),
  isCancel: mock((value: unknown) => value === 'cancel'),
  cancel: mock((message: string) => {
    process.stderr.write(message);
  }),
}));

async function runnerFallbackStructuredOutputTest(
  response: LanguageModelResponse | null,
): Promise<void> {
  // Provide a git service that returns staged changes
  function createGitServiceFake(): GitService {
    return {
      listCommitHashes: async () => [],
      hasAmendment: async () => false,
      getHeadHash: async () => 'head',
      retrieveStagedChanges: async (
        commitHash: string | null,
        _logger: Parameters<GitService['retrieveStagedChanges']>[1],
        excludePatterns: string[] = [],
      ) => ({
        stagedDiff: 'diff --staged content',
        stagedFiles: ['src/index.js', 'README.md'],
        truncated: false,
      }),
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
      getIndexTree: async (
        _logger: Parameters<GitService['getIndexTree']>[0],
      ) => '',
      getIndexEntries: async (
        _logger: Parameters<GitService['getIndexEntries']>[0],
      ) => [],
      getRepositoryState: async (
        _logger: Parameters<GitService['getRepositoryState']>[0],
      ) => ({
        hasStagedChanges: true,
        hasUnmergedPaths: false,
        inProgressOperation: null,
        changedFiles: ['src/index.js', 'README.md'],
      }),
    };
  }

  // Provide a service whose response carries no usable text
  function createGeminiServiceFake(): LanguageModelService {
    return {
      generate: async (
        _params: Parameters<LanguageModelService['generate']>[0],
      ) => response,
    };
  }

  const logs: string[] = [];
  const {
    stdout: { write: originalStdoutWrite },
    stderr: { write: originalStderrWrite },
    exitCode: originalExitCode,
  } = process;
  process.stdout.write = (chunk: string | Uint8Array) => {
    logs.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    logs.push(String(chunk));
    return true;
  };

  // Ensure API key is present
  const {
    env: { GCM_GEMINI_API_KEY: origApiKey },
  } = process;
  process.env.GCM_GEMINI_API_KEY = 'fake-key';
  try {
    await runner.executeCommitMessageGeneration(
      ['--model', 'gemini-3.7-flash'],
      {
        gitService: createGitServiceFake(),
        geminiService: createGeminiServiceFake(),
        geminiModelLister: async function () {
          return [
            {
              name: 'models/gemini-3.7-flash',
              label: 'Gemini 3.7 Flash',
              limits: {
                kind: 'separate' as const,
                maxInputTokens: 1_048_576,
                maxOutputTokens: 65_536,
              },
            },
          ];
        },
        logger: createLogger({ LOG_LEVEL: 'info' }),
      },
    );
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode ?? 0;
    if (origApiKey === undefined) {
      delete process.env.GCM_GEMINI_API_KEY;
    } else {
      process.env.GCM_GEMINI_API_KEY = origApiKey;
    }
  }

  const joined = logs.join('\n');
  expect(joined).toContain('did not return a usable response.');
  expect(joined).not.toContain('BRANCH');
  expect(joined).not.toContain('Failed to parse');
}
for (const text of [null, '', ' \n\t']) {
  test(`runner: ${JSON.stringify(text)} provider text is reported as no usable response`, async () =>
    await runnerFallbackStructuredOutputTest(
      text === null ? null : { text, usage: {}, truncated: false },
    ));
}
