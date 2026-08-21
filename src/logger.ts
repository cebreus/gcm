import { appendFileSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  LOG_LEVEL?: string;
  TELEMETRY_FILE?: string;
  LOG_FLUSH_INTERVAL_MS?: number;
  LOG_FLUSH_MAX_BYTES?: number;
}

export type LogMetadata = Record<string, unknown>;

export interface Logger {
  log: (level: LogLevel, message: string, meta?: LogMetadata) => void;
  flush: () => Promise<void>;
  flushSync: () => void;
}

interface LoggerState {
  LOG_LEVEL: string;
  TELEMETRY_FILE: string;
  flushIntervalMs: number;
  maxQueueBytes: number;
  queue: string[];
  queueBytes: number;
  timer: NodeJS.Timeout | null;
}

const DEFAULT_LEVEL = 'info';

const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let globalExitHandlersInstalled = false;

function writeStdoutLine(text: string): void {
  process.stdout.write(text + '\n');
}

function writeStderrLine(text: string): void {
  process.stderr.write(text + '\n');
}

function writeErrorFallback(message: string, err: unknown): void {
  writeStderrLine(message + String(err));
}

function sanitiseTextForLogs(text: string, maxLen = 256): string {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  out = out.replace(
    /(ey[A-Za-z0-9-_=]+)\.(ey[A-Za-z0-9-_=]+)\.([A-Za-z0-9-_.+/=]*)/g,
    '[REDACTED-JWT]',
  );
  out = out.replace(/\b(AKIA|AIza|ghp_|xoxb-|sk-)[A-Za-z0-9\-_]{8,}\b/g, '[REDACTED-KEY]');
  out = out.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED-PEM]');
  if (out.length > maxLen) return out.substring(0, maxLen) + '...[TRUNCATED]';
  return out;
}

function redactForLogs(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/(key|token|pass|secret)=[^&\s]+/gi, '$1=[REDACTED]');
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
      output[key] = redactForLogs(record[key]);
    }
    return output;
  }
  return value;
}

function sanitiseMetaForTelemetry(meta: LogMetadata): LogMetadata {
  const out: LogMetadata = {};
  for (const key of Object.keys(meta)) {
    const value = meta[key];
    if (typeof value === 'string') out[key] = sanitiseTextForLogs(value);
    else out[key] = redactForLogs(value);
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

function resetQueue(state: LoggerState): string {
  const payload = state.queue.join('');
  state.queue.length = 0;
  state.queueBytes = 0;
  return payload;
}

function shouldLogLevel(state: LoggerState, level: LogLevel): boolean {
  const current = levels[state.LOG_LEVEL as LogLevel] ?? levels.info;
  return (levels[level] ?? levels.info) >= current;
}

async function flushQueue(state: LoggerState): Promise<void> {
  if (!state.TELEMETRY_FILE || state.queue.length === 0) {
    await Promise.resolve();
    return;
  }
  const payload = resetQueue(state);
  try {
    const file = Bun.file(state.TELEMETRY_FILE);
    const writer = file.writer();
    writer.write(payload);
    await writer.end();
  } catch (err) {
    writeErrorFallback('Failed to write telemetry: ', err);
  }
}

function flushQueueSync(state: LoggerState): void {
  if (!state.TELEMETRY_FILE || state.queue.length === 0) return;
  const payload = resetQueue(state);
  try {
    appendFileSync(state.TELEMETRY_FILE, payload);
  } catch (err) {
    writeErrorFallback('Failed to write telemetry sync: ', err);
  }
}

function registerExitHandlers(state: LoggerState): void {
  if (globalExitHandlersInstalled) return;
  globalExitHandlersInstalled = true;
  process.on('beforeExit', function () {
    flushQueueSync(state);
  });
  process.on('SIGINT', function () {
    try {
      flushQueueSync(state);
    } finally {
      process.exit(130);
    }
  });
  process.on('SIGTERM', function () {
    try {
      flushQueueSync(state);
    } finally {
      process.exit(143);
    }
  });
}

function scheduleFlush(state: LoggerState): void {
  if (!state.TELEMETRY_FILE || state.timer) return;
  state.timer = setTimeout(function () {
    state.timer = null;
    void flushQueue(state);
  }, state.flushIntervalMs);
}

function queueTelemetryLine(params: {
  state: LoggerState;
  ts: string;
  level: LogLevel;
  message: string;
  meta: LogMetadata;
}): void {
  const { state, ts, level, message, meta } = params;
  registerExitHandlers(state);
  const sanitisedMeta = sanitiseMetaForTelemetry(meta);
  const line = JSON.stringify({ ts, level, msg: message, meta: sanitisedMeta }) + '\n';
  state.queue.push(line);
  state.queueBytes += Buffer.byteLength(line, 'utf8');
  if (state.queueBytes >= state.maxQueueBytes) {
    void flushQueue(state);
    return;
  }
  scheduleFlush(state);
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
    const metaLocal = meta || {};
    const ts = new Date().toISOString();
    writeRuntimeLog(level, formatLogLine(ts, level, message), metaLocal);
    if (state.TELEMETRY_FILE && (level === 'info' || level === 'error')) {
      queueTelemetryLine({ state, ts, level, message, meta: metaLocal });
    }
  };
}

function createLoggerState(config?: LoggerConfig): LoggerState {
  return {
    LOG_LEVEL: config?.LOG_LEVEL || DEFAULT_LEVEL,
    TELEMETRY_FILE: config?.TELEMETRY_FILE || '',
    flushIntervalMs: config?.LOG_FLUSH_INTERVAL_MS || 1000,
    maxQueueBytes: config?.LOG_FLUSH_MAX_BYTES || 64 * 1024,
    queue: [],
    queueBytes: 0,
    timer: null,
  };
}

export function createLogger(config?: LoggerConfig): Logger {
  const state = createLoggerState(config);
  const log = createLogFunction(state);
  const flush = async function flush(): Promise<void> {
    await flushQueue(state);
  };
  const flushSync = function flushSync(): void {
    flushQueueSync(state);
  };
  return { log, flush, flushSync };
}
