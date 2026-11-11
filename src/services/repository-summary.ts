import type { Config } from '../../gcm.config.js';
import { BINARY_EXTENSIONS } from '../constants.js';
import { summarizeDiff, type DiffFileFacts } from '../diff-summary.js';
import { literalPathspec, spawnGitLines, spawnGitStream } from '../git-utils.js';

interface DiffLinesResult {
  lines: string[];
  truncated: boolean;
}

interface RepositorySummaryOptions {
  spawnLinesImpl?: (args: string[], options?: Record<string, unknown>) => Promise<DiffLinesResult>;
  spawnStreamImpl?: (
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<{ text: string; truncated: boolean }>;
  targetCommit?: string;
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

function diffArgs(
  targetCommit: string | undefined,
  options: string[],
  files: string[],
  ignoreWhitespace: boolean,
): string[] {
  const plain = ['--no-color', '--no-ext-diff', '--no-textconv'];
  const w = ignoreWhitespace ? ['-w'] : [];
  return [
    ...(targetCommit
      ? ['show', '--first-parent', '--format=', ...w, ...plain, ...options, targetCommit]
      : ['diff', '--staged', ...w, ...plain, ...options]),
    '--',
    ...files.map(literalPathspec),
  ];
}

async function readFileFacts(
  file: string,
  spawnLinesImpl: NonNullable<RepositorySummaryOptions['spawnLinesImpl']>,
  targetCommit: string | undefined,
  ignoreWhitespace: boolean,
  config?: Pick<Config, 'PER_FILE_BUFFER'>,
): Promise<DiffFileFacts> {
  if (isBinaryFile(file)) return { file, lines: [], skipped: true, truncated: false };
  const contextLines = isConfigFile(file) ? 0 : 1;
  const args = diffArgs(targetCommit, [`-U${contextLines}`], [file], ignoreWhitespace);
  const result = await spawnLinesImpl(args, {
    maxBytes: config?.PER_FILE_BUFFER,
    allowTruncated: true,
  });
  const gitDetectedBinary = result.lines.some(
    line => /^Binary files .* differ\s*$/.test(line) || line.trim() === 'GIT binary patch',
  );
  return {
    file,
    lines: gitDetectedBinary ? [] : result.lines,
    skipped: gitDetectedBinary,
    truncated: result.truncated,
  };
}

export async function summarizeRepositoryDiff(
  stagedFiles: string[],
  options: RepositorySummaryOptions | undefined = undefined,
  config: Pick<Config, 'PER_FILE_BUFFER' | 'MAX_HUNKS' | 'CHILD_PROCESS_MAX_BUFFER'>,
) {
  const dependencies = {
    spawnLinesImpl: options?.spawnLinesImpl ?? spawnGitLines,
    spawnStreamImpl: options?.spawnStreamImpl ?? spawnGitStream,
    targetCommit: options?.targetCommit,
  };
  const readStats = (ignoreWhitespace: boolean) =>
    dependencies.spawnStreamImpl(
      diffArgs(
        dependencies.targetCommit,
        ['--stat', '--stat-width=80'],
        stagedFiles,
        ignoreWhitespace,
      ),
      { allowTruncated: true },
    );
  // Same rule as readDiff: `-w` empties a whitespace-only change, so retry without it.
  let ignoreWhitespace = true;
  let stats = await readStats(true);
  if (stats.text.trim() === '') {
    ignoreWhitespace = false;
    stats = await readStats(false);
  }
  const files = new Array<DiffFileFacts>(stagedFiles.length);
  const failures = new Array<{ error: unknown } | undefined>(stagedFiles.length);
  let nextIndex = 0;
  let failed = false;
  // Bound concurrent Git processes to avoid exhausting resources on large repositories.
  async function readNextFile(): Promise<void> {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      const file = stagedFiles[index];
      if (file === undefined) return;
      try {
        files[index] = await readFileFacts(
          file,
          dependencies.spawnLinesImpl,
          dependencies.targetCommit,
          ignoreWhitespace,
          config,
        );
      } catch (error) {
        failures[index] = { error };
        failed = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, stagedFiles.length) }, () => readNextFile()));
  const firstFailure = failures.find(Boolean);
  if (firstFailure) throw firstFailure.error;
  const statsText = stats.truncated
    ? `${stats.text}\n... (file statistics truncated by output limit) ...`
    : stats.text;
  return summarizeDiff(statsText, files, {
    maxHunks: config.MAX_HUNKS,
    maxOutputBytes: Math.floor(config.CHILD_PROCESS_MAX_BUFFER / 2),
  });
}
