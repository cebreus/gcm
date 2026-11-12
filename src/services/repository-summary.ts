import type { Config } from '../../gcm.config.js';
import { BINARY_EXTENSIONS } from '../constants.js';
import { type DiffFileFacts, summarizeDiff } from '../diff-summary.js';
import {
  type SpawnGitStreamResult,
  literalPathspec,
  spawnGitLines,
  spawnGitStream,
} from '../git-utils.js';

interface DiffLinesResult {
  lines: string[];
  truncated: boolean;
}

interface RepositorySummaryOptions {
  spawnLinesImpl?: (
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<DiffLinesResult>;
  spawnStreamImpl?: (
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<SpawnGitStreamResult>;
  targetCommit?: string;
}

interface ReadFileFactsOptions {
  file: string;
  spawnLinesImpl: NonNullable<RepositorySummaryOptions['spawnLinesImpl']>;
  targetCommit: string | undefined;
  ignoreWhitespace: boolean;
  config?: Pick<Config, 'PER_FILE_BUFFER'>;
}

const MAX_CONCURRENT_GIT_PROCESSES = 8;
function getBasename(filePath: string): string {
  return filePath.replaceAll('\\', '/').split('/').pop() ?? '';
}

function isConfigFile(filePath: string): boolean {
  const lowerFilePath = filePath.toLowerCase();
  const baseName = getBasename(lowerFilePath);
  if (baseName.endsWith('.config.js') || baseName.endsWith('.config.ts')) {
    return true;
  }
  if (
    baseName.startsWith('.') &&
    (baseName.endsWith('rc') || baseName.startsWith('.env'))
  ) {
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
  return new RegExp(`\\.(?:${BINARY_EXTENSIONS.join('|')})$`, 'v').test(
    file.toLowerCase(),
  );
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
    ...(targetCommit === undefined
      ? ['diff', '--staged', ...w, ...plain, ...options]
      : [
          'show',
          '--first-parent',
          '--format=',
          ...w,
          ...plain,
          ...options,
          targetCommit,
        ]),
    '--',
    ...files.map(literalPathspec),
  ];
}

async function readFileFacts(
  options: ReadFileFactsOptions,
): Promise<DiffFileFacts> {
  const { file, spawnLinesImpl, targetCommit, ignoreWhitespace, config } =
    options;
  if (isBinaryFile(file)) {
    return { file, lines: [], skipped: true, truncated: false };
  }
  const contextLines = isConfigFile(file) ? 0 : 1;
  const args = diffArgs(
    targetCommit,
    [`-U${contextLines}`],
    [file],
    ignoreWhitespace,
  );
  const result = await spawnLinesImpl(args, {
    maxBytes: config?.PER_FILE_BUFFER,
    allowTruncated: true,
  });
  const gitDetectedBinary = result.lines.some(
    (line) =>
      /^Binary files .* differ\s*$/v.test(line) ||
      line.trim() === 'GIT binary patch',
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
  options: RepositorySummaryOptions | undefined,
  config: Pick<
    Config,
    'PER_FILE_BUFFER' | 'MAX_HUNKS' | 'CHILD_PROCESS_MAX_BUFFER'
  >,
): Promise<ReturnType<typeof summarizeDiff>> {
  const dependencies = {
    spawnLinesImpl: options?.spawnLinesImpl ?? spawnGitLines,
    spawnStreamImpl: options?.spawnStreamImpl ?? spawnGitStream,
    targetCommit: options?.targetCommit,
  };
  const readStats = async (
    ignoreWhitespace: boolean,
  ): Promise<SpawnGitStreamResult> =>
    await dependencies.spawnStreamImpl(
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
  async function readFileBatch(startIndex: number): Promise<void> {
    const batch = stagedFiles.slice(
      startIndex,
      startIndex + MAX_CONCURRENT_GIT_PROCESSES,
    );
    if (batch.length === 0) {
      return;
    }
    const facts = await Promise.all(
      batch.map(
        async (file) =>
          await readFileFacts({
            file,
            spawnLinesImpl: dependencies.spawnLinesImpl,
            targetCommit: dependencies.targetCommit,
            ignoreWhitespace,
            config,
          }),
      ),
    );
    files.splice(startIndex, facts.length, ...facts);
    await readFileBatch(startIndex + facts.length);
  }
  await readFileBatch(0);
  const statsText = stats.truncated
    ? `${stats.text}\n... (file statistics truncated by output limit) ...`
    : stats.text;
  return summarizeDiff(statsText, files, {
    maxHunks: config.MAX_HUNKS,
    maxOutputBytes: Math.floor(config.CHILD_PROCESS_MAX_BUFFER / 2),
  });
}
