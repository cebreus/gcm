const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function estimateTokenCount(text: string, tokenBytesRatio: number): number {
  return Math.ceil(encoder.encode(text).length / tokenBytesRatio);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
}

export interface Hunk {
  file: string;
  header: string;
  content: string;
  added: number;
  removed: number;
  score: number;
}

function redactAuthorizationCredentials(text: string): string {
  return text.replace(/(\bAuthorization\s*:\s*[!#$%&'*+.^_`|~\w-]+\s+)[^\s,;]+/gi, '$1[REDACTED]');
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
      (value: string): string => (hasSecretEntropy(value) ? '[REDACTED-KEY]' : value),
    )
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED-PEM]');
}

export function sanitizeTerminalText(text: string): string {
  return redactSensitiveText(stripTerminalControlSequences(text));
}

export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(
      /(?:\x1B(?:\][\s\S]*?(?:\x07|\x1B\\)|[PX^_][\s\S]*?\x1B\\|\[[0-?]*[ -/]*[@-~]|[()][0-?]*[ -/]*[@-~]|[0-?]*[ -/]*[@-~])|\x9D[\s\S]*?(?:\x07|\x9C)|\x9B[0-?]*[ -/]*[@-~]|\x90[\s\S]*?\x9C|\x9E[\s\S]*?\x9C|\x9F[\s\S]*?\x9C)/g,
      '',
    )
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function shouldExcludeFile(filePath: string, excludePatterns: string[]): boolean {
  return excludePatterns.some(pattern => globToRegex(pattern).test(filePath));
}

export function filterExcludedFiles(files: string[], excludePatterns: string[]): string[] {
  return files.filter(file => !shouldExcludeFile(file, excludePatterns));
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

/**
 * Sanitizes text for display or clipboard operations by removing non-printable
 * ASCII characters and internal control markers.
 */
export function sanitizeForDisplay(text: string): string {
  return stripTerminalControlSequences(text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));
}

export function formatCommitMessage(message: string): string {
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
