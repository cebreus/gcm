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

function isSecretLiteral(value: string): boolean {
  return value.length >= 8 && hasSecretEntropy(value);
}

export function redactSensitiveTextForPrompt(text: string): string {
  return (
    redactAuthorizationCredentials(text)
      .replace(
        /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.+/=]{16,}\b/g,
        '[REDACTED-JWT]',
      )
      .replace(
        /\b(?:AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{31,}|gh[opusr]_[A-Za-z0-9]{36}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{60,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AQ\.[A-Za-z0-9_-]{24,}|xox[abprs]-[A-Za-z0-9-]{20,}|ya29\.[A-Za-z0-9_-]{20,})\b/g,
        (value: string): string => (hasSecretEntropy(value) ? '[REDACTED-KEY]' : value),
      )
      .replace(/\b(Bearer[ \t]+)(?=[\w.~+/=-]*\d)[\w.~+/=-]{16,}/g, '$1[REDACTED]')
      .replace(/\b([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s:/@]*:)[^\s/@]+@/g, '$1[REDACTED]@')
      .replace(
        /^([+ -]?[ \t]*(?:export[ \t]+)?[A-Z0-9_.-]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_.-]*=)(?:(["'])([^"'\n]*)\2|([^\s"']+))/gim,
        (match: string, head: string, quote?: string, quoted?: string, bare?: string): string => {
          const value = quoted ?? bare ?? '';
          const mark = quote ?? '';
          return isSecretLiteral(value) && !/^[$<]/.test(value)
            ? `${head}${mark}[REDACTED]${mark}`
            : match;
        },
      )
      .replace(
        // Unquoted `key: value` / `key = value`; the digit requirement spares code references.
        /^([+ -]?[ \t]*(?:export[ \t]+)?(?:[A-Z0-9_.-]*[_.-])?(?:SECRET|PASSWORD|PASSWD|PASS|PWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)(?:[_.-][A-Za-z0-9_.-]*)?[ \t]*[:=][ \t]*)([^\s"',;]+)/gim,
        (match: string, head: string, value: string): string =>
          isSecretLiteral(value) &&
          /\d/.test(value) &&
          !/^(?:[$<\/~]|\.\/|process\.env|os\.environ|env\.)|[([{]/.test(value)
            ? `${head}[REDACTED]`
            : match,
      )
      .replace(
        /((?:secret|password|passwd|token|api_?key|access_?key|private_?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["'])([^"'\s]+)\2/gi,
        (match: string, head: string, quote: string, value: string): string =>
          isSecretLiteral(value) ? `${head}${quote}[REDACTED]${quote}` : match,
      )
      .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED-PEM]')
      // Unterminated block: take only following key-like lines (capped), never the rest of the text.
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\r?\n[+ -]?(?:[A-Za-z0-9+/=]{1,100}|[A-Za-z-]{1,20}: ?[A-Za-z0-9,.+/=-]{1,100})(?=\r?$)){0,40}/gm,
        '[REDACTED-PEM]',
      )
  );
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
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end -= 1;
  return stripTerminalControlSequences(text.slice(0, end).replace(/^[ \t]+/, ''));
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
