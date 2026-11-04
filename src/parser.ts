import { formatCommitMessage, sanitizeForDisplay } from './utils.js';

const MAX_RESPONSE_SIZE = 16 * 1024 * 1024;

export function parseLanguageModelOutput(text: string): string {
  if (!text || typeof text !== 'string') {
    throw new Error('parseLanguageModelOutput expects a string');
  }

  text = sanitizeForDisplay(text);

  if (
    /<\|[^>\r\n]+\|?>/i.test(text) ||
    /<\/?(?:think|analysis|reasoning)(?:\s[^>]*)?\/?>/i.test(text) ||
    /^\s*(?:```|~~~)/.test(text)
  ) {
    throw new Error('LLM output contains unsupported control markup');
  }
  if (/[؜‎‏‪-‮⁦-⁩]/u.test(text)) {
    throw new Error('LLM output contains unsupported control characters');
  }
  if (text.length > MAX_RESPONSE_SIZE) text = text.substring(0, MAX_RESPONSE_SIZE);

  const commitMessage = formatCommitMessage(text.trim());
  if (!commitMessage) throw new Error('LLM output is empty');
  if (/```|~~~/.test(commitMessage)) {
    throw new Error('LLM output contains unsupported control markup');
  }
  const subject = commitMessage.split(/\r?\n/, 1)[0];
  if (!/^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?!?: \S.*$/i.test(subject)) {
    throw new Error('LLM output has invalid Conventional Commit subject');
  }
  return commitMessage;
}
