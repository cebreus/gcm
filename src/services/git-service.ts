import {
  DEFAULT_ANALYSIS_EXCLUDE_PATTERNS,
  SECRET_FILE_EXCLUDE_PATTERNS,
} from '../constants.js';
import {
  type GitCommandRunner,
  type SpawnGitStreamResult,
  literalPathspec,
  spawnGitStream,
} from '../git-utils.js';
import type { Logger } from '../logger.js';
import { shouldExcludeFile } from '../utils.js';
import {
  getRepositoryState,
  inspectCommitTarget,
} from './git-repository-service.js';
import {
  amendCommit,
  commitChanges,
  getIndexEntries,
  getIndexTree,
  rewordCommit,
} from './git-write-service.js';

export interface StagedChangesResult {
  stagedDiff: string;
  stagedFiles: string[];
  excludedPaths?: string[];
  projectExcludesMatched?: boolean;
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
  listCommitHashes: (range: string, logger: Logger | null) => Promise<string[]>;
  hasAmendment: (hash: string, logger: Logger | null) => Promise<boolean>;
  getHeadHash: (logger: Logger | null) => Promise<string>;
  retrieveStagedChanges: (
    commitHash: string | null,
    logger: Logger | null,
    excludePatterns?: string[],
    analysisExcludePatterns?: string[],
  ) => Promise<StagedChangesResult | null>;
  commitChanges: (
    message: string,
    logger: Logger | null,
    safety?: CommitWriteSafety,
  ) => Promise<void>;
  amendCommit: (
    message: string,
    logger: Logger | null,
    safety?: CommitWriteSafety,
  ) => Promise<void>;
  rewordCommit: (
    target: CommitTarget,
    message: string,
    logger: Logger | null,
    safety?: CommitWriteSafety,
  ) => Promise<void>;
  inspectCommitTarget: (
    hash: string,
    logger: Logger | null,
  ) => Promise<CommitTarget>;
  getIndexTree: (logger: Logger | null) => Promise<string>;
  getIndexEntries: (logger: Logger | null) => Promise<IndexEntry[]>;
  getRepositoryState: (logger: Logger | null) => Promise<RepositoryState>;
}

const RENAME_ENTRY_FIELD_COUNT = 2;
const COMMIT_LOG_FIELD_COUNT = 2;
const INDEX_STABILITY_ATTEMPTS = 2;

interface GitServiceOptions {
  gitCommandRunner?: GitCommandRunner;
  maxBytes?: number;
}

export interface RepositoryState {
  hasStagedChanges: boolean;
  hasUnmergedPaths: boolean;
  inProgressOperation:
    null | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';
  changedFiles: string[];
}

function buildFileListArgs(commitHash: string | null): string[] {
  return commitHash === null
    ? ['diff', '--staged', '--name-status', '-z', '--find-renames']
    : [
        'show',
        '--first-parent',
        '--name-status',
        '--pretty=format:',
        '-z',
        '--find-renames',
        commitHash,
      ];
}

function buildDiffArgs(
  commitHash: string | null,
  ignoreWhitespace = true,
): string[] {
  const plain = [
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
  ];
  const w = ignoreWhitespace ? ['-w'] : [];
  return commitHash === null
    ? ['diff', '--staged', ...w, ...plain]
    : ['show', '--first-parent', ...w, ...plain, commitHash];
}

// `-w` keeps noise down, but empties a whitespace-only change (indentation is meaning in YAML/Python).
async function readDiff(
  runGit: GitCommandRunner,
  commitHash: string | null,
  pathspec: string[],
): Promise<SpawnGitStreamResult> {
  const read = async (
    ignoreWhitespace: boolean,
  ): Promise<SpawnGitStreamResult> =>
    await runGit(
      [
        ...buildDiffArgs(commitHash, ignoreWhitespace),
        '--',
        ...pathspec.map(literalPathspec),
      ],
      {
        allowTruncated: true,
      },
    );
  const result = await read(true);
  // `git show` prints the commit message even when the `-w` diff is empty.
  const empty =
    commitHash === null
      ? result.text.trim() === ''
      : !/^diff --git /mv.test(result.text);
  return empty ? await read(false) : result;
}

interface FileEntry {
  path: string;
  origin?: string;
}

// `--name-status -z` prints `S\0path\0`, or `Rnnn\0old\0new\0` / `Cnnn\0src\0dst\0`.
function parseFileEntries(text: string): FileEntry[] {
  const fields = text.split('\0');
  const entries: FileEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index].trim();
    if (status === '') {
      continue;
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const [from, to] = [
        fields[index + 1],
        fields[index + RENAME_ENTRY_FIELD_COUNT],
      ];
      if (to !== '') {
        entries.push(
          status.startsWith('R') ? { path: to, origin: from } : { path: to },
        );
      }
      index += RENAME_ENTRY_FIELD_COUNT;
    } else {
      if (fields[index + 1] !== '') {
        entries.push({ path: fields[index + 1] });
      }
      index += 1;
    }
  }
  return entries;
}

function logExcludedFiles(
  logger: Logger | null,
  excludePatterns: string[],
  originalFileCount: number,
  filteredFileCount: number,
): void {
  if (excludePatterns.length === 0 || filteredFileCount >= originalFileCount) {
    return;
  }
  const excludedCount = originalFileCount - filteredFileCount;
  logger?.log(
    'info',
    `Excluded ${excludedCount} file(s) matching patterns: ${excludePatterns.join(', ')}`,
  );
}

function logNoChanges(logger: Logger | null, commitHash: string | null): void {
  if (commitHash === null) {
    logger?.log('debug', 'No staged changes found.');
  } else {
    logger?.log('debug', `No changes found in commit ${commitHash}.`);
  }
}

export function createGitService(opts: GitServiceOptions = {}): GitService {
  const runGit: GitCommandRunner =
    opts.gitCommandRunner ??
    async function (args, options) {
      return await spawnGitStream(args, {
        ...options,
        maxBytes: opts.maxBytes,
      });
    };
  return {
    listCommitHashes: async (range, logger) =>
      await listCommitHashes(runGit, range, logger),
    hasAmendment: async (hash, logger) =>
      await hasAmendment(runGit, hash, logger),
    getHeadHash: async (logger) => await getHeadHash(runGit, logger),
    retrieveStagedChanges: async (
      commitHash,
      logger,
      excludePatterns = [],
      analysisExcludePatterns = [],
    ) =>
      await retrieveStagedChanges({
        runGit,
        commitHash,
        logger,
        excludePatterns,
        projectExcludePatterns: analysisExcludePatterns,
      }),
    commitChanges: async (message, logger, safety) => {
      await commitChanges(runGit, message, logger, safety);
    },
    amendCommit: async (message, logger, safety) => {
      await amendCommit(runGit, message, logger, safety);
    },
    rewordCommit: async (target, message, logger, safety) => {
      await rewordCommit({ runGit, target, message, logger, safety });
    },
    inspectCommitTarget: async (hash, logger) =>
      await inspectCommitTarget(runGit, hash, logger),
    getIndexTree: async (logger) => await getIndexTree(runGit, logger),
    getIndexEntries: async (logger) => await getIndexEntries(runGit, logger),
    getRepositoryState: async (logger) =>
      await getRepositoryState(runGit, logger),
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
  if (result.truncated) {
    throw new Error('Commit range output was truncated.');
  }
  const fields = result.text.split('\0');
  const hashes: string[] = [];
  for (
    let index = 0;
    index + 1 < fields.length;
    index += COMMIT_LOG_FIELD_COUNT
  ) {
    const hash = fields[index]?.trim();
    const subject = fields[index + 1]?.trim() ?? '';
    if (hash === '' || /^(?:amend|fixup|squash)! /v.test(subject)) {
      continue;
    }
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
  return result.text
    .split('\n')
    .some((subject) => subject.trim() === `amend! ${hash}`);
}

async function getHeadHash(
  runGit: GitCommandRunner,
  logger: Logger | null,
): Promise<string> {
  logger?.log('debug', 'Reading HEAD');
  return (await runGit(['rev-parse', '--verify', 'HEAD^{commit}'])).text.trim();
}

interface RetrieveStagedChangesOptions {
  runGit: GitCommandRunner;
  commitHash: string | null;
  logger: Logger | null;
  excludePatterns: string[];
  projectExcludePatterns: string[];
}

async function retrieveStagedChanges(
  options: RetrieveStagedChangesOptions,
): Promise<StagedChangesResult | null> {
  const {
    runGit,
    commitHash,
    logger,
    excludePatterns,
    projectExcludePatterns,
  } = options;
  const analysisExcludePatterns = [
    ...DEFAULT_ANALYSIS_EXCLUDE_PATTERNS,
    ...projectExcludePatterns,
    ...excludePatterns,
  ];
  logger?.log('debug', 'Checking git status');
  const fileListRes = await runGit(buildFileListArgs(commitHash));
  if (fileListRes.truncated) {
    throw new Error(
      'File list output was truncated. Reduce the change set, then try again.',
    );
  }
  const entries = parseFileEntries(fileListRes.text);
  const isExcluded = (entry: FileEntry, patterns: string[]): boolean =>
    shouldExcludeFile(entry.path, patterns) ||
    (entry.origin !== undefined && shouldExcludeFile(entry.origin, patterns));
  const kept = entries.filter(
    (entry) => !isExcluded(entry, analysisExcludePatterns),
  );
  const files = kept.map((entry) => entry.path);
  // Git needs both rename endpoints in the pathspec to print `rename from/to`.
  const pathspec = kept.flatMap((entry) =>
    entry.origin === undefined ? [entry.path] : [entry.path, entry.origin],
  );
  const excludedPaths = entries
    .filter((entry) =>
      isExcluded(entry, [...SECRET_FILE_EXCLUDE_PATTERNS, ...excludePatterns]),
    )
    .map((entry) => entry.path);
  const projectExcludesMatched = projectExcludePatterns.some((pattern) =>
    entries.some((entry) => isExcluded(entry, [pattern])),
  );
  const matchedExcludePatterns = analysisExcludePatterns.filter((pattern) =>
    entries.some((entry) => isExcluded(entry, [pattern])),
  );
  logExcludedFiles(
    logger,
    matchedExcludePatterns,
    entries.length,
    files.length,
  );
  if (files.length === 0) {
    // Only reported exclusions (secret defaults, --exclude) mean "staged, but nothing to analyse".
    if (excludedPaths.length > 0) {
      return {
        stagedDiff: '',
        stagedFiles: [],
        excludedPaths,
        projectExcludesMatched,
        truncated: false,
      };
    }
    logNoChanges(logger, commitHash);
    return null;
  }
  const diff =
    commitHash === null
      ? await readStableStagedDiff(runGit, pathspec, logger)
      : { result: await readDiff(runGit, commitHash, pathspec) };
  const { result: diffRes } = diff;
  if (diffRes.truncated) {
    logger?.log('warn', 'Diff output was truncated due to size limits.');
  }
  return {
    stagedDiff: diffRes.text,
    stagedFiles: files,
    excludedPaths,
    projectExcludesMatched,
    truncated: diffRes.truncated,
    snapshot: 'snapshot' in diff ? diff.snapshot : undefined,
  };
}

async function readStableStagedDiff(
  runGit: GitCommandRunner,
  pathspec: string[],
  logger: Logger | null,
): Promise<{
  result: SpawnGitStreamResult;
  snapshot: IndexSnapshot;
}> {
  for (let attempt = 0; attempt < INDEX_STABILITY_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- each attempt must observe one ordered Git index snapshot
    const beforeEntries = await getIndexTree(runGit, logger);
    // eslint-disable-next-line no-await-in-loop -- index entries must follow the first tree observation
    const entries = await getIndexEntries(runGit, logger);
    // eslint-disable-next-line no-await-in-loop -- second tree observation validates captured entries
    const beforeDiff = await getIndexTree(runGit, logger);
    if (beforeEntries !== beforeDiff) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- diff must follow a stable pre-read index observation
    const result = await readDiff(runGit, null, pathspec);
    // eslint-disable-next-line no-await-in-loop -- final tree observation validates the ordered diff read
    const afterDiff = await getIndexTree(runGit, logger);
    if (beforeDiff === afterDiff) {
      return { result, snapshot: { tree: afterDiff, entries } };
    }
  }
  throw new Error(
    'Staged changes changed while their diff was being read. Regenerate the message, then try again.',
  );
}
