import { fileExists, literalPathspec, spawnGitStream } from '../git-utils.js';
import { filterExcludedFiles, shouldExcludeFile } from '../utils.js';
import { DEFAULT_ANALYSIS_EXCLUDE_PATTERNS } from '../constants.js';
import type { Logger } from '../logger.js';

interface StagedChangesResult {
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
  listCommitHashes(range: string, logger: Logger | null): Promise<string[]>;
  hasAmendment(hash: string, logger: Logger | null): Promise<boolean>;
  getHeadHash(logger: Logger | null): Promise<string>;
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

interface GitServiceOptions {
  gitCommandRunner?: GitCommandRunner;
}

export interface RepositoryState {
  hasStagedChanges: boolean;
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

function parseFileList(text: string): string[] {
  return text.split('\0').filter(path => path.length > 0);
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

export function createGitService(opts: GitServiceOptions = {}): GitService {
  const runGit: GitCommandRunner = opts.gitCommandRunner ?? spawnGitStream;
  return {
    listCommitHashes: (range, logger = null) => listCommitHashes(runGit, range, logger),
    hasAmendment: (hash, logger = null) => hasAmendment(runGit, hash, logger),
    getHeadHash: (logger = null) => getHeadHash(runGit, logger),
    retrieveStagedChanges: (commitHash, logger = null, excludePatterns = []) =>
      retrieveStagedChanges(runGit, commitHash, logger, excludePatterns),
    commitChanges: (message, logger = null, safety) =>
      commitChanges(runGit, message, logger, safety),
    amendCommit: (message, logger = null, safety) => amendCommit(runGit, message, logger, safety),
    rewordCommit: (target, message, logger = null, safety) =>
      rewordCommit(runGit, target, message, logger, safety),
    inspectCommitTarget: (hash, logger = null) => inspectCommitTarget(runGit, hash, logger),
    getIndexTree: (logger = null) => getIndexTree(runGit, logger),
    getIndexEntries: (logger = null) => getIndexEntries(runGit, logger),
    getRepositoryState: (logger = null) => getRepositoryState(runGit, logger),
  };
}

async function listCommitHashes(
  runGit: GitCommandRunner,
  range: string,
  logger: Logger | null,
): Promise<string[]> {
  logger?.log('debug', `Resolving commit range ${range}`);
  const result = await runGit([
    'log',
    '--reverse',
    '--first-parent',
    '--format=%H%x00%s%x00',
    range,
  ]);
  if (result.truncated) throw new Error('Commit range output was truncated.');
  const fields = result.text.split('\0');
  const hashes: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const hash = fields[index]?.trim();
    const subject = fields[index + 1]?.trim() ?? '';
    if (!hash || /^(amend|fixup|squash)! /.test(subject)) continue;
    hashes.push(hash);
  }
  return hashes;
}

async function hasAmendment(
  runGit: GitCommandRunner,
  hash: string,
  logger: Logger | null,
): Promise<boolean> {
  logger?.log('debug', `Checking for an existing amend! commit for ${hash}`);
  const result = await runGit([
    'log',
    '--format=%s',
    '--fixed-strings',
    `--grep=amend! ${hash}`,
    'HEAD',
  ]);
  return result.text.split('\n').some(subject => subject.trim() === `amend! ${hash}`);
}

async function getHeadHash(runGit: GitCommandRunner, logger: Logger | null): Promise<string> {
  logger?.log('debug', 'Reading HEAD');
  return (await runGit(['rev-parse', '--verify', 'HEAD^{commit}'])).text.trim();
}

async function retrieveStagedChanges(
  runGit: GitCommandRunner,
  commitHash: string | null,
  logger: Logger | null,
  excludePatterns: string[],
): Promise<StagedChangesResult | null> {
  const analysisExcludePatterns = [...DEFAULT_ANALYSIS_EXCLUDE_PATTERNS, ...excludePatterns];
  logger?.log('debug', 'Checking git status');
  const fileListRes = await runGit(buildFileListArgs(commitHash));
  if (fileListRes.truncated) {
    throw new Error('File list output was truncated. Reduce the change set, then try again.');
  }
  const allFiles = parseFileList(fileListRes.text);
  const files = filterExcludedFiles(allFiles, analysisExcludePatterns);
  const explicitlyIncludedPaths = new Set(filterExcludedFiles(allFiles, excludePatterns));
  const excludedPaths = allFiles.filter(path => !explicitlyIncludedPaths.has(path));
  const originalFileCount = allFiles.length;
  const matchedExcludePatterns = analysisExcludePatterns.filter(pattern =>
    allFiles.some(path => shouldExcludeFile(path, [pattern])),
  );
  logExcludedFiles(logger, matchedExcludePatterns, originalFileCount, files.length);
  if (files.length === 0) {
    logNoChanges(logger, commitHash);
    return null;
  }
  const diff = commitHash
    ? {
        result: await runGit([...buildDiffArgs(commitHash), '--', ...files.map(literalPathspec)], {
          allowTruncated: true,
        }),
      }
    : await readStableStagedDiff(runGit, files, logger);
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

async function readStableStagedDiff(
  runGit: GitCommandRunner,
  files: string[],
  logger: Logger | null,
): Promise<{ result: Awaited<ReturnType<GitCommandRunner>>; snapshot: IndexSnapshot }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const beforeEntries = await getIndexTree(runGit, logger);
    const entries = await getIndexEntries(runGit, logger);
    const beforeDiff = await getIndexTree(runGit, logger);
    if (beforeEntries !== beforeDiff) continue;
    const result = await runGit([...buildDiffArgs(null), '--', ...files.map(literalPathspec)], {
      allowTruncated: true,
    });
    const afterDiff = await getIndexTree(runGit, logger);
    if (beforeDiff === afterDiff) return { result, snapshot: { tree: afterDiff, entries } };
  }
  throw new Error(
    'Staged changes changed while their diff was being read. Regenerate the message, then try again.',
  );
}

async function commitChanges(
  runGit: GitCommandRunner,
  message: string,
  logger: Logger | null,
  safety?: CommitWriteSafety,
): Promise<void> {
  await assertCommitWriteSafety(runGit, logger, safety);
  if (logger) logger.log('debug', 'Executing git commit');
  await runGit(['commit', '-m', message]);
  await warnIfCommittedTreeChanged(runGit, logger, safety);
}

async function getIndexTree(runGit: GitCommandRunner, logger: Logger | null): Promise<string> {
  logger?.log('debug', 'Capturing git index tree');
  const result = await runGit(['write-tree']);
  return result.text.trim();
}

function parseIndexEntries(text: string): IndexEntry[] {
  return text
    .split('\0')
    .filter(Boolean)
    .flatMap((line): IndexEntry[] => {
      const separator = line.indexOf('\t');
      if (separator < 0) return [];
      const [mode, objectId, stage] = line.slice(0, separator).split(' ');
      const path = line.slice(separator + 1);
      if (!mode || !objectId || stage !== '0' || !path) return [];
      return [{ path, mode, objectId }];
    });
}

async function getIndexEntries(
  runGit: GitCommandRunner,
  logger: Logger | null,
): Promise<IndexEntry[]> {
  logger?.log('debug', 'Capturing git index entries');
  const result = await runGit(['ls-files', '--stage', '-z']);
  return parseIndexEntries(result.text);
}

async function amendCommit(
  runGit: GitCommandRunner,
  message: string,
  logger: Logger | null,
  safety?: CommitWriteSafety,
): Promise<void> {
  await assertCommitWriteSafety(runGit, logger, safety);
  logger?.log('debug', 'Executing git commit --amend');
  await runGit(['commit', '--amend', '-m', message]);
  await warnIfCommittedTreeChanged(runGit, logger, safety);
}

// An `amend!` commit carries the replacement message as an ordinary commit, so
// nothing is rewritten here. `git rebase --autosquash` folds it into the target
// later, when the user asks for it. Hash targeting remains unambiguous when
// multiple commits share a subject.
async function rewordCommit(
  runGit: GitCommandRunner,
  target: CommitTarget,
  message: string,
  logger: Logger | null,
  safety?: CommitWriteSafety,
): Promise<void> {
  await assertCommitWriteSafety(runGit, logger, safety);
  logger?.log('debug', `Creating amend! commit for ${target.hash}`);
  const previousHead = (await runGit(['rev-parse', '--verify', 'HEAD'])).text.trim();
  await runGit(['commit', '--allow-empty', '-m', `amend! ${target.hash}`, '-m', message]);
  try {
    await assertAmendCommitIsEmpty(runGit);
  } catch (error) {
    await rollBackUnsafeAmendCommit(runGit, previousHead);
    throw error;
  }
}

async function rollBackUnsafeAmendCommit(
  runGit: GitCommandRunner,
  previousHead: string,
): Promise<void> {
  let createdHead = 'HEAD';
  try {
    const [head, parent] = await Promise.all([
      runGit(['rev-parse', '--verify', 'HEAD']),
      runGit(['rev-parse', '--verify', 'HEAD^']),
    ]);
    createdHead = head.text.trim();
    if (parent.text.trim() !== previousHead) {
      throw new Error('HEAD parent does not match the pre-write HEAD');
    }
    await runGit(['reset', '--soft', previousHead]);
  } catch {
    throw commitSafetyRefusal(
      `The unsafe amend! commit ${createdHead} could not be rolled back automatically. ` +
        'Inspect HEAD and use git reset --soft only after confirming the target.',
    );
  }
}

async function assertAmendCommitIsEmpty(runGit: GitCommandRunner): Promise<void> {
  try {
    const [committed, parent] = await Promise.all([
      runGit(['rev-parse', '--verify', 'HEAD^{tree}']),
      runGit(['rev-parse', '--verify', 'HEAD^1^{tree}']),
    ]);
    if (committed.text.trim() === parent.text.trim()) return;
  } catch {
    throw commitSafetyRefusal(
      'The amend! commit was created, but its tree could not be verified. Batch processing must stop.',
    );
  }
  throw commitSafetyRefusal(
    'The amend! commit contains file changes introduced by a Git hook. Batch processing must stop.',
  );
}

async function warnIfCommittedTreeChanged(
  runGit: GitCommandRunner,
  logger: Logger | null,
  safety?: CommitWriteSafety,
): Promise<void> {
  if (!safety) return;
  try {
    const committedTree = (await runGit(['rev-parse', '--verify', 'HEAD^{tree}'])).text.trim();
    if (committedTree === safety.snapshot.tree) return;
    const changedPaths = parseFileList(
      (await runGit(['diff', '--name-only', '-z', safety.snapshot.tree, committedTree])).text,
    ).map(path => JSON.stringify(path));
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

async function assertCommitWriteSafety(
  runGit: GitCommandRunner,
  logger: Logger | null,
  safety?: CommitWriteSafety,
): Promise<void> {
  if (!safety) return;
  const tree = await getIndexTree(runGit, logger);
  if (tree !== safety.snapshot.tree) {
    throw commitSafetyRefusal(
      'Staged changes changed before the commit could be written. Regenerate the message, then try again.',
    );
  }
  if (!safety.target) return;
  const target = await inspectCommitTarget(runGit, safety.target.hash, logger);
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
async function isPublishedCommit(runGit: GitCommandRunner, hash: string): Promise<boolean> {
  try {
    const remotes = await runGit(['branch', '--remotes', '--contains', hash]);
    if (remotes.text.trim().length > 0) return true;
    const configuredRemotes = await runGit(['remote']);
    if (configuredRemotes.text.trim().length === 0) return false;
    const trackingRefs = await runGit(['for-each-ref', '--format=%(refname)', 'refs/remotes']);
    return trackingRefs.text.trim().length === 0;
  } catch {
    return true;
  }
}

// An `amend!` commit is created on the current branch. When the target is not
// reachable from HEAD the rebase that would fold it never sees it, so the
// commit stays behind as litter and the target keeps its old message. Compared
// through merge-base, whose answer arrives as output rather than an exit code.
async function isAncestorOfHead(runGit: GitCommandRunner, hash: string): Promise<boolean> {
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
    const twins = ancestors.text.split('\n').filter(line => line.trimEnd() === subject);
    return { hasParent: true, hasAmbiguousSubject: twins.length > 0 };
  } catch {
    return { hasParent: false, hasAmbiguousSubject: false };
  }
}

async function inspectCommitTarget(
  runGit: GitCommandRunner,
  hash: string,
  logger: Logger | null,
): Promise<CommitTarget> {
  const resolved = (await runGit(['rev-parse', '--verify', `${hash}^{commit}`])).text.trim();
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
    const record = records[index];
    if (!record) continue;
    parsePorcelainLine(record, state);
    const status = record.slice(0, 2);
    if (status.includes('R') || status.includes('C')) index += 1;
  }

  return {
    hasStagedChanges: state.hasStagedChanges,
    hasUnmergedPaths: state.hasUnmergedPaths,
    changedFiles: Array.from(state.changedFiles),
  };
}

function parsePorcelainLine(
  line: string,
  state: {
    hasStagedChanges: boolean;
    hasUnmergedPaths: boolean;
    changedFiles: Set<string>;
  },
): void {
  if (line.startsWith('?? ')) {
    addChangedPath(line.slice(3), state.changedFiles);
    return;
  }
  const x = line[0] || ' ';
  const y = line[1] || ' ';
  if (x !== ' ') state.hasStagedChanges = true;
  if (isUnmergedStatus(x, y)) state.hasUnmergedPaths = true;
  addChangedPath(line.slice(3), state.changedFiles);
}

function isUnmergedStatus(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
}

function addChangedPath(rawPathInput: string, changedFiles: Set<string>): void {
  if (rawPathInput) changedFiles.add(rawPathInput);
}

async function detectInProgressOperation(
  runGit: GitCommandRunner,
): Promise<RepositoryState['inProgressOperation']> {
  const gitDir = (await runGit(['rev-parse', '--git-dir'])).text.trim();
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

async function getRepositoryState(
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
