import type { Logger } from './logger.js';
import {
  CODE_EXTENSIONS,
  MARKUP_EXTENSIONS,
  STYLE_EXTENSIONS,
  BINARY_EXTENSIONS,
  FILE_IMPORTANCE_WEIGHTS,
} from './constants.js';

export interface Hunk {
  file: string;
  header: string;
  content: string;
  added: number;
  removed: number;
  bytes: number;
  score: number;
}

/**
 * Determines file importance weight for prioritizing hunks
 */
export function fileImportanceWeight(file: string): number {
  if (!file) return 0;
  const lower = file.toLowerCase();

  if (CODE_EXTENSIONS.some(ext => lower.endsWith(`.${ext}`))) {
    return FILE_IMPORTANCE_WEIGHTS.CODE;
  }
  if (MARKUP_EXTENSIONS.some(ext => lower.endsWith(`.${ext}`))) {
    return FILE_IMPORTANCE_WEIGHTS.MARKUP;
  }
  if (STYLE_EXTENSIONS.some(ext => lower.endsWith(`.${ext}`))) {
    return FILE_IMPORTANCE_WEIGHTS.STYLE;
  }
  if (BINARY_EXTENSIONS.some(ext => new RegExp(`\\.(${ext})$`).test(lower))) {
    return FILE_IMPORTANCE_WEIGHTS.BINARY;
  }
  return FILE_IMPORTANCE_WEIGHTS.DEFAULT;
}

/**
 * Logs a message using logger if available, otherwise writes to stdout
 */
export function logOrWrite(
  logger: Logger | null | undefined,
  level: 'info' | 'warn' | 'error',
  message: string,
): void {
  if (logger) {
    logger.log(level, message);
  } else {
    process.stdout.write(message + '\n');
  }
}

/**
 * Safely logs an error to console.error, catching any failures
 */
export function safeLogError(message: string, error?: unknown): void {
  try {
    if (error) {
      console.error(message, error);
    } else {
      console.error(message);
    }
  } catch {
    // Ignore logging errors
  }
}

/**
 * Builds a truncation note message based on truncation flags
 */
export function buildTruncationNote(
  wasBufferTruncated: boolean,
  wasPromptTruncated: boolean,
): string {
  if (wasBufferTruncated && wasPromptTruncated) {
    return '\n\nNote: Original diff was truncated by buffer limit, and prompt truncated to fit model context.';
  }
  if (wasBufferTruncated) {
    return '\n\nNote: The diff was truncated while being read due to buffer limits.';
  }
  if (wasPromptTruncated) {
    return '\n\nNote: The prompt was truncated to fit within model context limits.';
  }
  return '';
}

export function pushHunkToTop(array: Hunk[], hunk: Hunk, maxSize: number): void {
  if (array.length < maxSize) {
    array.push(hunk);
    return;
  }
  let minIdx = 0;
  for (let i = 1; i < array.length; i += 1) if (array[i].score < array[minIdx].score) minIdx = i;
  if (hunk.score > array[minIdx].score) array[minIdx] = hunk;
}

// Minimal p-limit implementation (small, dependency-free)
// Usage: const limit = pLimit(concurrency); await Promise.all(items.map(item => limit(() => doWork(item)));
// (No concurrency helper; simplified, serial processing is used in summarizer)

export function unescapeNewlinesInText(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  // Create a deep clone to avoid modifying the original object
  const clonedObj = JSON.parse(JSON.stringify(obj));

  function recurse(current: unknown) {
    if (typeof current === 'object' && current !== null) {
      for (const key in current as Record<string, unknown>) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          const val = (current as Record<string, unknown>)[key];
          if (key === 'text' && typeof val === 'string') {
            (current as Record<string, unknown>)[key] = val.replace(/\\n/g, '\n');
          } else {
            recurse(val);
          }
        }
      }
    }
  }

  recurse(clonedObj);
  return clonedObj;
}

/**
 * Detects the repository type based on common monorepo indicators.
 */
export async function detectRepoType(): Promise<'monorepo' | 'single'> {
  const [hasLerna, hasPnpmWorkspace, hasPackagesDir, hasAppsDir] = await Promise.all([
    Bun.file('lerna.json').exists(),
    Bun.file('pnpm-workspace.yaml').exists(),
    Bun.file('packages').exists(),
    Bun.file('apps').exists(),
  ]);

  if (hasLerna || hasPnpmWorkspace || (hasPackagesDir && hasAppsDir)) {
    return 'monorepo';
  }

  return 'single';
}
