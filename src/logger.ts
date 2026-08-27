import { redactSensitiveText, stripTerminalControlSequences } from './utils.js';
import { stringOrDefault } from './config-values.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  LOG_LEVEL?: string;
}

export type LogMetadata = Record<string, unknown>;

export interface Logger {
  log: (level: LogLevel, message: string, meta?: LogMetadata) => void;
}

interface LoggerState {
  LOG_LEVEL: string;
}

const DEFAULT_LEVEL = 'info';

const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function writeStdoutLine(text: string): void {
  process.stdout.write(text + '\n');
}

function writeStderrLine(text: string): void {
  process.stderr.write(text + '\n');
}

function sanitiseTextForLogs(text: string, maxLen = 256): string {
  if (!text || typeof text !== 'string') return text;
  const out = stripTerminalControlSequences(
    redactSensitiveText(text).replace(/(key|token|pass|secret)=[^&\s]+/gi, '$1=[REDACTED]'),
  );
  if (out.length > maxLen) return out.substring(0, maxLen) + '...[TRUNCATED]';
  return out;
}

function redactForLogs(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    return sanitiseTextForLogs(value);
  }
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
      if (/key|token|pass|secret/i.test(key)) {
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
    const value = meta[key];
    if (/key|token|pass|secret/i.test(key)) out[key] = '[REDACTED-KEY]';
    else if (typeof value === 'string') out[key] = sanitiseTextForLogs(value);
    else out[key] = redactForLogs(value);
  }
  return out;
}

function formatLogLine(ts: string, level: LogLevel, message: string): string {
  return '[' + ts + '] ' + level.toUpperCase() + ': ' + message;
}

function formatLogMeta(meta: LogMetadata | undefined): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  try {
    return ' ' + JSON.stringify(meta);
  } catch {
    return ' [Unserializable metadata]';
  }
}

function shouldLogLevel(state: LoggerState, level: LogLevel): boolean {
  const current = levels[state.LOG_LEVEL as LogLevel] ?? levels.info;
  return (levels[level] ?? levels.info) >= current;
}

function writeRuntimeLog(level: LogLevel, formatted: string, meta: LogMetadata): void {
  const line = formatted + formatLogMeta(meta);
  if (level === 'error') {
    writeStderrLine(line);
    return;
  }
  writeStdoutLine(line);
}

function createLogFunction(
  state: LoggerState,
): (level: LogLevel, message: string, meta?: LogMetadata) => void {
  return function log(level: LogLevel, message: string, meta?: LogMetadata): void {
    if (!shouldLogLevel(state, level)) return;
    const metaLocal = meta ?? {};
    writeRuntimeLog(
      level,
      formatLogLine(new Date().toISOString(), level, sanitiseTextForLogs(message, Infinity)),
      sanitiseMetaForLogs(metaLocal),
    );
  };
}

function createLoggerState(config?: LoggerConfig): LoggerState {
  return {
    LOG_LEVEL: stringOrDefault(config?.LOG_LEVEL, DEFAULT_LEVEL),
  };
}

export function createLogger(config?: LoggerConfig): Logger {
  const state = createLoggerState(config);
  const log = createLogFunction(state);
  return { log };
}
