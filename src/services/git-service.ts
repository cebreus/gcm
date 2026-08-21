import { spawnGitStream } from '../git-utils.js';
import { filterExcludedFiles } from '../utils.js';
import type { Logger } from '../logger.js';
import { stat } from 'node:fs/promises';

export interface StagedChangesResult {
  stagedDiff: string;
  stagedFiles: string[];
  truncated: boolean;
}

export interface CommitTarget {
  hash: string;
  subject: string;
  isHead: boolean;
  isPublished: boolean;
  isAncestorOfHead: boolean;
  isHeadDetached: boolean;
  hasParent: boolean;
  hasAmbiguousSubject: boolean;
}

export interface GitService {
  retrieveStagedChanges(
    commitHash: string | null,
    logger: Logger | null,
    excludePatterns?: string[],
  ): Promise<StagedChangesResult | null>;
  commitChanges(message: string, logger: Logger | null): Promise<void>;
  amendCommit(message: string, logger: Logger | null): Promise<void>;
  rewordCommit(target: CommitTarget, message: string, logger: Logger | null): Promise<void>;
  inspectCommitTarget(hash: string, logger: Logger | null): Promise<CommitTarget>;
  getIndexTree(logger: Logger | null): Promise<string>;
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
    amendCommit: function (message: string, logger: Logger | null = null): Promise<void> {
      return amendCommitWithDeps({ deps, message, logger });
    },
    rewordCommit: function (
      target: CommitTarget,
      message: string,
      logger: Logger | null = null,
    ): Promise<void> {
      return rewordCommitWithDeps({ deps, target, message, logger });
    },
    inspectCommitTarget: function (
      hash: string,
      logger: Logger | null = null,
    ): Promise<CommitTarget> {
      return inspectCommitTargetWithDeps({ deps, hash, logger });
    },
    getIndexTree: function (logger: Logger | null = null): Promise<string> {
      return getIndexTreeWithDeps({ deps, logger });
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
  const diffRes = await deps.gitCommandRunner([...buildDiffArgs(commitHash), '--', ...files]);
  if (diffRes.truncated) logger?.log('warn', 'Diff output was truncated due to size limits.');
  return {
    stagedDiff: diffRes.text,
    stagedFiles: files,
    truncated: diffRes.truncated,
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

async function getIndexTreeWithDeps(params: {
  deps: GitServiceDeps;
  logger: Logger | null;
}): Promise<string> {
  const { deps, logger } = params;
  logger?.log('debug', 'Capturing git index tree');
  const result = await deps.gitCommandRunner(['write-tree']);
  return result.text.trim();
}

async function amendCommitWithDeps(params: {
  deps: GitServiceDeps;
  message: string;
  logger: Logger | null;
}): Promise<void> {
  const { deps, message, logger } = params;
  logger?.log('debug', 'Executing git commit --amend');
  await deps.gitCommandRunner(['commit', '--amend', '-m', message]);
}

// An `amend!` commit carries the replacement message as an ordinary commit, so
// nothing is rewritten here. `git rebase --autosquash` folds it into the target
// later, when the user asks for it.
async function rewordCommitWithDeps(params: {
  deps: GitServiceDeps;
  target: CommitTarget;
  message: string;
  logger: Logger | null;
}): Promise<void> {
  const { deps, target, message, logger } = params;
  logger?.log('debug', `Creating amend! commit for ${target.hash}`);
  await deps.gitCommandRunner([
    'commit',
    '--allow-empty',
    '-m',
    `amend! ${target.subject}`,
    '-m',
    message,
  ]);
}

// `branch --remotes --contains` answers with output rather than an exit code:
// empty means no remote branch holds the commit. `merge-base --is-ancestor`
// would answer through exit 1, which the git runner turns into a throw
// indistinguishable from a real failure. This also covers every remote, not
// just the tracked upstream. An unanswerable question resolves to published,
// so the additive path is taken.
async function isPublishedCommit(deps: GitServiceDeps, hash: string): Promise<boolean> {
  try {
    const remotes = await deps.gitCommandRunner(['branch', '--remotes', '--contains', hash]);
    return remotes.text.trim().length > 0;
  } catch {
    return true;
  }
}

// An `amend!` commit is created on the current branch. When the target is not
// reachable from HEAD the rebase that would fold it never sees it, so the
// commit stays behind as litter and the target keeps its old message. Compared
// through merge-base, whose answer arrives as output rather than an exit code.
async function isAncestorOfHead(deps: GitServiceDeps, hash: string): Promise<boolean> {
  try {
    const base = await deps.gitCommandRunner(['merge-base', 'HEAD', hash]);
    return base.text.trim() === hash;
  } catch {
    return false;
  }
}

// A commit made on a detached HEAD is orphaned the moment another branch is
// checked out. Both amend and an `amend!` commit would be lost that way, while
// the tool reports success.
async function isHeadDetached(deps: GitServiceDeps): Promise<boolean> {
  try {
    await deps.gitCommandRunner(['symbolic-ref', '--quiet', 'HEAD']);
    return false;
  } catch {
    return true;
  }
}

// `rebase --autosquash` folds an `amend!` into the FIRST commit in its range
// whose subject matches, so an older twin of the subject silently steals the
// rewrite when the user widens the base. A missing parent means the target is
// the root commit, which changes the rebase command it needs.
async function readSubjectAmbiguity(
  deps: GitServiceDeps,
  hash: string,
  subject: string,
): Promise<{ hasParent: boolean; hasAmbiguousSubject: boolean }> {
  try {
    const ancestors = await deps.gitCommandRunner(['log', '--format=%s', `${hash}^`]);
    const twins = ancestors.text.split('\n').filter(line => line.trimEnd() === subject);
    return { hasParent: true, hasAmbiguousSubject: twins.length > 0 };
  } catch {
    return { hasParent: false, hasAmbiguousSubject: false };
  }
}

async function inspectCommitTargetWithDeps(params: {
  deps: GitServiceDeps;
  hash: string;
  logger: Logger | null;
}): Promise<CommitTarget> {
  const { deps, hash, logger } = params;
  const resolved = (
    await deps.gitCommandRunner(['rev-parse', '--verify', `${hash}^{commit}`])
  ).text.trim();
  const head = (
    await deps.gitCommandRunner(['rev-parse', '--verify', 'HEAD^{commit}'])
  ).text.trim();
  const subject = (await deps.gitCommandRunner(['log', '-1', '--format=%s', resolved])).text.trim();
  const ambiguity = await readSubjectAmbiguity(deps, resolved, subject);
  const isHead = resolved === head;
  const target: CommitTarget = {
    hash: resolved,
    subject,
    isHead,
    isPublished: await isPublishedCommit(deps, resolved),
    isAncestorOfHead: isHead || (await isAncestorOfHead(deps, resolved)),
    isHeadDetached: await isHeadDetached(deps),
    ...ambiguity,
  };
  logger?.log('debug', 'Commit target', { ...target });
  return target;
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
