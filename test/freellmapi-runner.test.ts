import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalProvider = process.env.GCM_PROVIDER;
const originalUrl = process.env.GCM_FREELLMAPI_URL;
const originalModel = process.env.GCM_FREELLMAPI_MODEL;
const originalToken = process.env.GCM_FREELLMAPI_TOKEN;
const originalLmToken = process.env.LM_API_TOKEN;
const originalGeminiKey = process.env.GOOGLE_GEMINI_API_KEY;
const originalExitCode = process.exitCode;
const repository = await mkdtemp(`${Bun.env.TMPDIR ?? '/tmp'}/gcm-freellmapi-`);
const note = mock(function () {});
const cancel = mock(function () {});

await mock.module('@clack/prompts', function () {
  return {
    intro: function () {},
    outro: function () {},
    spinner: function () {
      return { start: function () {}, stop: function () {} };
    },
    note,
    select: async function (options: { message: string }) {
      if (options.message === 'What would you like to do?') return 'cancel';
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
  };
});

process.env.HOME = repository;
delete process.env.GOOGLE_GEMINI_API_KEY;
process.env.GCM_FREELLMAPI_TOKEN = 'provider-specific-token';
process.env.LM_API_TOKEN = 'lm-studio-secret-token';
async function runGit(...args: string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ['git', ...args], cwd: repository, stderr: 'pipe' });
  const stderr = await new Response(child.stderr).text();
  if ((await child.exited) !== 0) throw new Error(stderr);
}

afterAll(async function () {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProvider === undefined) delete process.env.GCM_PROVIDER;
  else process.env.GCM_PROVIDER = originalProvider;
  if (originalUrl === undefined) delete process.env.GCM_FREELLMAPI_URL;
  else process.env.GCM_FREELLMAPI_URL = originalUrl;
  if (originalModel === undefined) delete process.env.GCM_FREELLMAPI_MODEL;
  else process.env.GCM_FREELLMAPI_MODEL = originalModel;
  if (originalToken === undefined) delete process.env.GCM_FREELLMAPI_TOKEN;
  else process.env.GCM_FREELLMAPI_TOKEN = originalToken;
  if (originalLmToken === undefined) delete process.env.LM_API_TOKEN;
  else process.env.LM_API_TOKEN = originalLmToken;
  if (originalGeminiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = originalGeminiKey;
  process.exitCode = originalExitCode;
  await rm(repository, { recursive: true, force: true });
});

test('FreeLLMAPI provider runs end to end without Gemini API key', async function () {
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

      const body = (await request.json()) as { messages: Array<{ content: string }> };
      const userMessage = body.messages[1];
      if (!userMessage) throw new Error('Missing user message');
      generatedPrompt = userMessage.content;

      return Response.json({
        choices: [
          {
            message: { content: 'COMMIT_MESSAGE: feat: support freellmapi' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      });
    },
  });

  try {
    await runGit('init', '--quiet');
    await Bun.write(`${repository}/app.ts`, 'console.log("hello freellmapi");\n');
    await runGit('add', '--', 'app.ts');
    process.chdir(repository);

    process.env.GCM_PROVIDER = 'freellmapi';
    process.env.GCM_FREELLMAPI_URL = server.url.origin;
    const { executeCommitMessageGeneration } = await import('../src/runner.js');

    await executeCommitMessageGeneration(['--model', 'gemini-2.5-flash', '--mode', 'commit-only'], {
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
