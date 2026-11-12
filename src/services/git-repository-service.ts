import { fileExists } from '../git-utils.js';
import type { GitCommandRunner } from '../git-utils.js';
import type { Logger } from '../logger.js';
import type { CommitTarget, RepositoryState } from './git-service.js';

const PORCELAIN_STATUS_LENGTH = 2;
const PORCELAIN_PATH_PREFIX_LENGTH = 3;

async function isPublishedCommit(
  runGit: GitCommandRunner,
  hash: string,
): Promise<boolean> {
  try {
    const remotes = await runGit(['branch', '--remotes', '--contains', hash]);
    if (remotes.text.trim().length > 0) {
      return true;
    }
    const configuredRemotes = await runGit(['remote']);
    if (configuredRemotes.text.trim().length === 0) {
      return false;
    }
    const trackingRefs = await runGit([
      'for-each-ref',
      '--format=%(refname)',
      'refs/remotes',
    ]);
    return trackingRefs.text.trim().length === 0;
  } catch {
    return true;
  }
}

// An `amend!` commit is created on the current branch. When the target is not
// reachable from HEAD the rebase that would fold it never sees it, so the
// commit stays behind as litter and the target keeps its old message. Compared
// through merge-base, whose answer arrives as output rather than an exit code.
async function isAncestorOfHead(
  runGit: GitCommandRunner,
  hash: string,
): Promise<boolean> {
  try {
    const base = await runGit(['merge-base', 'HEAD', hash]);
    return base.text.trim() === hash;
  } catch {
    return false;
  }
}

// A commit made on a detached HEAD is orphaned the moment another branch is
// checked out. Both amend and an `amend!` commit would be lost that way, while
// the tool reports success.
async function isHeadDetached(runGit: GitCommandRunner): Promise<boolean> {
  try {
    await runGit(['symbolic-ref', '--quiet', 'HEAD']);
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
  runGit: GitCommandRunner,
  hash: string,
  subject: string,
): Promise<{ hasParent: boolean; hasAmbiguousSubject: boolean }> {
  try {
    const ancestors = await runGit(['log', '--format=%s', `${hash}^`]);
    const twins = ancestors.text
      .split('\n')
      .filter((line) => line.trimEnd() === subject);
    return { hasParent: true, hasAmbiguousSubject: twins.length > 0 };
  } catch {
    return { hasParent: false, hasAmbiguousSubject: false };
  }
}

export async function inspectCommitTarget(
  runGit: GitCommandRunner,
  hash: string,
  logger: Logger | null,
): Promise<CommitTarget> {
  const resolved = (
    await runGit(['rev-parse', '--verify', `${hash}^{commit}`])
  ).text.trim();
  const [headResult, subjectResult] = await Promise.all([
    runGit(['rev-parse', '--verify', 'HEAD^{commit}']),
    runGit(['log', '-1', '--format=%s', resolved]),
  ]);
  const head = headResult.text.trim();
  const subject = subjectResult.text.trim();
  const isHead = resolved === head;
  const [ambiguity, isPublished, isAncestor, headDetached] = await Promise.all([
    readSubjectAmbiguity(runGit, resolved, subject),
    isPublishedCommit(runGit, resolved),
    isHead ? Promise.resolve(true) : isAncestorOfHead(runGit, resolved),
    isHeadDetached(runGit),
  ]);
  const target: CommitTarget = {
    hash: resolved,
    headHash: head,
    subject,
    isHead,
    isPublished,
    isAncestorOfHead: isAncestor,
    isHeadDetached: headDetached,
    ...ambiguity,
  };
  logger?.log('debug', 'Commit target', { ...target });
  return target;
}

function parsePorcelainStatus(text: string): {
  hasStagedChanges: boolean;
  hasUnmergedPaths: boolean;
  changedFiles: string[];
} {
  const state = {
    hasStagedChanges: false,
    hasUnmergedPaths: false,
    changedFiles: new Set<string>(),
  };

  const records = text.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const [record] = records.slice(index, index + 1);
    if (record === '') {
      continue;
    }
    const parsedLine = parsePorcelainLine(record);
    state.hasStagedChanges ||= parsedLine.hasStagedChanges;
    state.hasUnmergedPaths ||= parsedLine.hasUnmergedPaths;
    addChangedPath(parsedLine.path, state.changedFiles);
    const status = record.slice(0, PORCELAIN_STATUS_LENGTH);
    if (status.includes('R') || status.includes('C')) {
      index += 1;
    }
  }

  return {
    hasStagedChanges: state.hasStagedChanges,
    hasUnmergedPaths: state.hasUnmergedPaths,
    changedFiles: Array.from(state.changedFiles),
  };
}

function parsePorcelainLine(line: string): {
  hasStagedChanges: boolean;
  hasUnmergedPaths: boolean;
  path: string;
} {
  if (line.startsWith('?? ')) {
    return {
      hasStagedChanges: false,
      hasUnmergedPaths: false,
      path: line.slice(PORCELAIN_PATH_PREFIX_LENGTH),
    };
  }
  const x = line.at(0) ?? ' ';
  const y = line.at(1) ?? ' ';
  return {
    hasStagedChanges: x !== ' ',
    hasUnmergedPaths: isUnmergedStatus(x, y),
    path: line.slice(PORCELAIN_PATH_PREFIX_LENGTH),
  };
}

function isUnmergedStatus(x: string, y: string): boolean {
  return (
    x === 'U' ||
    y === 'U' ||
    (x === 'A' && y === 'A') ||
    (x === 'D' && y === 'D')
  );
}

function addChangedPath(rawPathInput: string, changedFiles: Set<string>): void {
  if (rawPathInput !== '') {
    changedFiles.add(rawPathInput);
  }
}

async function detectInProgressOperation(
  runGit: GitCommandRunner,
): Promise<RepositoryState['inProgressOperation']> {
  const gitDir = (await runGit(['rev-parse', '--git-dir'])).text.trim();
  const checks: Array<{
    name: RepositoryState['inProgressOperation'];
    path: string;
  }> = [
    { name: 'merge', path: `${gitDir}/MERGE_HEAD` },
    { name: 'rebase', path: `${gitDir}/rebase-merge` },
    { name: 'rebase', path: `${gitDir}/rebase-apply` },
    { name: 'cherry-pick', path: `${gitDir}/CHERRY_PICK_HEAD` },
    { name: 'revert', path: `${gitDir}/REVERT_HEAD` },
    { name: 'bisect', path: `${gitDir}/BISECT_LOG` },
  ];
  const matches = await Promise.all(
    checks.map(async (check) => await fileExists(check.path)),
  );
  const matchIndex = matches.findIndex((matchesPath) => matchesPath);
  return checks[matchIndex]?.name ?? null;
}

export async function getRepositoryState(
  runGit: GitCommandRunner,
  logger: Logger | null,
): Promise<RepositoryState> {
  const status = await runGit(['status', '--porcelain=v1', '-z']);
  if (status.truncated) {
    throw new Error(
      'Repository status output was truncated. Reduce the worktree size, then try again.',
    );
  }
  const parsed = parsePorcelainStatus(status.text);
  const inProgressOperation = await detectInProgressOperation(runGit);
  const result: RepositoryState = { ...parsed, inProgressOperation };
  logger?.log('debug', 'Repository state', { ...result });
  return result;
}
