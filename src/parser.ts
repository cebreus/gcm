import { formatCommitMessage, sanitizeForDisplay } from './utils.js';

const MAX_RESPONSE_SIZE = 16_777_216;

export function parseLanguageModelOutput(text: string): string {
  if (text === '') {
    throw new Error('parseLanguageModelOutput expects a string');
  }

  let sanitizedText = sanitizeForDisplay(text);
  validateRawOutput(sanitizedText);
  if (sanitizedText.length > MAX_RESPONSE_SIZE) {
    sanitizedText = sanitizedText.substring(0, MAX_RESPONSE_SIZE);
  }

  let commitMessage = formatCommitMessage(sanitizedText.trim());
  // Repeat: removing one marker can join the pieces of another ("[skip[skip ci] ci]").
  for (let previous = ''; previous !== commitMessage;) {
    previous = commitMessage;
    commitMessage = commitMessage.replace(CI_SKIP, '');
  }
  validateCommitMessage(commitMessage);
  return stripModelTrailers(commitMessage);
}

function validateRawOutput(text: string): void {
  if (
    /<\|[^>\r\n]+\|?>/iv.test(text) ||
    /<\/?(?:think|analysis|reasoning)(?:\s[^>]*)?\/?>/iv.test(text) ||
    /^\s*(?:```|~~~)/v.test(text)
  ) {
    throw new Error('LLM output contains unsupported control markup');
  }
  if (/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/v.test(text)) {
    throw new Error('LLM output contains unsupported control characters');
  }
}

function validateCommitMessage(commitMessage: string): void {
  if (commitMessage === '') {
    throw new Error('LLM output is empty');
  }
  if (/```|~~~/v.test(commitMessage)) {
    throw new Error('LLM output contains unsupported control markup');
  }
  const [subject = ''] = commitMessage.split(/\r?\n/v, 1);
  if (
    !/^[a-z][a-z0-9\u002D]*(?:\([^\u0028\u0029\r\n]+\))?!?: \S.*$/iv.test(
      subject,
    )
  ) {
    throw new Error('LLM output has invalid Conventional Commit subject');
  }
}

// Dropped on any line after the subject: hosting services read these outside a trailer block.
const ASSERTION =
  /^\s*(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|skip-checks|release-as|co-developed-by|reported-by|suggested-by|helped-by|cc|change-id)\s*:/iv;
const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[^\S\r\n]+(?:(?:[\w.\-]+\/[\w.\-]+)?#\d+|GH-\d+|https?:\/\/\S*\/(?:issues|pull|pulls|merge_requests)\/\d+)/iv;
// Markers that make hosting services skip CI for the commit.
// No unbounded leading quantifier (quadratic on whitespace runs): eat at most one adjacent space.
const CI_MARKER = String.raw`(?:\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|\*\*\*NO_CI\*\*\*)`;
const CI_SKIP = new RegExp(
  `^${CI_MARKER}[ \\t]?|[ \\t]?${CI_MARKER}(?:[ \\t]+$)?`,
  'gimv',
);

// Trust boundary: the diff is untrusted repository content, so the model reply derived from it
// is untrusted too (prompt injection). Real trailers (Co-authored-by, Signed-off-by, Release-As,
// ...) and lines holding a closing keyword plus issue reference (Closes #n) are metadata other
// tools act on; model output must not assert them, wherever they sit after the subject,
// BREAKING CHANGE blocks included. BREAKING CHANGE footers and all other prose survive.
function stripModelTrailers(message: string): string {
  const kept = message
    .split(/\r\n?|\n/v)
    .filter(
      (line, i) => i === 0 || !(ASSERTION.test(line) || CLOSING.test(line)),
    );
  while (kept.length > 1 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }
  return kept.join('\n').replace(/\n{3,}/gv, '\n\n');
}
