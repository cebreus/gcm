import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import { loadConfig } from '../gcm.config.js';
import { parseArgs } from '../src/cli.js';
import {
  createGenerationState,
  runGenerationCommand,
} from '../src/generation.js';
import { GitCommandError } from '../src/git-utils.js';
import { createLanguageModelApiError } from '../src/language-model-service.js';
import {
  rejectUnsafeModelMetadata,
  requestLanguageModelJson,
} from '../src/openai-compatible-client.js';
import { ResponseBodyTooLargeError } from '../src/provider-http.js';
import { runProvidersListCommand } from '../src/providers-list-command.js';
import { executeCommitMessageGeneration } from '../src/runner.js';
import type { GitService } from '../src/services/git-service.js';

const CONFIG = loadConfig({ GCM_MAX_RETRIES: '0' });
const { fetch: originalFetch } = globalThis;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function gitError(message: string, kind: string): Promise<Error> {
  return new GitCommandError(message, kind as GitCommandError['kind']);
}

async function tooLargeError(message: string): Promise<Error> {
  return new ResponseBodyTooLargeError(message);
}

// Site 1: response body too large

test('transport maps an oversized body by type, whatever its message says', async () => {
  const error = await tooLargeError('unrelated text');
  await expect(
    requestLanguageModelJson({
      config: CONFIG,
      providerLabel: 'Test',
      url: new URL('https://example.test/v1/models'),
      timeoutMs: 1_000,
      fetchImpl: async () => {
        throw error;
      },
    }),
  ).rejects.toMatchObject({ message: 'Test response body is too large' });
});

test('transport still maps a real oversized body', async () => {
  await expect(
    requestLanguageModelJson({
      config: CONFIG,
      providerLabel: 'Test',
      url: new URL('https://example.test/v1/models'),
      timeoutMs: 1_000,
      fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)),
    }),
  ).rejects.toMatchObject({ message: 'Test response body is too large' });
});

test('Gemini catalogue maps an oversized body by type, whatever its message says', async () => {
  const error = await tooLargeError('unrelated text');
  globalThis.fetch = (async () => {
    throw error;
  }) as unknown as typeof fetch;
  const { listGeminiModels } = await import('../src/gemini-models.js');
  await expect(listGeminiModels('key', CONFIG)).rejects.toThrow(
    'Gemini model catalogue response body is too large',
  );
});

// Site 2: git failures

test('git boundary classifies stderr once', async () => {
  const { spawnGitStream } = await import('../src/git-utils.js');
  const dir = await mkdtemp(join(tmpdir(), 'gcm-typed-'));
  try {
    await expect(spawnGitStream(['-C', dir, 'status'])).rejects.toMatchObject({
      kind: 'not-a-repository',
    });
    await spawnGitStream(['init', '-q', dir]);
    await expect(
      spawnGitStream(['-C', dir, 'log', 'no-such-revision-gcm']),
    ).rejects.toMatchObject({
      kind: 'unknown-revision',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function runFailing(
  error: Error,
  targetCommit: string | null = null,
): Promise<string[]> {
  const cancel: string[] = [];
  const args = parseArgs([]);
  const { state } = createGenerationState({
    parsedArgs: args,
    session: { providerId: null, modelName: null },
    defaultModel: 'm',
    providerId: 'p',
  });
  const output = {
    isInteractive: false,
    startProgress() {},
    stopProgress() {},
    cancel: function (message: string) {
      cancel.push(message);
    },
    note() {},
    warn() {},
    outro() {},
    print() {},
    sanitizeGeneratedText: (message: string) => message,
    sanitizeTerminalText: (message: string) => message,
    style: {
      cyan: (m: string) => m,
      dim: (m: string) => m,
      yellow: (m: string) => m,
    },
  };
  await runGenerationCommand({
    createServices: () => {
      throw error;
    },
    parsedArgs: args,
    logger: { log() {} },
    targetCommit,
    state,
    output,
  });
  return cancel;
}

test('generation reports a non-repository by kind, whatever the message says', async () => {
  expect(await runFailing(await gitError('boom', 'not-a-repository'))).toEqual([
    'Error: Not inside a git repository.',
  ]);
});

test('generation reports an unknown revision by kind, whatever the message says', async () => {
  expect(
    await runFailing(await gitError('boom', 'unknown-revision'), 'abc123'),
  ).toEqual(['Error: Invalid commit SHA: abc123']);
});

test('runner reports a non-repository by kind, whatever the message says', async () => {
  const writes: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  };
  const error = await gitError('boom', 'not-a-repository');
  try {
    await executeCommitMessageGeneration(['--print'], {
      gitService: {
        getRepositoryState: async () => {
          throw error;
        },
      } as unknown as GitService,
      languageModelProviderFactories: [
        {
          id: 'local',
          label: 'Local',
          create: async () => {
            throw new Error('must not create');
          },
        },
      ],
    });
    expect(process.exitCode).toBe(1);
    expect(writes.join('')).toContain('Not inside a git repository');
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = 0;
  }
});

// Site 3: timeouts

test('generation prints a timeout without the API Error prefix, by kind', async () => {
  const error = createLanguageModelApiError('Provider is slow', {
    kind: 'timeout',
  });
  expect(await runFailing(error)).toEqual(['Provider is slow']);
});

test('generation keeps the API Error prefix for other unknown-status failures', async () => {
  const error = createLanguageModelApiError('Provider is slow');
  expect(await runFailing(error)).toEqual([
    'API Error (Unknown): Provider is slow',
  ]);
});

test('transport tags timeouts and other request failures with a kind', async () => {
  const request = async (
    fetchImpl: () => Promise<Response>,
  ): Promise<unknown> =>
    await requestLanguageModelJson({
      config: CONFIG,
      providerLabel: 'Test',
      url: new URL('https://example.test/v1/models'),
      timeoutMs: 1_000,
      fetchImpl,
    });
  await expect(
    request(async () => {
      throw new DOMException('stopped', 'TimeoutError');
    }),
  ).rejects.toMatchObject({ metadata: { kind: 'timeout' } });
  await expect(
    request(async () => {
      throw new TypeError('socket closed');
    }),
  ).rejects.toMatchObject({
    message: 'Test request failed',
    metadata: { kind: 'connection' },
  });
  await expect(
    request(async () => new Response('nope', { status: 500 })),
  ).rejects.toMatchObject({
    metadata: { status: 500, kind: 'connection' },
  });
});

test('Gemini discovery tags its timeout and no-models failures', async () => {
  const { listGeminiModels } = await import('../src/gemini-models.js');
  globalThis.fetch = (async () => {
    throw new DOMException('stopped', 'TimeoutError');
  }) as unknown as typeof fetch;
  await expect(listGeminiModels('key', CONFIG)).rejects.toMatchObject({
    message: 'Gemini model discovery timed out',
    metadata: { kind: 'timeout' },
  });
  globalThis.fetch = (async () =>
    Response.json({ models: [] })) as unknown as typeof fetch;
  await expect(listGeminiModels('key', CONFIG)).rejects.toMatchObject({
    metadata: { kind: 'no-models' },
  });
});

test('unsafe model metadata is tagged as an invalid model', () => {
  expect(() =>
    rejectUnsafeModelMetadata(['bad\u001b[31m'], undefined, 'Odd'),
  ).toThrow(expect.objectContaining({ metadata: { kind: 'invalid-model' } }));
});

// Site 4: providers list formatter

async function probeDetail(
  create: () => Promise<void>,
  readinessError?: string,
): Promise<string> {
  const notes: string[] = [];
  await runProvidersListCommand({
    factories: [
      {
        id: 'p',
        label: 'P',
        create: async () => {
          await create();
          return {
            id: 'p',
            label: 'P',
            defaultModel: 'm',
            readinessError,
            models: async () => [],
            service: { generate: async () => null },
          };
        },
      },
    ],
    output: {
      note: function (message) {
        notes.push(message);
      },
      outro() {},
    },
  });
  return notes[0] ?? '';
}

const failWith = (error: Error) => async () => {
  throw error;
};

test.each([
  [{ kind: 'timeout' }, 'The provider took too long to reply.'],
  [{ status: 401 }, 'The API key was not accepted.'],
  [{ status: 403 }, 'The API key was not accepted.'],
  [{ kind: 'missing-api-key' }, 'The API key is not set.'],
  [{ kind: 'no-models' }, 'No supported models found.'],
  [{ kind: 'invalid-model' }, 'Provider setup is not valid.'],
  [{ kind: 'connection' }, 'Cannot connect to the provider.'],
  [{}, 'Provider check failed.'],
])(
  'providers list maps %j by metadata, whatever the message says',
  async (metadata, expected) => {
    const detail = await probeDetail(
      failWith(createLanguageModelApiError('opaque', metadata)),
    );
    expect(detail).toContain(expected);
  },
);

test('providers list reports a provider readiness error as a missing API key', async () => {
  const detail = await probeDetail(async () => {}, 'Set the credential first.');
  expect(detail).toContain('The API key is not set.');
});

test('providers list does not reinterpret message text of typed errors', async () => {
  const detail = await probeDetail(
    failWith(
      createLanguageModelApiError('request timed out (401) no models found'),
    ),
  );
  expect(detail).toContain('Provider check failed.');
});

test('interactive retry labels a timeout by kind, whatever the message says', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gcm-typed-repo-'));
  const git = async (args: string[]): Promise<string> => {
    const child = Bun.spawn({
      cmd: ['git', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(err);
    }
    return out;
  };
  const previous = process.cwd();
  try {
    await git(['init', '-q']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.com']);
    await Bun.write(`${root}/a.ts`, 'export const a = 1;\n');
    await git(['add', '--', '.']);
    await git(['commit', '-qm', 'chore: initial']);
    await Bun.write(`${root}/a.ts`, 'export const a = 2;\n');
    await git(['add', '--', 'a.ts']);
    process.chdir(root);
    const { createGitService } = await import('../src/services/git-service.js');
    const { createCommitActionService } =
      await import('../src/commit-action-service.js');
    const logger = { log() {} };
    const gitService = createGitService({
      gitCommandRunner: async (args) => ({
        text: await git(args),
        truncated: false,
      }),
    });
    const progress: string[] = [];
    const recovered: string[] = [];
    const args = parseArgs([]);
    const { state } = createGenerationState({
      parsedArgs: args,
      session: { providerId: null, modelName: null },
      defaultModel: 'm',
      providerId: 'p',
    });
    const output = {
      isInteractive: true,
      startProgress() {},
      stopProgress: function (message?: string) {
        progress.push(message ?? '');
      },
      cancel() {},
      note() {},
      warn() {},
      outro() {},
      print() {},
      sanitizeGeneratedText: (message: string) => message,
      sanitizeTerminalText: (message: string) => message,
      style: {
        cyan: (m: string) => m,
        dim: (m: string) => m,
        yellow: (m: string) => m,
      },
    };
    await runGenerationCommand({
      createServices: () => ({
        logger,
        gitService,
        commitActions: createCommitActionService({ gitService, logger }),
        config: CONFIG,
        providerId: 'test',
        providerLabel: 'Test',
        contextService: {
          constructLLMPromptContext: async ({ diffContent }) => ({
            promptContext: diffContent,
            processedDiffContent: diffContent,
            tokens: 20,
          }),
        },
        languageModelService: {
          generate: async () => {
            throw createLanguageModelApiError('Provider is slow', {
              kind: 'timeout',
            });
          },
        },
        models: async () => [
          {
            name: 'm',
            label: 'M',
            limits: {
              kind: 'separate',
              maxInputTokens: 20_000,
              maxOutputTokens: 8_192,
            },
          },
        ],
        dialogue: {
          configure: async () => 'continue',
          handleEmptyStaging: async () => 'cancel',
          recoverGeneration: async (message) => {
            recovered.push(message);
            return 'cancel';
          },
          confirmAtomicity: async () => true,
          review: async () => {
            throw new Error('unreachable');
          },
        },
        getCommitContextHints: async () => ({
          scopeSuggestions: [],
          recentCommitSubjects: [],
        }),
        saveSession: async () => {},
      }),
      parsedArgs: args,
      logger,
      targetCommit: null,
      state,
      output,
    });
    expect(progress).toContain('Request timed out');
    expect(recovered).toEqual(['Provider is slow']);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
