import { stringOrDefault } from './config-values.js';
import { redactSensitiveText, stripTerminalControlSequences } from './utils.js';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerConfig {
  LOG_LEVEL?: string;
}

export type LogMetadata = Record<string, unknown>;

export interface Logger {
  log: (level: LogLevel, message: string, meta?: LogMetadata) => void;
}

const DEFAULT_LEVEL = 'info';
const DEFAULT_MAX_LOG_TEXT_LENGTH = 256;
const SENSITIVE_KEY_PATTERN = /key|token|pass|secret/iv;
const SENSITIVE_VALUE_PATTERN = /(?<key>key|token|pass|secret)=[^&\s]+/giv;
const TOKEN_COUNT_KEYS = new Set(['promptTokens', 'outputTokens']);

function sanitiseTextForLogs(
  text: string,
  maxLen = DEFAULT_MAX_LOG_TEXT_LENGTH,
): string {
  const out = stripTerminalControlSequences(
    redactSensitiveText(text).replace(
      SENSITIVE_VALUE_PATTERN,
      '$<key>=[REDACTED]',
    ),
  );
  if (out.length > maxLen) {
    return `${out.substring(0, maxLen)}...[TRUNCATED]`;
  }
  return out;
}

function redactObjectForLogs(value: object, seen: WeakSet<object>): unknown {
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactForLogs(item, seen));
  }
  const output: LogMetadata = {};
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    try {
      output[key] = redactForLogs(Reflect.get(value, key), seen);
    } catch {
      output[key] = '[Unserializable]';
    }
  }
  return output;
}

function redactForLogs(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    return sanitiseTextForLogs(value);
  }
  if (typeof value === 'object' && value !== null) {
    return redactObjectForLogs(value, seen);
  }
  return value;
}

function sanitiseMetaForLogs(meta: LogMetadata): LogMetadata {
  const out: LogMetadata = {};
  for (const key of Object.keys(meta)) {
    // Usage counts, not credentials; any other key or value type stays redacted.
    const isTokenCount =
      TOKEN_COUNT_KEYS.has(key) && typeof meta[key] === 'number';
    out[key] =
      SENSITIVE_KEY_PATTERN.test(key) && !isTokenCount
        ? '[REDACTED-KEY]'
        : redactForLogs(meta[key]);
  }
  return out;
}

function formatLogLine(ts: string, level: LogLevel, message: string): string {
  return `[${ts}] ${level.toUpperCase()}: ${message}`;
}

function formatLogMeta(meta: LogMetadata | undefined): string {
  if (meta === undefined || Object.keys(meta).length === 0) {
    return '';
  }
  return ` ${JSON.stringify(meta)}`;
}

export function createLogger(config?: LoggerConfig): Logger {
  const configuredLevel = stringOrDefault(config?.LOG_LEVEL, DEFAULT_LEVEL);
  const configuredIndex = LOG_LEVELS.findIndex(
    (level) => level === configuredLevel,
  );
  // An unknown configured level falls back to info.
  const threshold =
    configuredIndex === -1 ? LOG_LEVELS.indexOf('info') : configuredIndex;
  return {
    log(level, message, meta) {
      if (LOG_LEVELS.indexOf(level) < threshold) {
        return;
      }
      const formatted = formatLogLine(
        new Date().toISOString(),
        level,
        sanitiseTextForLogs(message, Infinity),
      );
      process.stderr.write(
        `${formatted + formatLogMeta(sanitiseMetaForLogs(meta ?? {}))}\n`,
      );
    },
  };
}
