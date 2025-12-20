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

/**
 * Creates a GitService instance
 */
export function createGitService(opts: GitServiceOptions = {}): GitService {
  const gitCommandRunner = opts.gitCommandRunner || spawnGitStream;

  async function retrieveStagedChanges(
    commitHash: string | null,
    logger: Logger | null = null,
    excludePatterns: string[] = [],
  ): Promise<StagedChangesResult | null> {
    if (logger) logger.log('debug', 'Checking git status');

    // 1. Get list of files
    let fileListArgs: string[];
    if (commitHash) {
      fileListArgs = ['show', '-w', '--name-only', '--pretty=format:', commitHash];
    } else {
      fileListArgs = ['diff', '--staged', '-w', '--name-only'];
    }

    const fileListRes = await gitCommandRunner(fileListArgs);

    let files = fileListRes.text
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    // Filter out excluded files
    const originalFileCount = files.length;
    files = filterExcludedFiles(files, excludePatterns);

    if (excludePatterns.length > 0 && files.length < originalFileCount) {
      const excludedCount = originalFileCount - files.length;
      if (logger)
        logger.log(
          'info',
          `Excluded ${excludedCount} file(s) matching patterns: ${excludePatterns.join(', ')}`,
        );
    }

    if (files.length === 0) {
      if (commitHash) {
        if (logger) logger.log('info', `No changes found in commit ${commitHash}.`);
      } else {
        if (logger)
          logger.log('info', 'No staged changes found. Use `git add` to stage files for commit.');
      }
      return null;
    }

    // 2. Get the diff
    let diffArgs: string[];
    if (commitHash) {
      diffArgs = ['show', '-w', commitHash];
    } else {
      diffArgs = ['diff', '--staged', '-w'];
    }

    const diffRes = await gitCommandRunner(diffArgs);

    // Check if truncated
    if (diffRes.truncated) {
      if (logger) logger.log('warn', 'Diff output was truncated due to size limits.');
    }

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

  async function commitChanges(message: string, logger: Logger | null = null): Promise<void> {
    if (logger) logger.log('debug', 'Executing git commit');
    // We use 'git commit -m'
    // Note: multiline messages work fine with array args in spawn
    await gitCommandRunner(['commit', '-m', message]);
  }

  return {
    retrieveStagedChanges,
    commitChanges,
  };
}
