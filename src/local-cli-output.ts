import {
  type LanguageModelResponse,
  createLanguageModelApiError,
} from './language-model-service.js';
import { parseLocalCliJson, tryParseLocalCliRecord } from './local-cli-json.js';
import { hasText, isRecord, sanitizeTerminalText } from './utils.js';

const MAX_FAILURE_DETAIL_LENGTH = 256;

export interface LocalCliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function readUsage(value: unknown): LanguageModelResponse['usage'] {
  if (!isRecord(value)) {
    return {};
  }
  const promptTokens =
    Number.isSafeInteger(value.input_tokens) && Number(value.input_tokens) >= 0
      ? Number(value.input_tokens)
      : undefined;
  const outputTokens =
    Number.isSafeInteger(value.output_tokens) &&
    Number(value.output_tokens) >= 0
      ? Number(value.output_tokens)
      : undefined;
  return { promptTokens, outputTokens };
}

interface CodexEventResult {
  text?: string;
  completed: boolean;
  usage?: LanguageModelResponse['usage'];
}

function readCodexEvent(event: unknown, stdout: string): CodexEventResult {
  if (!isRecord(event)) {
    return { completed: false };
  }
  if (event.type === 'turn.failed' || event.type === 'error') {
    cliFailure('Codex CLI', { exitCode: 1, stdout, stderr: '' });
  }
  if (
    event.type === 'item.completed' &&
    isRecord(event.item) &&
    event.item.type === 'agent_message' &&
    typeof event.item.text === 'string'
  ) {
    return { text: event.item.text, completed: false };
  }
  return event.type === 'turn.completed'
    ? { completed: true, usage: readUsage(event.usage) }
    : { completed: false };
}

export function parseCodexOutput(stdout: string): LanguageModelResponse {
  let text: string | null = null;
  let completed = false;
  let usage: LanguageModelResponse['usage'] = {};
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const result = readCodexEvent(
      parseLocalCliJson(line, 'Codex CLI returned malformed JSON'),
      stdout,
    );
    if (result.text !== undefined) {
      ({ text } = result);
    }
    if (result.completed) {
      completed = true;
      usage = result.usage ?? {};
    }
  }
  if (!hasText(text) || !completed) {
    throw createLanguageModelApiError(
      'Codex CLI returned no completed message',
    );
  }
  return { text, usage };
}

function isClaudeSuccess(value: unknown): value is Record<string, unknown> & {
  result: string;
} {
  return (
    isRecord(value) &&
    value.type === 'result' &&
    value.is_error !== true &&
    (value.subtype === undefined || value.subtype === 'success') &&
    typeof value.result === 'string' &&
    value.result !== ''
  );
}

export function parseClaudeOutput(stdout: string): LanguageModelResponse {
  const value = parseLocalCliJson(stdout, 'Claude CLI returned malformed JSON');
  if (isRecord(value) && value.type === 'result' && value.is_error === true) {
    cliFailure('Claude CLI', { exitCode: 1, stdout, stderr: '' });
  }
  if (!isClaudeSuccess(value)) {
    throw createLanguageModelApiError('Claude CLI returned no message');
  }
  return { text: value.result, usage: readUsage(value.usage) };
}

function failureDetails(event: Record<string, unknown>): string[] {
  const details: string[] = [];
  if (event.type === 'error' && typeof event.message === 'string') {
    details.push(event.message);
  }
  if (
    event.type === 'turn.failed' &&
    isRecord(event.error) &&
    typeof event.error.message === 'string'
  ) {
    details.push(event.error.message);
  }
  if (event.type === 'result' && event.is_error === true) {
    if (Array.isArray(event.errors)) {
      details.push(
        ...event.errors.filter(
          (value): value is string => typeof value === 'string',
        ),
      );
    }
    if (typeof event.result === 'string') {
      details.push(event.result);
    }
  }
  return details;
}

export function cliFailure(label: string, result: LocalCliRunResult): never {
  let { stderr: failureText } = result;
  for (const line of result.stdout.split('\n')) {
    const event = tryParseLocalCliRecord(line);
    if (event === null) {
      continue;
    }
    const details = failureDetails(event);
    if (details.length > 0) {
      failureText += `\n${details.join('\n')}`;
    }
  }
  const detail = sanitizeTerminalText(failureText)
    .trim()
    .split('\n')
    .at(-1)
    ?.slice(0, MAX_FAILURE_DETAIL_LENGTH);
  const authenticationFailure =
    /auth|login|credential|api.?key|unauthorized|forbidden/iv.test(failureText);
  // CLI output is external text: classify it here, once, into typed metadata.
  const timedOut = /timed? out|timeout/iv.test(failureText);
  throw createLanguageModelApiError(
    `${label} failed${hasText(detail) ? `: ${detail}` : ''}`,
    {
      exitCode: result.exitCode,
      availability:
        !authenticationFailure &&
        (timedOut ||
          /unavailable|overload|capacity|rate.?limit|\b429\b/iv.test(
            failureText,
          )),
      ...(timedOut ? { kind: 'timeout' } : {}),
    },
  );
}
