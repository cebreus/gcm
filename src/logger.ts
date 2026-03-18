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

const DEFAULT_LEVEL = 'info';

export const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let globalExitHandlersInstalled = false;

export function createLogger(config?: LoggerConfig): Logger {
  const LOG_LEVEL = config?.LOG_LEVEL || DEFAULT_LEVEL;
  const TELEMETRY_FILE = config?.TELEMETRY_FILE || '';
  const flushIntervalMs = config?.LOG_FLUSH_INTERVAL_MS || 1000;
  const maxQueueBytes = config?.LOG_FLUSH_MAX_BYTES || 64 * 1024; // 64 KiB
  const queue: string[] = [];
  let queueBytes = 0;
  let timer: NodeJS.Timeout | null = null;

  async function flush(): Promise<void> {
    if (!TELEMETRY_FILE) {
      await Promise.resolve();
      return;
    }
    if (queue.length === 0) {
      await Promise.resolve();
      return;
    }
    const payload = queue.join('');
    queue.length = 0;
    queueBytes = 0;

    try {
      const file = Bun.file(TELEMETRY_FILE);
      const writer = file.writer();
      writer.write(payload);
      await writer.end();
    } catch (err) {
      try {
        console.error('Failed to write telemetry:', String(err));
      } catch {
        /* ignore */
      }
    }
  }

  function flushSync(): void {
    if (!TELEMETRY_FILE) return;
    if (queue.length === 0) return;
    const payload = queue.join('');
    queue.length = 0;
    queueBytes = 0;
    try {
      Bun.spawnSync({
        cmd: ['bash', '-c', `cat >> "${TELEMETRY_FILE}"`],
        stdin: new TextEncoder().encode(payload),
      });
    } catch (err) {
      try {
        console.error('Failed to write telemetry sync:', String(err));
      } catch {
        /* ignore */
      }
    }
  }

  function sanitizeTextForLogs(text: string, maxLen = 256): string {
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

  function redact(obj: unknown): unknown {
    if (typeof obj === 'string') {
      return obj.replace(/(key|token|pass|secret)=[^&\s]+/gi, '$1=[REDACTED]');
    }
    if (typeof obj === 'object' && obj !== null) {
      const newObj: LogMetadata = {};
      const objRecord = obj as LogMetadata;
      for (const key in objRecord) {
        if (Object.prototype.hasOwnProperty.call(objRecord, key)) {
          if (/key|token|pass|secret/i.test(key)) {
            newObj[key] = '[REDACTED]';
          } else {
            newObj[key] = redact(objRecord[key]);
          }
        }
      }
      return newObj;
    }
    return obj;
  }

  function sanitizeMetaForTelemetry(meta: LogMetadata): LogMetadata {
    const out: LogMetadata = {};
    for (const k of Object.keys(meta)) {
      const v = meta[k];
      if (typeof v === 'string') out[k] = sanitizeTextForLogs(v);
      else out[k] = redact(v);
    }
    return out;
  }

  function ensureExitHandlers(): void {
    if (globalExitHandlersInstalled) return;
    globalExitHandlersInstalled = true;
    process.on('beforeExit', function () {
      flushSync();
    });
    process.on('SIGINT', function () {
      try {
        flushSync();
      } finally {
        process.exit(130);
      }
    });
    process.on('SIGTERM', function () {
      try {
        flushSync();
      } finally {
        process.exit(143);
      }
    });
  }

  function scheduleFlush(): void {
    if (!TELEMETRY_FILE) return;
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;

      flush().catch(function () {});
    }, flushIntervalMs);
  }

  function log(level: LogLevel, message: string, meta?: LogMetadata): void {
    const metaLocal = meta || {};
    const current = levels[LOG_LEVEL as LogLevel] ?? levels.info;
    if ((levels[level] ?? levels.info) < current) return;
    const ts = new Date().toISOString();
    const out = '[' + ts + '] ' + level.toUpperCase() + ': ' + message;
    if (level === 'error') {
      if (meta) console.error(out, metaLocal);
      else console.error(out);
    } else {
      if (meta) console.log(out, meta);
      else console.log(out);
    }
    if (TELEMETRY_FILE && (level === 'info' || level === 'error')) {
      ensureExitHandlers();
      const sanitizedMeta = sanitizeMetaForTelemetry(metaLocal);
      const line = JSON.stringify({ ts, level, msg: message, meta: sanitizedMeta }) + '\n';
      const bytes = Buffer.byteLength(line, 'utf8');
      queue.push(line);
      queueBytes += bytes;
      if (queueBytes >= maxQueueBytes) {
        flush();
      } else {
        scheduleFlush();
      }
    }
  }

  return { log, flush, flushSync };
}
