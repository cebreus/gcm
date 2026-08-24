import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalProvider = process.env.GCM_PROVIDER;
const originalUrl = process.env.GCM_LM_STUDIO_URL;
const originalModel = process.env.GCM_LM_STUDIO_MODEL;
const originalGeminiKey = process.env.GOOGLE_GEMINI_API_KEY;
const repository = await mkdtemp(`${Bun.env.TMPDIR ?? '/tmp'}/gcm-lm-studio-`);
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
  if (originalUrl === undefined) delete process.env.GCM_LM_STUDIO_URL;
  else process.env.GCM_LM_STUDIO_URL = originalUrl;
  if (originalModel === undefined) delete process.env.GCM_LM_STUDIO_MODEL;
  else process.env.GCM_LM_STUDIO_MODEL = originalModel;
  if (originalGeminiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = originalGeminiKey;
  await rm(repository, { recursive: true, force: true });
});

test('LM Studio runs end to end without a Gemini API key and cancellation creates no commit', async function () {
  let generatedPrompt = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async function (request) {
      if (request.method === 'GET') {
        return Response.json({
          models: [
            {
              key: 'local-model',
              type: 'llm',
              max_context_length: 32_768,
              loaded_instances: [{ config: { context_length: 32_768 } }],
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
            message: { content: 'COMMIT_MESSAGE: test: use local model' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 6 },
      });
    },
  });
  try {
    await runGit('init', '--quiet');
    await Bun.write(`${repository}/change.ts`, 'export const answer = 42;\n');
    await runGit('add', '--', 'change.ts');
    process.chdir(repository);
    process.env.GCM_PROVIDER = 'lm-studio';
    process.env.GCM_LM_STUDIO_URL = server.url.origin;
    process.env.GCM_LM_STUDIO_MODEL = 'local-model';

    await executeCommitMessageGeneration(['--model', 'local-model', '--mode', 'commit-only'], {
      isInteractive: false,
      logger: { log: function () {} },
    });

    expect(process.exitCode).toBe(0);
    expect(generatedPrompt).toContain('change.ts');
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('test: use local model'),
      'Generated Commit Message',
    );
    const head = Bun.spawnSync({ cmd: ['git', 'rev-parse', '--verify', 'HEAD'], cwd: repository });
    expect(head.exitCode).not.toBe(0);
  } finally {
    await server.stop(true);
  }
});
