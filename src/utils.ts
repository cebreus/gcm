const encoder = new TextEncoder();
const decoder = new TextDecoder();
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_PREFIX = 0x80;
const MIN_SECRET_LENGTH = 8;

export function estimateTokenCount(
  text: string,
  tokenBytesRatio: number,
): number {
  return Math.ceil(encoder.encode(text).length / tokenBytesRatio);
}

/** Strict-boolean replacement for a truthy string check. */
export function hasText(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== '';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (
    end > 0 &&
    (bytes[end] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_PREFIX
  ) {
    end -= 1;
  }
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
  return text.replace(
    /(?<authorization>\bAuthorization\s*:\s*[!#$%\u0026'*+.^_`\|~\w\-]+\s+)[^\s,;]+/giv,
    '$<authorization>[REDACTED]',
  );
}

export function redactSensitiveText(text: string): string {
  return redactAuthorizationCredentials(text)
    .replace(
      /(?:ey[A-Za-z0-9\u002D_=]+)\.(?:ey[A-Za-z0-9\u002D_=]+)\.(?:[A-Za-z0-9\u002D_.+\u002F=]*)/gv,
      '[REDACTED-JWT]',
    )
    .replace(
      /\b(?:AKIA|AIza|ghp_|xoxb-|sk-)[A-Za-z0-9_\u002D]{8,}\b|\bgithub_pat_[A-Za-z0-9_]{8,}\b|\bAQ\.[A-Za-z0-9_\u002D]{8,}\b/gv,
      '[REDACTED-KEY]',
    )
    .replace(
      /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/gv,
      '[REDACTED-PEM]',
    );
}

function hasSecretEntropy(value: string): boolean {
  return new Set(value).size >= MIN_SECRET_LENGTH;
}

function isSecretLiteral(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH && hasSecretEntropy(value);
}

function redactEqualsSecret(match: string): string {
  const equalsIndex = match.indexOf('=');
  const head = match.slice(0, equalsIndex + '='.length);
  const rawValue = match.slice(equalsIndex + '='.length);
  const quote =
    rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue[0] : '';
  const value =
    quote === '' ? rawValue : rawValue.slice(quote.length, -quote.length);
  return isSecretLiteral(value) && !/^[$<]/v.test(value)
    ? `${head}${quote}[REDACTED]${quote}`
    : match;
}

export function redactSensitiveTextForPrompt(text: string): string {
  return (
    redactAuthorizationCredentials(text)
      .replace(
        /\beyJ[A-Za-z0-9_\u002D]{10,}\.eyJ[A-Za-z0-9_\u002D]{10,}\.[A-Za-z0-9_.+\u002F=]{16,}\b/gv,
        '[REDACTED-JWT]',
      )
      .replace(
        /\b(?:AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_\u002D]{31,}|gh[opusr]_[A-Za-z0-9]{36}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_\u002D]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{60,}|sk-(?:proj-)?[A-Za-z0-9_\u002D]{32,}|AQ\.[A-Za-z0-9_\u002D]{24,}|xox[abprs]-[A-Za-z0-9\u002D]{20,}|ya29\.[A-Za-z0-9_\u002D]{20,})\b/gv,
        (value: string): string =>
          hasSecretEntropy(value) ? '[REDACTED-KEY]' : value,
      )
      .replace(
        /\b(?<bearer>Bearer[ \t]+)(?=[\w.~+\u002F=\u002D]*\d)[\w.~+\u002F=\u002D]{16,}/gv,
        '$<bearer>[REDACTED]',
      )
      .replace(
        /\b(?<credentials>[A-Za-z][A-Za-z0-9+.\u002D]{0,31}:\/\/[^\s:\u002F@]*:)[^\s\u002F@]+@/gv,
        '$<credentials>[REDACTED]@',
      )
      .replace(
        /^(?<head>[+ \u002D]?[ \t]*(?:export[ \t]+)?[A-Z0-9_.\u002D]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_.\u002D]*=)(?:(?<quote>["'])(?<quoted>[^"'\n]*)\k<quote>|(?<bare>[^\s"']+))/gimv,
        redactEqualsSecret,
      )
      .replace(
        // Unquoted `key: value` / `key = value`; the digit requirement spares code references.
        /^(?<head>[+ \u002D]?[ \t]*(?:export[ \t]+)?(?:[A-Z0-9_.\u002D]*[_.\u002D])?(?:SECRET|PASSWORD|PASSWD|PASS|PWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)(?:[_.\u002D][A-Za-z0-9_.\u002D]*)?[ \t]*[:=][ \t]*)(?<value>[^\s"',;]+)/gimv,
        (match: string, head: string, value: string): string =>
          isSecretLiteral(value) &&
          /\d/v.test(value) &&
          !/^(?:[$<\u002F~]|\.\/|process\.env|os\.environ|env\.)|[\(\[\{]/v.test(
            value,
          )
            ? `${head}[REDACTED]`
            : match,
      )
      .replace(
        /(?<head>(?:secret|password|passwd|token|api_?key|access_?key|private_?key)[A-Za-z0-9_.\u002D]*["']?\s*[:=]\s*)(?<quote>["'])(?<value>[^"'\s]+)\k<quote>/giv,
        (match: string, head: string, quote: string, value: string): string =>
          isSecretLiteral(value) ? `${head}${quote}[REDACTED]${quote}` : match,
      )
      .replace(
        /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/gv,
        '[REDACTED-PEM]',
      )
      // Unterminated block: take only following key-like lines (capped), never the rest of the text.
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\r?\n[+ \u002D]?(?:[A-Za-z0-9+\u002F=]{1,100}|[A-Za-z\u002D]{1,20}: ?[A-Za-z0-9,.+\u002F=\u002D]{1,100})(?=\r?$)){0,40}/gmv,
        '[REDACTED-PEM]',
      )
  );
}

export function sanitizeTerminalText(text: string): string {
  return redactSensitiveText(stripTerminalControlSequences(text));
}

export function stripTerminalControlSequences(text: string): string {
  return (
    text
      .replace(
        // eslint-disable-next-line no-control-regex -- terminal sanitising must match control bytes
        /(?:\x1B(?:\][\s\S]*?(?:\x07|\x1B\\)|[PX^_][\s\S]*?\x1B\\|\[[0-?]*[ -\/]*[@-~]|[\(\)][0-?]*[ -\/]*[@-~]|[0-?]*[ -\/]*[@-~])|\x9D[\s\S]*?(?:\x07|\x9C)|\x9B[0-?]*[ -\/]*[@-~]|\x90[\s\S]*?\x9C|\x9E[\s\S]*?\x9C|\x9F[\s\S]*?\x9C)/gv,
        '',
      )
      // eslint-disable-next-line no-control-regex -- terminal sanitising must match control bytes
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/gv, '')
  );
}

function globToRegex(pattern: string): RegExp {
  const regexSpecialCharacters = '.+^${}()|[]\\';
  let escaped = '';
  for (const character of pattern) {
    escaped += regexSpecialCharacters.includes(character)
      ? `\\${character}`
      : character;
  }
  escaped = escaped.replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'v');
}

export function shouldExcludeFile(
  filePath: string,
  excludePatterns: string[],
): boolean {
  return excludePatterns.some((pattern) => globToRegex(pattern).test(filePath));
}

export function pushHunkToTop(
  array: Hunk[],
  hunk: Hunk,
  maxSize: number,
): void {
  if (!Number.isFinite(maxSize) || maxSize <= 0) {
    return;
  }
  if (array.length < maxSize) {
    array.push(hunk);
    return;
  }
  let minIdx = 0;
  for (let i = 1; i < array.length; i += 1) {
    if (array[i].score < array[minIdx].score) {
      minIdx = i;
    }
  }
  if (hunk.score > array[minIdx].score) {
    array.splice(minIdx, 1, hunk);
  }
}

/**
 * Sanitizes text for display or clipboard operations by removing non-printable
 * ASCII characters and internal control markers.
 */
export function sanitizeForDisplay(text: string): string {
  let { length: end } = text;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
    end -= 1;
  }
  return stripTerminalControlSequences(
    text.slice(0, end).replace(/^[ \t]+/v, ''),
  );
}

export function formatCommitMessage(message: string): string {
  const trimmed = message.trim();
  const firstNewlineIndex = trimmed.indexOf('\n');
  if (firstNewlineIndex === -1) {
    return trimmed;
  }

  const subject = trimmed.substring(0, firstNewlineIndex).trim();
  const body = trimmed
    .substring(firstNewlineIndex + '\n'.length)
    .replace(/^[\r\n]+/v, '');

  if (body !== '') {
    return `${subject}\n\n${body}`;
  }

  return subject;
}
