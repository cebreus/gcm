import { tmpdir } from 'os';
import { childEnvironment } from './git-utils.js';
import {
  createLanguageModelApiError,
  isModelUnavailableError,
  type LanguageModelProvider,
  type LanguageModelResponse,
} from './language-model-service.js';
import { isRecord, redactSensitiveTextForPrompt, sanitizeTerminalText } from './utils.js';

const CLI_TIMEOUT_MS = 90_000;
const CLI_KILL_GRACE_MS = 1_000;
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
const CLI_LIMITS = {
  kind: 'separate' as const,
  maxInputTokens: 32_000,
  maxOutputTokens: 8_192,
};

interface LocalCliRunRequest {
  cmd: string[];
  stdin: string;
  timeoutMs: number;
}

interface LocalCliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type LocalCliRun = (request: LocalCliRunRequest) => Promise<LocalCliRunResult>;

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
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0) throw new Error(`${command} CLI login is required`);
  if (command === 'claude') {
    let status: unknown;
    try {
      status = JSON.parse(result.stdout);
    } catch {
      throw new Error('Claude CLI returned invalid login status');
    }
    if (!isRecord(status) || status.loggedIn !== true)
      throw new Error('Claude CLI login is required');
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) throw new Error('Local CLI output was too large');
    text += decoder.decode(value, { stream: true });
  }
}

export async function runLocalCli(request: LocalCliRunRequest): Promise<LocalCliRunResult> {
  const child = Bun.spawn({
    cmd: request.cmd,
    cwd: tmpdir(),
    env: childEnvironment(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | null = null;
  const timeout = setTimeout(function () {
    timedOut = true;
    child.kill('SIGTERM');
    forceKill = setTimeout(function () {
      child.kill('SIGKILL');
    }, CLI_KILL_GRACE_MS);
  }, request.timeoutMs);
  try {
    const stdoutPromise = readBoundedStream(child.stdout, MAX_CLI_OUTPUT_BYTES);
    const stderrPromise = readBoundedStream(child.stderr, 64 * 1024);
    async function writeInput() {
      await child.stdin.write(request.stdin);
      await child.stdin.end();
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      stdoutPromise,
      stderrPromise,
      writeInput(),
    ]);
    if (timedOut) {
      throw createLanguageModelApiError('Local CLI request timed out', {
        availability: true,
        kind: 'timeout',
      });
    }
    return { exitCode, stdout, stderr };
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited.catch(function () {});
    throw error;
  } finally {
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
  }
}

function readUsage(value: unknown): LanguageModelResponse['usage'] {
  if (!isRecord(value)) return {};
  const promptTokens =
    Number.isSafeInteger(value.input_tokens) && Number(value.input_tokens) >= 0
      ? Number(value.input_tokens)
      : undefined;
  const outputTokens =
    Number.isSafeInteger(value.output_tokens) && Number(value.output_tokens) >= 0
      ? Number(value.output_tokens)
      : undefined;
  return { promptTokens, outputTokens };
}

function parseCodexOutput(stdout: string): LanguageModelResponse {
  let text: string | null = null;
  let completed = false;
  let usage: LanguageModelResponse['usage'] = {};
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw createLanguageModelApiError('Codex CLI returned malformed JSON');
    }
    if (!isRecord(event)) continue;
    if (event.type === 'turn.failed' || event.type === 'error') {
      cliFailure('Codex CLI', { exitCode: 1, stdout, stderr: '' });
    }
    if (
      event.type === 'item.completed' &&
      isRecord(event.item) &&
      event.item.type === 'agent_message' &&
      typeof event.item.text === 'string'
    ) {
      text = event.item.text;
    }
    if (event.type === 'turn.completed') {
      completed = true;
      usage = readUsage(event.usage);
    }
  }
  if (!text || !completed)
    throw createLanguageModelApiError('Codex CLI returned no completed message');
  return { text, usage };
}

function parseClaudeOutput(stdout: string): LanguageModelResponse {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw createLanguageModelApiError('Claude CLI returned malformed JSON');
  }
  if (isRecord(value) && value.type === 'result' && value.is_error === true) {
    cliFailure('Claude CLI', { exitCode: 1, stdout, stderr: '' });
  }
  if (
    !isRecord(value) ||
    value.type !== 'result' ||
    value.is_error === true ||
    (value.subtype !== undefined && value.subtype !== 'success') ||
    typeof value.result !== 'string' ||
    !value.result
  ) {
    throw createLanguageModelApiError('Claude CLI returned no message');
  }
  return { text: value.result, usage: readUsage(value.usage) };
}

function cliFailure(label: string, result: LocalCliRunResult): never {
  let failureText = result.stderr;
  for (const line of result.stdout.split('\n')) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === 'error' && typeof event.message === 'string')
      failureText += `\n${event.message}`;
    if (
      event.type === 'turn.failed' &&
      isRecord(event.error) &&
      typeof event.error.message === 'string'
    )
      failureText += `\n${event.error.message}`;
    if (event.type === 'result' && event.is_error === true) {
      if (Array.isArray(event.errors))
        failureText += '\n' + event.errors.filter(value => typeof value === 'string').join('\n');
      if (typeof event.result === 'string') failureText += `\n${event.result}`;
    }
  }
  const detail = sanitizeTerminalText(failureText).trim().split('\n').at(-1)?.slice(0, 256);
  const authenticationFailure = /auth|login|credential|api.?key|unauthorized|forbidden/i.test(
    failureText,
  );
  // CLI output is external text: classify it here, once, into typed metadata.
  const timedOut = /timed? out|timeout/i.test(failureText);
  throw createLanguageModelApiError(`${label} failed${detail ? `: ${detail}` : ''}`, {
    exitCode: result.exitCode,
    availability:
      !authenticationFailure &&
      (timedOut || /unavailable|overload|capacity|rate.?limit|\b429\b/i.test(failureText)),
    ...(timedOut ? { kind: 'timeout' } : {}),
  });
}

export function createCodexCliProvider(options: {
  executable: string;
  run?: LocalCliRun;
  onFallback?: (from: string, to: string) => void;
}): LanguageModelProvider {
  const run = options.run ?? runLocalCli;
  const models = [
    { name: 'gpt-6-luna', label: 'GPT-6 Luna', limits: CLI_LIMITS },
    { name: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', limits: CLI_LIMITS },
    { name: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', limits: CLI_LIMITS },
  ];
  async function generateWithModel(
    params: Parameters<LanguageModelProvider['service']['generate']>[0],
    modelName: string,
    timeoutMs: number,
  ) {
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
      stdin: redactSensitiveTextForPrompt(`${params.systemPrompt}\n\n${params.promptContext}`),
      timeoutMs,
    });
    if (result.exitCode !== 0) cliFailure('Codex CLI', result);
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
    models: async function () {
      return models;
    },
    service: {
      generate: async function (params) {
        if (!models.some(model => model.name === params.modelName)) {
          throw new Error('Unknown Codex CLI model');
        }
        const deadline = Date.now() + CLI_TIMEOUT_MS;
        try {
          return await generateWithModel(params, params.modelName, CLI_TIMEOUT_MS);
        } catch (error) {
          if (params.modelName !== 'gpt-6-luna' || !isModelUnavailableError(error)) throw error;
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw error;
          options.onFallback?.('gpt-6-luna', 'gpt-6.1-sol');
          return generateWithModel(params, 'gpt-6.1-sol', remainingMs);
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
    { name: 'haiku', label: 'Claude Haiku', limits: CLI_LIMITS },
    { name: 'sonnet', label: 'Claude Sonnet', limits: CLI_LIMITS },
    { name: 'opus', label: 'Claude Opus', limits: CLI_LIMITS },
    { name: 'fable', label: 'Claude Fable', limits: CLI_LIMITS },
  ];
  return {
    id: 'claude-cli',
    label: 'Claude CLI',
    defaultModel: 'haiku',
    models: async function () {
      return models;
    },
    service: {
      generate: async function (params) {
        if (!models.some(model => model.name === params.modelName)) {
          throw new Error('Unknown Claude CLI model');
        }
        const deadline = Date.now() + CLI_TIMEOUT_MS;
        async function generateWithModel(modelName: string, timeoutMs: number) {
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
          if (result.exitCode !== 0) cliFailure('Claude CLI', result);
          const response = parseClaudeOutput(result.stdout);
          return {
            ...response,
            text: sanitizeTerminalText(response.text),
            truncated: (response.usage.outputTokens ?? 0) >= params.maxOutputTokens,
          };
        }
        try {
          return await generateWithModel(params.modelName, CLI_TIMEOUT_MS);
        } catch (error) {
          if (params.modelName !== 'haiku' || !isModelUnavailableError(error)) throw error;
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw error;
          options.onFallback?.('haiku', 'sonnet');
          return generateWithModel('sonnet', remainingMs);
        }
      },
    },
  };
}
