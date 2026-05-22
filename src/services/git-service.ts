import { spawnGitStream } from '../git-utils.js';
import { filterExcludedFiles } from '../utils.js';
import type { Logger } from '../logger.js';
import { stat } from 'node:fs/promises';

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
  getRepositoryState?(logger: Logger | null): Promise<RepositoryState>;
}

export type GitCommandRunner = typeof spawnGitStream;

export interface GitServiceOptions {
  gitCommandRunner?: GitCommandRunner;
}

interface GitServiceDeps {
  gitCommandRunner: GitCommandRunner;
}

export interface RepositoryState {
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  hasUntrackedFiles: boolean;
  hasUnmergedPaths: boolean;
  inProgressOperation: null | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';
  changedFiles: string[];
}

function buildFileListArgs(commitHash: string | null): string[] {
  return commitHash
    ? ['show', '-w', '--name-only', '--pretty=format:', commitHash]
    : ['diff', '--staged', '--name-only'];
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
  if (commitHash) logger?.log('debug', `No changes found in commit ${commitHash}.`);
  else logger?.log('debug', 'No staged changes found.');
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
    getRepositoryState: function (logger: Logger | null = null): Promise<RepositoryState> {
      return getRepositoryStateWithDeps({ deps, logger });
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parsePorcelainStatus(text: string): {
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  hasUntrackedFiles: boolean;
  hasUnmergedPaths: boolean;
  changedFiles: string[];
} {
  const state = {
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    hasUntrackedFiles: false,
    hasUnmergedPaths: false,
    changedFiles: new Set<string>(),
  };

  const lines = text
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean);
  for (const line of lines) {
    parsePorcelainLine(line, state);
  }

  return {
    hasStagedChanges: state.hasStagedChanges,
    hasUnstagedChanges: state.hasUnstagedChanges,
    hasUntrackedFiles: state.hasUntrackedFiles,
    hasUnmergedPaths: state.hasUnmergedPaths,
    changedFiles: Array.from(state.changedFiles),
  };
}

function parsePorcelainLine(
  line: string,
  state: {
    hasStagedChanges: boolean;
    hasUnstagedChanges: boolean;
    hasUntrackedFiles: boolean;
    hasUnmergedPaths: boolean;
    changedFiles: Set<string>;
  },
): void {
  if (line.startsWith('?? ')) {
    state.hasUntrackedFiles = true;
    addChangedPath(line.slice(3), state.changedFiles);
    return;
  }
  const x = line[0] || ' ';
  const y = line[1] || ' ';
  if (x !== ' ') state.hasStagedChanges = true;
  if (y !== ' ') state.hasUnstagedChanges = true;
  if (isUnmergedStatus(x, y)) state.hasUnmergedPaths = true;
  addChangedPath(line.slice(3), state.changedFiles);
}

function isUnmergedStatus(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
}

function addChangedPath(rawPathInput: string, changedFiles: Set<string>): void {
  const rawPath = rawPathInput.trim();
  if (!rawPath) return;
  const renamedParts = rawPath.split(' -> ');
  const normalizedPath = (
    renamedParts.length > 1 ? renamedParts[renamedParts.length - 1] : rawPath
  ).trim();
  if (normalizedPath) changedFiles.add(normalizedPath);
}

async function detectInProgressOperation(
  deps: GitServiceDeps,
): Promise<RepositoryState['inProgressOperation']> {
  const gitDir = (await deps.gitCommandRunner(['rev-parse', '--git-dir'])).text.trim();
  const checks: Array<{ name: RepositoryState['inProgressOperation']; path: string }> = [
    { name: 'merge', path: `${gitDir}/MERGE_HEAD` },
    { name: 'rebase', path: `${gitDir}/rebase-merge` },
    { name: 'rebase', path: `${gitDir}/rebase-apply` },
    { name: 'cherry-pick', path: `${gitDir}/CHERRY_PICK_HEAD` },
    { name: 'revert', path: `${gitDir}/REVERT_HEAD` },
    { name: 'bisect', path: `${gitDir}/BISECT_LOG` },
  ];
  for (const check of checks) {
    if (await fileExists(check.path)) return check.name;
  }
  return null;
}

async function getRepositoryStateWithDeps(params: {
  deps: GitServiceDeps;
  logger: Logger | null;
}): Promise<RepositoryState> {
  const { deps, logger } = params;
  const status = await deps.gitCommandRunner(['status', '--porcelain']);
  const parsed = parsePorcelainStatus(status.text);
  const inProgressOperation = await detectInProgressOperation(deps);
  const result: RepositoryState = { ...parsed, inProgressOperation };
  logger?.log('debug', 'Repository state', { ...result });
  return result;
}
