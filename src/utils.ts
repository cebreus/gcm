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
  score: number;
}

function redactAuthorizationCredentials(text: string): string {
  return text.replace(
    /(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi,
    '$1[REDACTED]',
  );
}

export function redactSensitiveText(text: string): string {
  return redactAuthorizationCredentials(text)
    .replace(/(ey[A-Za-z0-9-_=]+)\.(ey[A-Za-z0-9-_=]+)\.([A-Za-z0-9-_.+/=]*)/g, '[REDACTED-JWT]')
    .replace(
      /\b(?:AKIA|AIza|ghp_|xoxb-|sk-)[A-Za-z0-9\-_]{8,}\b|\bgithub_pat_[A-Za-z0-9_]{8,}\b|\bAQ\.[A-Za-z0-9\-_]{8,}\b/g,
      '[REDACTED-KEY]',
    )
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED-PEM]');
}

function hasSecretEntropy(value: string): boolean {
  return new Set(value).size >= 8;
}

export function redactSensitiveTextForPrompt(text: string): string {
  return redactAuthorizationCredentials(text)
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.+/=]{16,}\b/g,
      '[REDACTED-JWT]',
    )
    .replace(
      /\b(?:AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{31,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AQ\.[A-Za-z0-9_-]{24,}|xoxb-[0-9]{6,}-[0-9]{6,}-[A-Za-z0-9-]{24,})\b/g,
      function (value: string): string {
        return hasSecretEntropy(value) ? '[REDACTED-KEY]' : value;
      },
    )
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED-PEM]');
}

export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(
      /(?:\x1B(?:\][\s\S]*?(?:\x07|\x1B\\)|[PX^_][\s\S]*?\x1B\\|\[[0-?]*[ -/]*[@-~]|[()][0-?]*[ -/]*[@-~]|[0-?]*[ -/]*[@-~])|\x9D[\s\S]*?(?:\x07|\x9C)|\x9B[0-?]*[ -/]*[@-~]|\x90[\s\S]*?\x9C|\x9E[\s\S]*?\x9C|\x9F[\s\S]*?\x9C)/g,
      '',
    )
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
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

export function pushHunkToTop(array: Hunk[], hunk: Hunk, maxSize: number): void {
  if (!Number.isFinite(maxSize) || maxSize <= 0) return;
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
  return recurseUnescapeNewlines(obj, 0, maxDepth);
}

function recurseUnescapeNewlines(current: unknown, depth: number, maxDepth: number): unknown {
  if (depth >= maxDepth) {
    return '[REDACTED-MAX-DEPTH]';
  }
  if (typeof current === 'string') {
    return current;
  }
  if (Array.isArray(current)) {
    return current.map(item => recurseUnescapeNewlines(item, depth + 1, maxDepth));
  }
  if (typeof current === 'object' && current !== null) {
    const newObj: Record<string, unknown> = {};
    for (const key in current as Record<string, unknown>) {
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        const val = (current as Record<string, unknown>)[key];
        if (key === 'text' && typeof val === 'string') {
          newObj[key] = val.replace(/\\n/g, '\n');
        } else {
          newObj[key] = recurseUnescapeNewlines(val, depth + 1, maxDepth);
        }
      }
    }
    return newObj;
  }
  return current;
}

/**
 * Sanitizes text for display or clipboard operations by removing non-printable
 * ASCII characters and internal control markers.
 */
export function sanitizeForDisplay(text: string): string {
  if (!text || typeof text !== 'string') return text;

  // Remove protocol markers, but preserve likely natural-language mentions like
  // "what <<END>> marker means".
  let cleaned = text.replace(
    /`?\.?<<(START|END|END_TRUNCATED)>>`?/g,
    function (match: string, _marker: string, offset: number, fullText: string): string {
      const prevChar = offset > 0 ? fullText[offset - 1] : '';
      const nextIndex = offset + match.length;
      const nextChar = nextIndex < fullText.length ? fullText[nextIndex] : '';
      const tail = fullText.slice(nextIndex);
      const looksLikeNarrativeMention =
        /\s/.test(prevChar) && /\s/.test(nextChar) && /^\s+[a-z]/i.test(tail);
      return looksLikeNarrativeMention ? match : '';
    },
  );
  cleaned = cleaned.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

  // Allow printable ASCII and all UTF-8 characters. Remove non-printable control characters (0-31) except tab, newline, CR.
  return stripTerminalControlSequences(cleaned);
}

/**
 * Cleans up a generated commit message by trimming it.
 * (Hard-wrapping has been removed to prevent broken markdown/bullet points)
 */
export function formatCommitMessage(message: string): string {
  if (!message || typeof message !== 'string') {
    return message;
  }

  const trimmed = message.trim();
  const firstNewlineIndex = trimmed.indexOf('\n');
  if (firstNewlineIndex === -1) {
    return trimmed;
  }

  const subject = trimmed.substring(0, firstNewlineIndex).trim();
  const body = trimmed.substring(firstNewlineIndex + 1).replace(/^[\r\n]+/, '');

  if (body) {
    return `${subject}\n\n${body}`;
  }

  return subject;
}
