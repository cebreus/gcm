import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalProvider = process.env.GCM_PROVIDER;
const originalUrl = process.env.GCM_OPENAI_URL;
const originalModel = process.env.GCM_OPENAI_MODEL;
const originalToken = process.env.OPENAI_API_KEY;
const originalGcmToken = process.env.GCM_OPENAI_TOKEN;
const originalLmToken = process.env.LM_API_TOKEN;
const originalGeminiKey = process.env.GOOGLE_GEMINI_API_KEY;
const repository = await mkdtemp(`${Bun.env.TMPDIR ?? '/tmp'}/gcm-openai-`);
const note = mock(function () {});

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
    cancel: function () {},
  };
});

process.env.HOME = repository;
delete process.env.GOOGLE_GEMINI_API_KEY;
process.env.OPENAI_API_KEY = 'generic-openai-token';
process.env.GCM_OPENAI_TOKEN = 'provider-specific-token';
process.env.LM_API_TOKEN = 'lm-studio-secret-token';
const { executeCommitMessageGeneration } = await import('../src/runner.js');

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
  if (originalUrl === undefined) delete process.env.GCM_OPENAI_URL;
  else process.env.GCM_OPENAI_URL = originalUrl;
  if (originalModel === undefined) delete process.env.GCM_OPENAI_MODEL;
  else process.env.GCM_OPENAI_MODEL = originalModel;
  if (originalToken === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalToken;
  if (originalGcmToken === undefined) delete process.env.GCM_OPENAI_TOKEN;
  else process.env.GCM_OPENAI_TOKEN = originalGcmToken;
  if (originalLmToken === undefined) delete process.env.LM_API_TOKEN;
  else process.env.LM_API_TOKEN = originalLmToken;
  if (originalGeminiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = originalGeminiKey;
  await rm(repository, { recursive: true, force: true });
});

test('OpenAI / FreeLLMAPI provider runs end to end without Gemini API key', async function () {
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
          data: [{ id: 'gemini-2.5-flash', object: 'model' }],
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
    process.env.GCM_OPENAI_URL = server.url.origin;

    await executeCommitMessageGeneration(['--model', 'gemini-2.5-flash', '--mode', 'commit-only'], {
      isInteractive: false,
      logger: { log: function () {} },
    });

    expect(process.exitCode).toBe(0);
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
