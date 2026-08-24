import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const repository = await mkdtemp(`${Bun.env.TMPDIR ?? '/tmp'}/gcm-provider-`);

const note = mock(function () {});
const cancel = mock(function () {});
const select = mock(async function (options: { message: string }) {
  if (options.message === 'What would you like to do?') return 'cancel';
  throw new Error(`Unexpected prompt: ${options.message}`);
});

await mock.module('@clack/prompts', function () {
  return {
    intro: function () {},
    outro: function () {},
    spinner: function () {
      return { start: function () {}, stop: function () {} };
    },
    note,
    select,
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
  await rm(repository, { recursive: true, force: true });
});

test('a keyless provider generates from a real staged Git snapshot', async function () {
  await runGit('init', '--quiet');
  await Bun.write(`${repository}/change.ts`, 'export const answer = 42;\n');
  await runGit('add', '--', 'change.ts');
  process.chdir(repository);

  let receivedPrompt = '';
  await executeCommitMessageGeneration(['--model', 'local-model', '--mode', 'commit-only'], {
    logger: { log: function () {} },
    languageModelProvider: {
      id: 'local',
      label: 'Local',
      defaultModel: 'local-model',
      fallbackModels: [
        {
          name: 'local-model',
          label: 'Local model',
          maxInputTokens: 8_192,
          maxOutputTokens: 1_024,
        },
      ],
      service: {
        generate: async function (params) {
          receivedPrompt = params.promptContext;
          return { text: 'COMMIT_MESSAGE: test: use local provider', usage: {} };
        },
      },
      listModels: async function () {
        return ['local-model'];
      },
      getModelSpec: function (name) {
        return {
          name,
          label: 'Local model',
          maxInputTokens: 8_192,
          maxOutputTokens: 1_024,
        };
      },
    },
  });

  expect(cancel).not.toHaveBeenCalled();
  expect(receivedPrompt).toContain('change.ts');
  expect(receivedPrompt).toContain('export const answer = 42;');
  expect(note).toHaveBeenCalledWith(
    expect.stringContaining('test: use local provider'),
    'Generated Commit Message',
  );
  expect(cancel).not.toHaveBeenCalledWith(expect.stringContaining('GOOGLE_GEMINI_API_KEY'));
});
