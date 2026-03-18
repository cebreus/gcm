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
 * Converts a glob pattern to a regex
 * Supports simple wildcards: * matches anything, ? matches single char
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
    .replace(/\*/g, '.*') // * -> .*
    .replace(/\?/g, '.'); // ? -> .
  return new RegExp(`^${escaped}$`);
}

/**
 * Checks if a file path matches any of the exclude patterns
 */
export function shouldExcludeFile(filePath: string, excludePatterns: string[]): boolean {
  if (!excludePatterns || excludePatterns.length === 0) {
    return false;
  }

  return excludePatterns.some(pattern => {
    const regex = globToRegex(pattern);
    return regex.test(filePath);
  });
}

/**
 * Filters files based on exclude patterns
 */
export function filterExcludedFiles(files: string[], excludePatterns: string[]): string[] {
  if (!excludePatterns || excludePatterns.length === 0) {
    return files;
  }

  return files.filter(file => !shouldExcludeFile(file, excludePatterns));
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

export function unescapeNewlinesInText(obj: unknown, maxDepth = 20): unknown {
  function recurse(current: unknown, depth: number): unknown {
    if (depth >= maxDepth) {
      return '[REDACTED-MAX-DEPTH]';
    }
    if (typeof current === 'string') {
      return current;
    }
    if (Array.isArray(current)) {
      return current.map(item => recurse(item, depth + 1));
    }
    if (typeof current === 'object' && current !== null) {
      const newObj: Record<string, unknown> = {};
      for (const key in current as Record<string, unknown>) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          const val = (current as Record<string, unknown>)[key];
          if (key === 'text' && typeof val === 'string') {
            newObj[key] = val.replace(/\\n/g, '\n');
          } else {
            newObj[key] = recurse(val, depth + 1);
          }
        }
      }
      return newObj;
    }
    return current;
  }
  return recurse(obj, 0);
}

/**
 * Sanitizes text for display or clipboard operations by removing non-printable
 * ASCII characters and internal control markers.
 */
export function sanitizeForDisplay(text: string): string {
  if (!text || typeof text !== 'string') return text;

  // Remove internal control markers (with or without backtick prefix)
  let cleaned = text
    .replace(/`<<START>>/g, '')
    .replace(/`<<END>>/g, '')
    .replace(/`<<END_TRUNCATED>>/g, '')
    .replace(/\.<<START>>/g, '')
    .replace(/\.<<END>>/g, '')
    .replace(/\.<<END_TRUNCATED>>/g, '')
    .replace(/<<START>>/g, '')
    .replace(/<<END>>/g, '')
    .replace(/<<END_TRUNCATED>>/g, '');

  // Allow printable ASCII, tabs, newlines, carriage returns. Remove others.
  return cleaned.replace(/[^\x20-\x7E\t\n\r]/g, '');
}

/**
 * Formats a commit message to enforce line length constraints:
 * - First line (subject): max 60 characters
 * - Body lines: max 80 characters
 *
 * Preserves:
 * - Bullet points with dashes ("- ")
 * - Backticks and code formatting
 * - Empty lines
 * - Line breaks
 */
export function formatCommitMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return message;
  }

  const lines = message.split('\n');
  if (lines.length === 0) {
    return message;
  }

  // Format first line: max 60 chars
  const firstLine = wrapLine(lines[0], 60);

  // Format remaining lines: max 80 chars, preserve structure
  const bodyLines = lines.slice(1).map(line => {
    if (line.trim().length === 0) {
      return ''; // Preserve empty lines
    }
    return wrapLine(line, 80);
  });

  return [firstLine, ...bodyLines].join('\n');
}

/**
 * Wraps a single line to maxLen, respecting word boundaries and preserving bullets
 */
function wrapLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) {
    return line;
  }

  // Detect bullet point prefix ("- " or "-\t" etc)
  const bulletMatch = line.match(/^(\s*[-*+]\s+)/);
  const bulletPrefix = bulletMatch ? bulletMatch[1] : '';
  const bulletIndent = bulletPrefix.length;

  // Content after bullet
  const content = bulletPrefix ? line.slice(bulletPrefix.length) : line;

  // Split on whitespace while preserving backtick-enclosed spans
  const words = smartSplit(content);

  const wrappedLines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;

    if (testLine.length + bulletIndent <= maxLen) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        wrappedLines.push(currentLine);
      }
      currentLine = word;
    }
  }

  if (currentLine) {
    wrappedLines.push(currentLine);
  }

  // Rejoin with bullet prefix on first line, indent on continuations
  return wrappedLines
    .map((line, i) => (i === 0 ? bulletPrefix + line : bulletPrefix + line))
    .join('\n');
}

/**
 * Splits text on whitespace but preserves content within backticks as single tokens
 */
function smartSplit(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inBackticks = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '`') {
      inBackticks = !inBackticks;
      current += char;
    } else if (/\s/.test(char) && !inBackticks) {
      // Whitespace outside backticks = token boundary
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

// Remove the old custom implementation functions
// wrapLine, splitPreservingMarkdown...

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
