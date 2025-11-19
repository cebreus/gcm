import fs from 'node:fs';
const fsPromises = fs.promises;

const DEFAULT_LEVEL = 'info';

export const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let globalExitHandlersInstalled = false;

export interface LoggerConfig {
  LOG_LEVEL?: string;
  TELEMETRY_FILE?: string;
  LOG_FLUSH_INTERVAL_MS?: number;
  LOG_FLUSH_MAX_BYTES?: number;
}

export interface Logger {
  log: (level: string, msg: string, meta?: any) => void;
  flush: () => Promise<void>;
  flushSync: () => void;
}

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
    await fsPromises.appendFile(TELEMETRY_FILE, payload).catch(function (err: Error) {
      try {
        console.error('Failed to write telemetry:', String(err));
      } catch (_e) {
        /* ignore */
      }
    });
  }

  function flushSync(): void {
    if (!TELEMETRY_FILE) return;
    if (queue.length === 0) return;
    const payload = queue.join('');
    queue.length = 0;
    queueBytes = 0;
    try {
      fs.appendFileSync(TELEMETRY_FILE, payload);
    } catch (err) {
      try {
        console.error('Failed to write telemetry sync:', String(err));
      } catch (_e) {
        /* ignore */
      }
    }
  }

  // Minimal sanitization for telemetry: redact likely secrets and truncate long fields.
  function sanitizeTextForLogs(text: string, maxLen = 256): string {
    if (!text || typeof text !== 'string') return text;
    let out = text;
    // redact JWTs
    out = out.replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED-JWT]');
    // redact known API keys prefixes and similar tokens
    out = out.replace(/\b(AKIA|AIza|ghp_|xoxb-|sk-)[A-Za-z0-9\-_]{8,}\b/g, '[REDACTED-KEY]');
    // redact PEM blocks
    out = out.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED-PEM]');
    // truncate long strings
    if (out.length > maxLen) return out.substring(0, maxLen) + '...[TRUNCATED]';
    return out;
  }

  function sanitizeMetaForTelemetry(meta: any): any {
    if (!meta || typeof meta !== 'object') return meta;
    const out: any = {};
    for (const k of Object.keys(meta)) {
      const v = meta[k];
      // redact fields that look like tokens/keys
      if (/key|token|secret|password/i.test(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      if (typeof v === 'string') out[k] = sanitizeTextForLogs(v);
      else out[k] = v;
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
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      flush().catch(function () {});
    }, flushIntervalMs);
  }

  function log(level: string, msg: string, meta?: any): void {
    const metaLocal = meta || {};
    const current = levels[LOG_LEVEL] ?? levels.info;
    if ((levels[level] ?? levels.info) < current) return;
    const ts = new Date().toISOString();
    const out = '[' + ts + '] ' + level.toUpperCase() + ': ' + msg;
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
      const line = JSON.stringify({ ts, level, msg, meta: sanitizedMeta }) + '\n';
      const bytes = Buffer.byteLength(line, 'utf8');
      queue.push(line);
      queueBytes += bytes;
      if (queueBytes >= maxQueueBytes) {
        // immediate flush
        flush();
      } else {
        scheduleFlush();
      }
    }
  }

  return { log, flush, flushSync };
}
