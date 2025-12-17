import type { Labels } from './parser.js';

const encoder = new TextEncoder();

export function estimateTokenCount(text: string, tokenBytesRatio: number): number {
  return Math.ceil(encoder.encode(text).length / tokenBytesRatio);
}

export function generateFallbackCommitDetails(stagedFiles: string[]): Labels {
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
