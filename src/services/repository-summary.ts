import { CONFIG } from '../../gcm.config.js';
import { BINARY_EXTENSIONS } from '../constants.js';
import { summarizeDiff, type DiffFileFacts } from '../diff-summary.js';
import { spawnGitLines, spawnGitStream } from '../git-utils.js';

interface DiffLinesResult {
  lines: string[];
  truncated: boolean;
}

export interface RepositorySummaryOptions {
  spawnLinesImpl: (args: string[], options?: Record<string, unknown>) => Promise<DiffLinesResult>;
  spawnStreamImpl: (args: string[]) => Promise<{ text: string; truncated: boolean }>;
}

function getBasename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? '';
}

function isConfigFile(filePath: string): boolean {
  const lowerFilePath = filePath.toLowerCase();
  const baseName = getBasename(lowerFilePath);
  if (baseName.endsWith('.config.js') || baseName.endsWith('.config.ts')) return true;
  if (baseName.startsWith('.') && (baseName.endsWith('rc') || baseName.startsWith('.env'))) {
    return true;
  }
  return (
    lowerFilePath.includes('config.') ||
    lowerFilePath.includes('.lock') ||
    lowerFilePath.includes('-lock.') ||
    baseName === 'bun.lockb'
  );
}

function isBinaryFile(file: string): boolean {
  return new RegExp(`\\.(${BINARY_EXTENSIONS.join('|')})$`).test(file.toLowerCase());
}

async function readFileFacts(
  file: string,
  spawnLinesImpl: RepositorySummaryOptions['spawnLinesImpl'],
): Promise<DiffFileFacts> {
  if (isBinaryFile(file)) return { file, lines: [], skipped: true, truncated: false };
  const contextLines = isConfigFile(file) ? 0 : 1;
  const result = await spawnLinesImpl(['diff', '--staged', '-w', `-U${contextLines}`, '--', file], {
    maxBytes: CONFIG.PER_FILE_BUFFER,
  });
  return { file, lines: result.lines, skipped: false, truncated: result.truncated };
}

export async function summarizeRepositoryDiff(
  stagedFiles: string[],
  options?: RepositorySummaryOptions,
) {
  if (!Array.isArray(stagedFiles)) throw new Error('stagedFiles must be an array');
  const dependencies = options ?? {
    spawnLinesImpl: spawnGitLines,
    spawnStreamImpl: spawnGitStream,
  };
  const stats = await dependencies.spawnStreamImpl([
    'diff',
    '--staged',
    '-w',
    '--stat',
    '--stat-width=80',
  ]);
  const files: DiffFileFacts[] = [];
  for (const file of stagedFiles)
    files.push(await readFileFacts(file, dependencies.spawnLinesImpl));
  return summarizeDiff(stats.text, files, {
    enableHunkWeights: CONFIG.ENABLE_HUNK_WEIGHTS,
    maxHunks: CONFIG.MAX_HUNKS,
    maxOutputBytes: Math.floor(CONFIG.CHILD_PROCESS_MAX_BUFFER / 2),
  });
}
