import { tmpdir } from 'os';

import { childEnvironment } from './git-utils.js';
import {
  type LanguageModelProvider,
  type LanguageModelResponse,
  createLanguageModelApiError,
  isModelUnavailableError,
} from './language-model-service.js';
import { parseLocalCliJson } from './local-cli-json.js';
import {
  LOCAL_CLI_LIMITS,
  MAX_CLI_ERROR_BYTES,
  MAX_CLI_OUTPUT_BYTES,
} from './local-cli-models.js';
import {
  type LocalCliRunResult,
  cliFailure,
  parseClaudeOutput,
  parseCodexOutput,
} from './local-cli-output.js';
import {
  isRecord,
  redactSensitiveTextForPrompt,
  sanitizeTerminalText,
} from './utils.js';

const CLI_TIMEOUT_MS = 90_000;
const CLI_KILL_GRACE_MS = 1_000;
const CLI_AUTH_TIMEOUT_MS = 5_000;

interface LocalCliRunRequest {
  cmd: string[];
  stdin: string;
  timeoutMs: number;
}

export type LocalCliRun = (
  request: LocalCliRunRequest,
) => Promise<LocalCliRunResult>;

export async function checkLocalCliAuthentication(
  command: 'codex' | 'claude',
  executable: string,
  run: LocalCliRun = runLocalCli,
): Promise<void> {
  const result = await run({
    cmd:
      command === 'codex'
        ? [executable, 'login', 'status']
        : [executable, 'auth', 'status', '--json'],
    stdin: '',
    timeoutMs: CLI_AUTH_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command} CLI login is required`);
  }
  if (command === 'claude') {
    const status = parseLocalCliJson(
      result.stdout,
      'Claude CLI returned invalid login status',
    );
    if (!isRecord(status) || status.loggedIn !== true) {
      throw new Error('Claude CLI login is required');
    }
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (stream === null) {
    return '';
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- stream chunks must be read in order.
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      throw new Error('Local CLI output was too large');
    }
    text += decoder.decode(value, { stream: true });
  }
}

export async function runLocalCli(
  request: LocalCliRunRequest,
): Promise<LocalCliRunResult> {
  const child = Bun.spawn({
    cmd: request.cmd,
    cwd: tmpdir(),
    env: childEnvironment(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeoutState: {
    timedOut: boolean;
    forceKill: ReturnType<typeof setTimeout> | null;
  } = { timedOut: false, forceKill: null };
  const timeout = setTimeout(() => {
    timeoutState.timedOut = true;
    child.kill('SIGTERM');
    timeoutState.forceKill = setTimeout(() => {
      child.kill('SIGKILL');
    }, CLI_KILL_GRACE_MS);
  }, request.timeoutMs);
  try {
    const stdoutPromise = readBoundedStream(child.stdout, MAX_CLI_OUTPUT_BYTES);
    const stderrPromise = readBoundedStream(child.stderr, MAX_CLI_ERROR_BYTES);
    async function writeInput(): Promise<void> {
      await child.stdin.write(request.stdin);
      await child.stdin.end();
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      stdoutPromise,
      stderrPromise,
      writeInput(),
    ]);
    if (timeoutState.timedOut) {
      throw createLanguageModelApiError('Local CLI request timed out', {
        availability: true,
        kind: 'timeout',
      });
    }
    return { exitCode, stdout, stderr };
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
    if (timeoutState.forceKill !== null) {
      clearTimeout(timeoutState.forceKill);
    }
  }
}

export function createCodexCliProvider(options: {
  executable: string;
  run?: LocalCliRun;
  onFallback?: (from: string, to: string) => void;
}): LanguageModelProvider {
  const run = options.run ?? runLocalCli;
  const models = [
    { name: 'gpt-6-luna', label: 'GPT-6 Luna', limits: LOCAL_CLI_LIMITS },
    { name: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', limits: LOCAL_CLI_LIMITS },
    { name: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', limits: LOCAL_CLI_LIMITS },
  ];
  async function generateWithModel(
    params: Parameters<LanguageModelProvider['service']['generate']>[0],
    modelName: string,
    timeoutMs: number,
  ): Promise<LanguageModelResponse> {
    const result = await run({
      cmd: [
        options.executable,
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
        modelName,
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
      ],
      stdin: redactSensitiveTextForPrompt(
        `${params.systemPrompt}\n\n${params.promptContext}`,
      ),
      timeoutMs,
    });
    if (result.exitCode !== 0) {
      cliFailure('Codex CLI', result);
    }
    const response = parseCodexOutput(result.stdout);
    return {
      ...response,
      text: sanitizeTerminalText(response.text),
      truncated: (response.usage.outputTokens ?? 0) >= params.maxOutputTokens,
    };
  }
  return {
    id: 'codex-cli',
    label: 'Codex CLI',
    defaultModel: 'gpt-6-luna',
    models: async function (): Promise<typeof models> {
      return await Promise.resolve(models);
    },
    service: {
      generate: async function (params) {
        if (!models.some((model) => model.name === params.modelName)) {
          throw new Error('Unknown Codex CLI model');
        }
        const deadline = Date.now() + CLI_TIMEOUT_MS;
        try {
          return await generateWithModel(
            params,
            params.modelName,
            CLI_TIMEOUT_MS,
          );
        } catch (error) {
          if (
            params.modelName !== 'gpt-6-luna' ||
            !isModelUnavailableError(error)
          ) {
            throw error;
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw error;
          }
          options.onFallback?.('gpt-6-luna', 'gpt-6.1-sol');
          return await generateWithModel(params, 'gpt-6.1-sol', remainingMs);
        }
      },
    },
  };
}

export function createClaudeCliProvider(options: {
  executable: string;
  run?: LocalCliRun;
  onFallback?: (from: string, to: string) => void;
}): LanguageModelProvider {
  const run = options.run ?? runLocalCli;
  const models = [
    { name: 'haiku', label: 'Claude Haiku', limits: LOCAL_CLI_LIMITS },
    { name: 'sonnet', label: 'Claude Sonnet', limits: LOCAL_CLI_LIMITS },
    { name: 'opus', label: 'Claude Opus', limits: LOCAL_CLI_LIMITS },
    { name: 'fable', label: 'Claude Fable', limits: LOCAL_CLI_LIMITS },
  ];
  return {
    id: 'claude-cli',
    label: 'Claude CLI',
    defaultModel: 'haiku',
    models: async function (): Promise<typeof models> {
      return await Promise.resolve(models);
    },
    service: {
      generate: async function (params) {
        if (!models.some((model) => model.name === params.modelName)) {
          throw new Error('Unknown Claude CLI model');
        }
        const deadline = Date.now() + CLI_TIMEOUT_MS;
        async function generateWithModel(
          modelName: string,
          timeoutMs: number,
        ): Promise<LanguageModelResponse> {
          const result = await run({
            cmd: [
              options.executable,
              '--print',
              '--model',
              modelName,
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
              redactSensitiveTextForPrompt(params.systemPrompt),
            ],
            stdin: redactSensitiveTextForPrompt(params.promptContext),
            timeoutMs,
          });
          if (result.exitCode !== 0) {
            cliFailure('Claude CLI', result);
          }
          const response = parseClaudeOutput(result.stdout);
          return {
            ...response,
            text: sanitizeTerminalText(response.text),
            truncated:
              (response.usage.outputTokens ?? 0) >= params.maxOutputTokens,
          };
        }
        try {
          return await generateWithModel(params.modelName, CLI_TIMEOUT_MS);
        } catch (error) {
          if (params.modelName !== 'haiku' || !isModelUnavailableError(error)) {
            throw error;
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw error;
          }
          options.onFallback?.('haiku', 'sonnet');
          return await generateWithModel('sonnet', remainingMs);
        }
      },
    },
  };
}
