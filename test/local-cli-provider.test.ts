import { expect, spyOn, test } from 'bun:test';

import { childEnvironment } from '../src/git-utils.js';
import {
  type LocalCliRun,
  createClaudeCliProvider,
  createCodexCliProvider,
  runLocalCli,
} from '../src/local-cli-provider.js';

const generateParams = {
  promptContext: 'staged diff',
  systemPrompt: 'commit rules',
  meta: {},
  maxOutputTokens: 8192,
  modelName: 'gpt-6-luna',
};

test('Codex falls back on structured availability errors without stderr', async () => {
  let calls = 0;
  const provider = createCodexCliProvider({
    executable: 'unused',
    run: async function () {
      calls += 1;
      if (calls === 1) {
        return {
          exitCode: 1,
          stderr: '',
          stdout: JSON.stringify({
            type: 'turn.failed',
            error: { message: 'model overloaded' },
          }),
        };
      }
      return {
        exitCode: 0,
        stderr: '',
        stdout: [
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'fix: fallback' },
          }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      };
    },
  });
  await expect(
    provider.service.generate(generateParams),
  ).resolves.toMatchObject({
    text: 'fix: fallback',
  });
  expect(calls).toBe(2);
});

test('CLI fallback cannot start after the shared deadline expires', async () => {
  const now = spyOn(Date, 'now')
    .mockReturnValueOnce(1000)
    .mockReturnValue(91_001);
  let calls = 0;
  try {
    const provider = createCodexCliProvider({
      executable: 'unused',
      run: async function () {
        calls += 1;
        return { exitCode: 1, stderr: 'model unavailable', stdout: '' };
      },
    });
    await expect(provider.service.generate(generateParams)).rejects.toThrow(
      'model unavailable',
    );
    expect(calls).toBe(1);
  } finally {
    now.mockRestore();
  }
});

test.each(['missing', 'failed'])(
  'Codex rejects %s completion',
  async (ending) => {
    const provider = createCodexCliProvider({
      executable: 'unused',
      run: async function () {
        const message = {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'fix: partial message' },
        };
        return {
          exitCode: 0,
          stderr: '',
          stdout: [
            JSON.stringify(message),
            ...(ending === 'failed'
              ? [
                  JSON.stringify({
                    type: 'turn.failed',
                    error: { message: 'failed' },
                  }),
                ]
              : []),
          ].join('\n'),
        };
      },
    });
    await expect(provider.service.generate(generateParams)).rejects.toThrow();
  },
);

test('CLI prompts redact credentials and output limits reject truncation', async () => {
  const provider = createClaudeCliProvider({
    executable: 'unused',
    run: async function (request) {
      expect(request.stdin).not.toContain('secret-example-value');
      expect(request.cmd.join(' ')).not.toContain('secret-example-value');
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'fix: cut off',
          usage: { output_tokens: 100 },
        }),
      };
    },
  });
  await expect(
    provider.service.generate({
      ...generateParams,
      modelName: 'haiku',
      systemPrompt: 'Authorization: Bearer secret-example-value',
      promptContext: 'Authorization: Bearer secret-example-value',
      maxOutputTokens: 100,
    }),
  ).resolves.toMatchObject({ truncated: true });
});

test('Claude rejects error result even when result text exists', async () => {
  const provider = createClaudeCliProvider({
    executable: 'unused',
    run: async function () {
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'error_max_turns',
          result: 'fix: unfinished',
          is_error: false,
        }),
      };
    },
  });
  await expect(
    provider.service.generate({ ...generateParams, modelName: 'haiku' }),
  ).rejects.toThrow();
});

test('CLI overflow stops the child and reports bounded failure', async () => {
  await expect(
    runLocalCli({
      cmd: [
        process.execPath,
        '-e',
        'process.stdout.write("x".repeat(2 * 1024 * 1024)); setInterval(function () {}, 1000)',
      ],
      stdin: '',
      timeoutMs: 2000,
    }),
  ).rejects.toThrow('Local CLI output was too large');
});

test('local CLI environment drops provider credentials and keeps the rest', () => {
  expect(
    childEnvironment({
      PATH: '/bin',
      HOME: '/home/fake',
      ANTHROPIC_API_KEY: 'fake-anthropic',
      OPENAI_API_KEY: 'fake-openai',
      GOOGLE_GEMINI_API_KEY: 'fake-gemini',
      GCM_FREELLMAPI_TOKEN: 'fake-freellm',
      LM_API_TOKEN: 'fake-lm',
      UNSET: undefined,
    }),
  ).toEqual({
    PATH: '/bin',
    HOME: '/home/fake',
    ANTHROPIC_API_KEY: 'fake-anthropic',
    OPENAI_API_KEY: 'fake-openai',
  });
});

test('Codex CLI falls back from Luna to Sol without persistence', async () => {
  const calls: Array<Parameters<LocalCliRun>[0]> = [];
  const fallbacks: string[][] = [];
  const provider = createCodexCliProvider({
    executable: '/opt/homebrew/bin/codex',
    run: async function (request) {
      calls.push(request);
      if (calls.length === 1) {
        return { exitCode: 1, stderr: 'model overloaded (429)', stdout: '' };
      }
      return {
        exitCode: 0,
        stderr: '',
        stdout: [
          JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: 'feat(cli): add local provider',
            },
          }),
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 120, output_tokens: 8 },
          }),
        ].join('\n'),
      };
    },
    onFallback: function (from, to) {
      fallbacks.push([from, to]);
    },
  });

  expect(
    (await provider.models()).map((model) => [model.name, model.label]),
  ).toEqual([
    ['gpt-6-luna', 'GPT-6 Luna'],
    ['gpt-6.1-sol', 'GPT-6.1 Sol'],
    ['gpt-6.1-terra', 'GPT-6.1 Terra'],
  ]);
  expect(provider.defaultModel).toBe('gpt-6-luna');
  await expect(provider.service.generate(generateParams)).resolves.toEqual({
    text: 'feat(cli): add local provider',
    truncated: false,
    usage: { promptTokens: 120, outputTokens: 8 },
  });
  expect(calls[0]?.cmd).toContain('gpt-6-luna');
  expect(calls[1]?.cmd).toEqual([
    '/opt/homebrew/bin/codex',
    '--no-daemon',
    '--disable',
    'shell_tool',
    '--disable',
    'unified_exec',
    '--disable',
    'plugins',
    '--disable',
    'skill_search',
    '-c',
    'mcp_servers={}',
    '-c',
    'web_search="disabled"',
    '-c',
    'features.skip_host_skill_discovery=true',
    '--ask-for-approval',
    'never',
    '--model',
    'gpt-6.1-sol',
    'exec',
    '--ephemeral',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--json',
    '-',
  ]);
  expect(calls[1]?.stdin).toBe('commit rules\n\nstaged diff');
  expect(calls[1]?.timeoutMs).toBeLessThanOrEqual(90_000);
  expect(fallbacks).toEqual([['gpt-6-luna', 'gpt-6.1-sol']]);
});

test('Codex CLI does not fallback when authentication is unavailable', async () => {
  let calls = 0;
  const provider = createCodexCliProvider({
    executable: '/opt/homebrew/bin/codex',
    run: async function () {
      calls += 1;
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'authentication service unavailable',
      };
    },
  });

  await expect(provider.service.generate(generateParams)).rejects.toThrow(
    'authentication service unavailable',
  );
  expect(calls).toBe(1);
});

test('Claude CLI defaults to Haiku with Sonnet fallback', async () => {
  const calls: Array<Parameters<LocalCliRun>[0]> = [];
  const fallbacks: string[][] = [];
  const provider = createClaudeCliProvider({
    executable: '/opt/homebrew/bin/claude',
    run: async function (request) {
      calls.push(request);
      if (calls.length === 1) {
        return { exitCode: 1, stderr: 'model unavailable', stdout: '' };
      }
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          type: 'result',
          is_error: false,
          result: 'feat(cli): add Claude provider',
          usage: { input_tokens: 110, output_tokens: 7 },
        }),
      };
    },
    onFallback: function (from, to) {
      fallbacks.push([from, to]);
    },
  });

  expect((await provider.models()).map((model) => model.name)).toEqual([
    'haiku',
    'sonnet',
    'opus',
    'fable',
  ]);
  expect(provider.defaultModel).toBe('haiku');
  await expect(
    provider.service.generate({ ...generateParams, modelName: 'haiku' }),
  ).resolves.toEqual({
    text: 'feat(cli): add Claude provider',
    truncated: false,
    usage: { promptTokens: 110, outputTokens: 7 },
  });
  expect(calls[1]?.cmd).toEqual([
    '/opt/homebrew/bin/claude',
    '--print',
    '--model',
    'sonnet',
    '--tools',
    '',
    '--no-session-persistence',
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--output-format',
    'json',
    '--system-prompt',
    'commit rules',
  ]);
  expect(calls[1]?.stdin).toBe('staged diff');
  expect(calls[1]?.timeoutMs).toBeLessThanOrEqual(90_000);
  expect(fallbacks).toEqual([['haiku', 'sonnet']]);
});

test('local CLI timeout force-kills a process that ignores SIGTERM', async () => {
  const startedAt = Date.now();
  await expect(
    runLocalCli({
      cmd: [
        process.execPath,
        '-e',
        'process.on("SIGTERM", function () {}); setInterval(function () {}, 1000)',
      ],
      stdin: '',
      timeoutMs: 20,
    }),
  ).rejects.toMatchObject({
    message: 'Local CLI request timed out',
    metadata: { availability: true, kind: 'timeout' },
  });
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});

test('a CLI-reported timeout is typed as a timeout', async () => {
  const provider = createCodexCliProvider({
    executable: 'unused',
    run: async function () {
      return { exitCode: 1, stderr: 'error: request timed out', stdout: '' };
    },
  });
  await expect(
    provider.service.generate({ ...generateParams, modelName: 'gpt-6-luna' }),
  ).rejects.toMatchObject({ metadata: { kind: 'timeout' } });
});
