import { redactSensitiveText, stripTerminalControlSequences } from './utils.js';
import { stringOrDefault } from './config-values.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  LOG_LEVEL?: string;
}

export type LogMetadata = Record<string, unknown>;

export interface Logger {
  log: (level: LogLevel, message: string, meta?: LogMetadata) => void;
}

const DEFAULT_LEVEL = 'info';

const SENSITIVE_KEY_PATTERN = /key|token|pass|secret/i;
const TOKEN_COUNT_KEYS = new Set(['promptTokens', 'outputTokens']);

const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function sanitiseTextForLogs(text: string, maxLen = 256): string {
  const out = stripTerminalControlSequences(
    redactSensitiveText(text).replace(/(key|token|pass|secret)=[^&\s]+/gi, '$1=[REDACTED]'),
  );
  if (out.length > maxLen) return out.substring(0, maxLen) + '...[TRUNCATED]';
  return out;
}

function redactForLogs(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return sanitiseTextForLogs(value);
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => redactForLogs(item, seen));
  }
  if (typeof value === 'object' && value !== null) {
    const output: LogMetadata = {};
    const record = value as LogMetadata;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = '[REDACTED]';
        continue;
      }
      try {
        output[key] = redactForLogs(record[key], seen);
      } catch {
        output[key] = '[Unserializable]';
      }
    }
    return output;
  }
  return value;
}

function sanitiseMetaForLogs(meta: LogMetadata): LogMetadata {
  const out: LogMetadata = {};
  for (const key of Object.keys(meta)) {
    // Usage counts, not credentials; any other key or value type stays redacted.
    const isTokenCount = TOKEN_COUNT_KEYS.has(key) && typeof meta[key] === 'number';
    out[key] =
      SENSITIVE_KEY_PATTERN.test(key) && !isTokenCount
        ? '[REDACTED-KEY]'
        : redactForLogs(meta[key]);
  }
  return out;
}

function formatLogLine(ts: string, level: LogLevel, message: string): string {
  return '[' + ts + '] ' + level.toUpperCase() + ': ' + message;
}

function formatLogMeta(meta: LogMetadata | undefined): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  return ' ' + JSON.stringify(meta);
}

export function createLogger(config?: LoggerConfig): Logger {
  const threshold =
    levels[stringOrDefault(config?.LOG_LEVEL, DEFAULT_LEVEL) as LogLevel] ?? levels.info;
  return {
    log(level, message, meta) {
      if (levels[level] < threshold) return;
      const formatted = formatLogLine(
        new Date().toISOString(),
        level,
        sanitiseTextForLogs(message, Infinity),
      );
      process.stderr.write(formatted + formatLogMeta(sanitiseMetaForLogs(meta ?? {})) + '\n');
    },
  };
}
