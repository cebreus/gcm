import { spawnGitStream } from '../git-utils.js';
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
  ): Promise<StagedChangesResult | null>;
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

    const files = fileListRes.text
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

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

  return {
    retrieveStagedChanges,
  };
}
