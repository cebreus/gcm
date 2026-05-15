import { spawnGitStream } from '../git-utils.js';
import { filterExcludedFiles } from '../utils.js';
import type { Logger } from '../logger.js';

export interface StagedChangesResult {
  stagedDiff: string;
  stagedFiles: string[];
  truncated: boolean;
  truncatedNote?: string;
}

export interface GitService {
  retrieveStagedChanges(
    commitHash: string | null,
    logger: Logger | null,
    excludePatterns?: string[],
  ): Promise<StagedChangesResult | null>;
  commitChanges(message: string, logger: Logger | null): Promise<void>;
}

export type GitCommandRunner = typeof spawnGitStream;

export interface GitServiceOptions {
  gitCommandRunner?: GitCommandRunner;
}

interface GitServiceDeps {
  gitCommandRunner: GitCommandRunner;
}

function buildFileListArgs(commitHash: string | null): string[] {
  return commitHash
    ? ['show', '-w', '--name-only', '--pretty=format:', commitHash]
    : ['diff', '--staged', '-w', '--name-only'];
}

function buildDiffArgs(commitHash: string | null): string[] {
  return commitHash ? ['show', '-w', commitHash] : ['diff', '--staged', '-w'];
}

function parseFileList(text: string): string[] {
  return text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

function logExcludedFiles(
  logger: Logger | null,
  excludePatterns: string[],
  originalFileCount: number,
  filteredFileCount: number,
): void {
  if (!(excludePatterns.length > 0 && filteredFileCount < originalFileCount)) return;
  const excludedCount = originalFileCount - filteredFileCount;
  logger?.log(
    'info',
    `Excluded ${excludedCount} file(s) matching patterns: ${excludePatterns.join(', ')}`,
  );
}

function logNoChanges(logger: Logger | null, commitHash: string | null): void {
  if (commitHash) {
    logger?.log('info', `No changes found in commit ${commitHash}.`);
    return;
  }
  logger?.log('info', 'No staged changes found. Use `git add` to stage files for commit.');
}

/**
 * Creates a GitService instance
 */
export function createGitService(opts: GitServiceOptions = {}): GitService {
  const deps: GitServiceDeps = { gitCommandRunner: opts.gitCommandRunner || spawnGitStream };
  return {
    retrieveStagedChanges: function (
      commitHash: string | null,
      logger: Logger | null = null,
      excludePatterns: string[] = [],
    ): Promise<StagedChangesResult | null> {
      return retrieveStagedChangesWithDeps({
        deps,
        commitHash,
        logger,
        excludePatterns,
      });
    },
    commitChanges: function (message: string, logger: Logger | null = null): Promise<void> {
      return commitChangesWithDeps({ deps, message, logger });
    },
  };
}

async function retrieveStagedChangesWithDeps(params: {
  deps: GitServiceDeps;
  commitHash: string | null;
  logger: Logger | null;
  excludePatterns: string[];
}): Promise<StagedChangesResult | null> {
  const { deps, commitHash, logger, excludePatterns } = params;
  logger?.log('debug', 'Checking git status');
  const fileListRes = await deps.gitCommandRunner(buildFileListArgs(commitHash));
  let files = parseFileList(fileListRes.text);
  const originalFileCount = files.length;
  files = filterExcludedFiles(files, excludePatterns);
  logExcludedFiles(logger, excludePatterns, originalFileCount, files.length);
  if (files.length === 0) {
    logNoChanges(logger, commitHash);
    return null;
  }
  const diffRes = await deps.gitCommandRunner(buildDiffArgs(commitHash));
  if (diffRes.truncated) logger?.log('warn', 'Diff output was truncated due to size limits.');
  const truncatedNote = diffRes.truncated
    ? '\n\nNote: The diff was truncated while being read due to buffer limits.'
    : undefined;
  return {
    stagedDiff: diffRes.text,
    stagedFiles: files,
    truncated: diffRes.truncated,
    truncatedNote,
  };
}

async function commitChangesWithDeps(params: {
  deps: GitServiceDeps;
  message: string;
  logger: Logger | null;
}): Promise<void> {
  const { deps, message, logger } = params;
  if (logger) logger.log('debug', 'Executing git commit');
  await deps.gitCommandRunner(['commit', '-m', message]);
}
