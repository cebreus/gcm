import { afterAll, expect, mock, test } from 'bun:test';

import { mkdtemp, rm } from 'fs/promises';

const originalCwd = process.cwd();
const {
  env: {
    HOME: originalHome,
    GCM_PROVIDER: originalProvider,
    GCM_FREELLMAPI_URL: originalUrl,
    GCM_FREELLMAPI_MODEL: originalModel,
    GCM_FREELLMAPI_API_KEY: originalToken,
    GCM_LM_STUDIO_API_KEY: originalLmToken,
    GCM_GEMINI_API_KEY: originalGeminiKey,
  },
  exitCode: originalExitCode,
} = process;
const repository = await mkdtemp(`${Bun.env.TMPDIR ?? '/tmp'}/gcm-freellmapi-`);
const note = mock(() => {});
const cancel = mock(() => {});

await mock.module('@clack/prompts', () => ({
  intro: function () {},
  outro: function () {},
  spinner: function () {
    return { start: function () {}, stop: function () {} };
  },
  note,
  select: async function (options: { message: string }) {
    if (options.message === 'What would you like to do?') {
      return 'cancel';
    }
    throw new Error(`Unexpected prompt: ${options.message}`);
  },
  text: async function () {
    throw new Error('Unexpected text prompt');
  },
  confirm: async function () {
    throw new Error('Unexpected confirm prompt');
  },
  isCancel: function (value: unknown) {
    return value === 'cancel';
  },
  cancel,
}));

process.env.HOME = repository;
delete process.env.GCM_GEMINI_API_KEY;
process.env.GCM_FREELLMAPI_API_KEY = 'provider-specific-token';
process.env.GCM_LM_STUDIO_API_KEY = 'lm-studio-secret-token';
async function runGit(...args: string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: ['git', ...args],
    cwd: repository,
    stderr: 'pipe',
  });
  const stderr = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) {
    throw new Error(stderr);
  }
}

afterAll(async () => {
  process.chdir(originalCwd);
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalProvider === undefined) {
    delete process.env.GCM_PROVIDER;
  } else {
    process.env.GCM_PROVIDER = originalProvider;
  }
  if (originalUrl === undefined) {
    delete process.env.GCM_FREELLMAPI_URL;
  } else {
    process.env.GCM_FREELLMAPI_URL = originalUrl;
  }
  if (originalModel === undefined) {
    delete process.env.GCM_FREELLMAPI_MODEL;
  } else {
    process.env.GCM_FREELLMAPI_MODEL = originalModel;
  }
  if (originalToken === undefined) {
    delete process.env.GCM_FREELLMAPI_API_KEY;
  } else {
    process.env.GCM_FREELLMAPI_API_KEY = originalToken;
  }
  if (originalLmToken === undefined) {
    delete process.env.GCM_LM_STUDIO_API_KEY;
  } else {
    process.env.GCM_LM_STUDIO_API_KEY = originalLmToken;
  }
  if (originalGeminiKey === undefined) {
    delete process.env.GCM_GEMINI_API_KEY;
  } else {
    process.env.GCM_GEMINI_API_KEY = originalGeminiKey;
  }
  process.exitCode = originalExitCode ?? 0;
  await rm(repository, { recursive: true, force: true });
});

test('FreeLLMAPI provider runs end to end without Gemini API key', async () => {
  process.exitCode = 0;
  let generatedPrompt = '';
  let receivedAuth = '';

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async function (request) {
      receivedAuth = request.headers.get('authorization') ?? '';
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return Response.json({
          object: 'list',
          data: [
            {
              id: 'auto',
              context_window: 32_768,
              object: 'model',
            },
            {
              id: 'gemini-2.5-flash',
              context_window: 32_768,
              object: 'model',
            },
          ],
        });
      }

      const body = (await request.json()) as {
        messages: Array<{ content: string }>;
      };
      const {
        messages: [, userMessage],
      } = body;
      ({ content: generatedPrompt } = userMessage);

      return Response.json({
        choices: [
          {
            message: { content: 'feat: support freellmapi' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      });
    },
  });

  try {
    await runGit('init', '--quiet');
    await Bun.write(
      `${repository}/app.ts`,
      'console.log("hello freellmapi");\n',
    );
    await runGit('add', '--', 'app.ts');
    process.chdir(repository);

    process.env.GCM_PROVIDER = 'freellmapi';
    const {
      url: { origin },
    } = server;
    process.env.GCM_FREELLMAPI_URL = origin;
    const { executeCommitMessageGeneration } = await import('../src/runner.js');

    await executeCommitMessageGeneration(['--model', 'gemini-2.5-flash'], {
      isInteractive: false,
      logger: { log: function () {} },
    });

    expect({ exitCode: process.exitCode, errors: cancel.mock.calls }).toEqual({
      exitCode: 0,
      errors: [],
    });
    expect(receivedAuth).toBe('Bearer provider-specific-token');
    expect(generatedPrompt).toContain('app.ts');
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('feat: support freellmapi'),
      'Generated Commit Message',
    );
  } finally {
    await server.stop(true);
  }
});
