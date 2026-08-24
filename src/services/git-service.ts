import { spawnGitStream } from '../git-utils.js';
import { filterExcludedFiles } from '../utils.js';
import type { Logger } from '../logger.js';

export interface StagedChangesResult {
  stagedDiff: string;
  stagedFiles: string[];
  excludedPaths?: string[];
  truncated: boolean;
  snapshot?: IndexSnapshot;
}

export interface CommitTarget {
  hash: string;
  headHash: string;
  subject: string;
  isHead: boolean;
  isPublished: boolean;
  isAncestorOfHead: boolean;
  isHeadDetached: boolean;
  hasParent: boolean;
  hasAmbiguousSubject: boolean;
}

export interface IndexEntry {
  path: string;
  mode: string;
  objectId: string;
}

export interface IndexSnapshot {
  tree: string;
  entries: IndexEntry[];
}

export interface CommitWriteSafety {
  snapshot: IndexSnapshot;
  target?: CommitTarget;
}

export interface GitService {
  retrieveStagedChanges(
    commitHash: string | null,
    logger: Logger | null,
    excludePatterns?: string[],
  ): Promise<StagedChangesResult | null>;
  commitChanges(message: string, logger: Logger | null, safety?: CommitWriteSafety): Promise<void>;
  amendCommit(message: string, logger: Logger | null, safety?: CommitWriteSafety): Promise<void>;
  rewordCommit(
    target: CommitTarget,
    message: string,
    logger: Logger | null,
    safety?: CommitWriteSafety,
  ): Promise<void>;
  inspectCommitTarget(hash: string, logger: Logger | null): Promise<CommitTarget>;
  getIndexTree(logger: Logger | null): Promise<string>;
  getIndexEntries(logger: Logger | null): Promise<IndexEntry[]>;
  getRepositoryState(logger: Logger | null): Promise<RepositoryState>;
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
    ? ['show', '--first-parent', '-w', '--name-only', '--pretty=format:', '-z', commitHash]
    : ['diff', '--staged', '--name-only', '-z'];
}

function buildDiffArgs(commitHash: string | null): string[] {
  return commitHash ? ['show', '--first-parent', '-w', commitHash] : ['diff', '--staged', '-w'];
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

function decodeGitQuotedPath(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path;
  const escapes: Record<string, string> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '"': '"',
    '\\': '\\',
  };
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 1; index < path.length - 1; index += 1) {
    if (path[index] !== '\\') {
      bytes.push(...encoder.encode(path[index]));
      continue;
    }
    const octal = path.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    const escaped = path[index + 1];
    bytes.push(...encoder.encode(escapes[escaped] ?? escaped));
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function parseFileList(text: string): string[] {
  if (text.includes('\0')) return text.split('\0').filter(path => path.length > 0);
  return text
    .split('\n')
    .filter(path => path.length > 0)
    .map(decodeGitQuotedPath);
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
  const deps: GitServiceDeps = { gitCommandRunner: opts.gitCommandRunner ?? spawnGitStream };
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
    commitChanges: function (
      message: string,
      logger: Logger | null = null,
      safety?: CommitWriteSafety,
    ): Promise<void> {
      return commitChangesWithDeps({ deps, message, logger, safety });
    },
    amendCommit: function (
      message: string,
      logger: Logger | null = null,
      safety?: CommitWriteSafety,
    ): Promise<void> {
      return amendCommitWithDeps({ deps, message, logger, safety });
    },
    rewordCommit: function (
      target: CommitTarget,
      message: string,
      logger: Logger | null = null,
      safety?: CommitWriteSafety,
    ): Promise<void> {
      return rewordCommitWithDeps({ deps, target, message, logger, safety });
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
    getIndexEntries: function (logger: Logger | null = null): Promise<IndexEntry[]> {
      return getIndexEntriesWithDeps({ deps, logger });
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
  if (fileListRes.truncated) {
    throw new Error('File list output was truncated. Reduce the change set, then try again.');
  }
  const allFiles = parseFileList(fileListRes.text);
  const files = filterExcludedFiles(allFiles, excludePatterns);
  const includedPaths = new Set(files);
  const excludedPaths = allFiles.filter(function (path) {
    return !includedPaths.has(path);
  });
  const originalFileCount = allFiles.length;
  logExcludedFiles(logger, excludePatterns, originalFileCount, files.length);
  if (files.length === 0) {
    logNoChanges(logger, commitHash);
    return null;
  }
  const diff = commitHash
    ? {
        result: await deps.gitCommandRunner([
          ...buildDiffArgs(commitHash),
          '--',
          ...files.map(literalPathspec),
        ]),
      }
    : await readStableStagedDiff({ deps, files, logger });
  const diffRes = diff.result;
  if (diffRes.truncated) logger?.log('warn', 'Diff output was truncated due to size limits.');
  return {
    stagedDiff: diffRes.text,
    stagedFiles: files,
    excludedPaths,
    truncated: diffRes.truncated,
    snapshot: 'snapshot' in diff ? diff.snapshot : undefined,
  };
}

async function readStableStagedDiff(params: {
  deps: GitServiceDeps;
  files: string[];
  logger: Logger | null;
}): Promise<{ result: Awaited<ReturnType<GitCommandRunner>>; snapshot: IndexSnapshot }> {
  const { deps, files, logger } = params;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const beforeEntries = await getIndexTreeWithDeps({ deps, logger });
    const entries = await getIndexEntriesWithDeps({ deps, logger });
    const beforeDiff = await getIndexTreeWithDeps({ deps, logger });
    if (beforeEntries !== beforeDiff) continue;
    const result = await deps.gitCommandRunner([
      ...buildDiffArgs(null),
      '--',
      ...files.map(literalPathspec),
    ]);
    const afterDiff = await getIndexTreeWithDeps({ deps, logger });
    if (beforeDiff === afterDiff) return { result, snapshot: { tree: afterDiff, entries } };
  }
  throw new Error(
    'Staged changes changed while their diff was being read. Regenerate the message, then try again.',
  );
}

async function commitChangesWithDeps(params: {
  deps: GitServiceDeps;
  message: string;
  logger: Logger | null;
  safety?: CommitWriteSafety;
}): Promise<void> {
  const { deps, message, logger, safety } = params;
  await assertCommitWriteSafety({ deps, logger, safety });
  if (logger) logger.log('debug', 'Executing git commit');
  await deps.gitCommandRunner(['commit', '-m', message]);
  await warnIfCommittedTreeChanged({ deps, logger, safety });
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

function parseIndexEntries(text: string): IndexEntry[] {
  return text
    .split('\0')
    .filter(Boolean)
    .flatMap(function (line): IndexEntry[] {
      const separator = line.indexOf('\t');
      if (separator < 0) return [];
      const [mode, objectId, stage] = line.slice(0, separator).split(' ');
      const path = line.slice(separator + 1);
      if (!mode || !objectId || stage !== '0' || !path) return [];
      return [{ path, mode, objectId }];
    });
}

async function getIndexEntriesWithDeps(params: {
  deps: GitServiceDeps;
  logger: Logger | null;
}): Promise<IndexEntry[]> {
  const { deps, logger } = params;
  logger?.log('debug', 'Capturing git index entries');
  const result = await deps.gitCommandRunner(['ls-files', '--stage', '-z']);
  return parseIndexEntries(result.text);
}

async function amendCommitWithDeps(params: {
  deps: GitServiceDeps;
  message: string;
  logger: Logger | null;
  safety?: CommitWriteSafety;
}): Promise<void> {
  const { deps, message, logger, safety } = params;
  await assertCommitWriteSafety({ deps, logger, safety });
  logger?.log('debug', 'Executing git commit --amend');
  await deps.gitCommandRunner(['commit', '--amend', '-m', message]);
  await warnIfCommittedTreeChanged({ deps, logger, safety });
}

// An `amend!` commit carries the replacement message as an ordinary commit, so
// nothing is rewritten here. `git rebase --autosquash` folds it into the target
// later, when the user asks for it.
async function rewordCommitWithDeps(params: {
  deps: GitServiceDeps;
  target: CommitTarget;
  message: string;
  logger: Logger | null;
  safety?: CommitWriteSafety;
}): Promise<void> {
  const { deps, target, message, logger, safety } = params;
  await assertCommitWriteSafety({ deps, logger, safety });
  logger?.log('debug', `Creating amend! commit for ${target.hash}`);
  await deps.gitCommandRunner([
    'commit',
    '--allow-empty',
    '-m',
    `amend! ${target.subject}`,
    '-m',
    message,
  ]);
  await warnIfCommittedTreeChanged({ deps, logger, safety });
}

async function warnIfCommittedTreeChanged(params: {
  deps: GitServiceDeps;
  logger: Logger | null;
  safety?: CommitWriteSafety;
}): Promise<void> {
  const { deps, logger, safety } = params;
  if (!safety) return;
  try {
    const committedTree = (
      await deps.gitCommandRunner(['rev-parse', '--verify', 'HEAD^{tree}'])
    ).text.trim();
    if (committedTree === safety.snapshot.tree) return;
    const changedPaths = parseFileList(
      (
        await deps.gitCommandRunner([
          'diff',
          '--name-only',
          '-z',
          safety.snapshot.tree,
          committedTree,
        ])
      ).text,
    ).map(function (path) {
      return JSON.stringify(path);
    });
    logger?.log(
      'warn',
      'Commit completed, but pre-commit hooks changed the committed tree after analysis. Paths that differ from the analysed snapshot: ' +
        (changedPaths.join(', ') || 'the tree contents') +
        '.',
    );
  } catch {
    logger?.log(
      'warn',
      'Commit completed, but its tree could not be verified against the analysed snapshot.',
    );
  }
}

function commitSafetyRefusal(message: string): Error {
  const error = new Error(message);
  error.name = 'CommitActionRefusal';
  return error;
}

async function assertCommitWriteSafety(params: {
  deps: GitServiceDeps;
  logger: Logger | null;
  safety?: CommitWriteSafety;
}): Promise<void> {
  const { deps, logger, safety } = params;
  if (!safety) return;
  const tree = await getIndexTreeWithDeps({ deps, logger });
  if (tree !== safety.snapshot.tree) {
    throw commitSafetyRefusal(
      'Staged changes changed before the commit could be written. Regenerate the message, then try again.',
    );
  }
  if (!safety.target) return;
  const target = await inspectCommitTargetWithDeps({ deps, hash: safety.target.hash, logger });
  if (target.hash !== safety.target.hash || target.headHash !== safety.target.headHash) {
    throw commitSafetyRefusal(
      'HEAD or target commit moved before the commit could be written. Regenerate the message, then try again.',
    );
  }
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
    if (remotes.text.trim().length > 0) return true;
    const configuredRemotes = await deps.gitCommandRunner(['remote']);
    if (configuredRemotes.text.trim().length === 0) return false;
    const trackingRefs = await deps.gitCommandRunner([
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
  const [headResult, subjectResult] = await Promise.all([
    deps.gitCommandRunner(['rev-parse', '--verify', 'HEAD^{commit}']),
    deps.gitCommandRunner(['log', '-1', '--format=%s', resolved]),
  ]);
  const head = headResult.text.trim();
  const subject = subjectResult.text.trim();
  const isHead = resolved === head;
  const [ambiguity, isPublished, isAncestor, headDetached] = await Promise.all([
    readSubjectAmbiguity(deps, resolved, subject),
    isPublishedCommit(deps, resolved),
    isHead ? Promise.resolve(true) : isAncestorOfHead(deps, resolved),
    isHeadDetached(deps),
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
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
  if (status.truncated) {
    throw new Error(
      'Repository status output was truncated. Reduce the worktree size, then try again.',
    );
  }
  const parsed = parsePorcelainStatus(status.text);
  const inProgressOperation = await detectInProgressOperation(deps);
  const result: RepositoryState = { ...parsed, inProgressOperation };
  logger?.log('debug', 'Repository state', { ...result });
  return result;
}
