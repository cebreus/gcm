import { parseGeminiOutput } from './parser.js';
import type { Labels } from './parser.js';
import type { Logger } from './logger.js';

const encoder = new TextEncoder();

export function estimateTokens(text: string, tokenBytesRatio: number): number {
  return Math.ceil(encoder.encode(text).length / tokenBytesRatio);
}

interface UserContentOptions {
  input: string;
  promptSuffix: string;
  truncated: boolean;
}

export function buildUserContent(
  { input, promptSuffix, truncated }: UserContentOptions,
  _systemInstructions: any,
): string {
  let userContent = `Generate a branch name, pull request title, pull request description, and a conventional commit message based on the following ${promptSuffix}.\n\n${input}`;
  if (truncated) {
    userContent += '\n\nNote: The diff was truncated while being read due to buffer limits.';
  }
  return userContent;
}

export function buildFallbackStructured(stagedFiles: string[]): Labels {
  const files = stagedFiles || [];
  const n = files.length;
  const branch = `chore/update-${n}-files`;
  const commitTitle = `chore: update ${n} file${n === 1 ? '' : 's'}`;
  function fileBullet(f: string): string {
    return '- ' + f;
  }
  const bullets = files.slice(0, 12).map(fileBullet).join('\n');
  const prDesc = `Automatic fallback commit produced after Gemini failed to respond.\n\nFiles changed:\n${bullets}\n\n(Truncated list if more files)`;
  return {
    BRANCH: branch,
    COMMIT_MESSAGE: commitTitle + '\n\n' + bullets,
    PR_TITLE: commitTitle,
    PR_DESCRIPTION: prDesc,
  };
}

interface ParseAndDisplayResult {
  parsed: boolean;
}

export function parseAndDisplay(
  rawText: string,
  displayStructured: (labels: Labels) => void,
  displayRaw: (text: string) => void,
  logger?: Logger,
): ParseAndDisplayResult {
  try {
    const parsed = parseGeminiOutput(rawText);
    displayStructured(parsed);
    return { parsed: true };
  } catch (err) {
    try {
      logger?.log?.('warn', 'Failed to parse gemini output; printing raw output', {
        error: String(err),
      });
       
    } catch (_e) {
      /* ignore */
    }
    displayRaw(rawText);
    return { parsed: false };
  }
}
