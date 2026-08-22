import type { Logger } from './logger.js';
import type {
  CommitTarget,
  CommitWriteSafety,
  GitService,
  IndexEntry,
  IndexSnapshot,
  RepositoryState,
} from './services/git-service.js';

export type { IndexEntry } from './services/git-service.js';
export type { IndexSnapshot } from './services/git-service.js';

export interface CommitCapability {
  allowed: boolean;
  mode: 'commit' | 'amend' | 'reword';
  reason?: string;
  target?: CommitTarget;
  snapshot?: IndexSnapshot;
  excludedPaths?: string[];
  exclusionsAcknowledged?: boolean;
}

export interface CommitActionInspection {
  repositoryState: RepositoryState | null;
  capability: CommitCapability;
}

export interface CommitActionService {
  inspect(targetHash: string | null, observedSnapshot?: IndexSnapshot): Promise<CommitActionInspection>;
  apply(capability: CommitCapability, message: string): Promise<{ summary: string }>;
}

export function isCommitActionRefusal(error: unknown): error is Error {
  return error instanceof Error && error.name === 'CommitActionRefusal';
}

function refusal(message: string): Error {
  const error = new Error(message);
  error.name = 'CommitActionRefusal';
  return error;
}

function indexIndeterminateReason(detail?: string): string {
  const suffix = detail ? ` (${detail})` : '';
  return `Cannot safely determine the staged changes${suffix}. No commit action was taken. Resolve the Git state, regenerate the message, then try again.`;
}

function indexEntryKey(entry: IndexEntry): string {
  return `${entry.mode}:${entry.objectId}`;
}

function describeChangedIndexPaths(before: IndexEntry[], after: IndexEntry[]): string | null {
  const oldEntries = new Map(before.map(function (entry) {
    return [entry.path, indexEntryKey(entry)];
  }));
  const newEntries = new Map(after.map(function (entry) {
    return [entry.path, indexEntryKey(entry)];
  }));
  const changes: string[] = [];
  for (const path of newEntries.keys()) {
    const displayed = JSON.stringify(path);
    if (!oldEntries.has(path)) changes.push(`Added: ${displayed}`);
    else if (oldEntries.get(path) !== newEntries.get(path)) changes.push(`Modified: ${displayed}`);
  }
  for (const path of oldEntries.keys()) {
    if (!newEntries.has(path)) changes.push(`Removed: ${JSON.stringify(path)}`);
  }
  changes.sort(function (left, right) {
    return left.localeCompare(right);
  });
  if (changes.length === 0) return null;
  const shown = changes.slice(0, 4);
  const more = changes.length - shown.length;
  return more > 0 ? `${shown.join(', ')}; ${more} more.` : `${shown.join(', ')}.`;
}

function describeIndexDrift(before: IndexEntry[], after: IndexEntry[]): string {
  const changedPaths = describeChangedIndexPaths(before, after);
  if (!changedPaths) return indexIndeterminateReason('the changed staged paths could not be identified');
  return `Staged changes were modified while this message was on screen, so the message no longer describes what would be committed. ${changedPaths} Regenerate the message, review it, then commit.`;
}

export function describeExcludedPaths(paths: string[]): string {
  const shown = paths.slice(0, 4).map(function (path) {
    return JSON.stringify(path);
  });
  const more = paths.length - shown.length;
  const suffix = more > 0 ? `; ${more} more` : '';
  const noun = paths.length === 1 ? 'path was' : 'paths were';
  return `${paths.length} staged ${noun} excluded from analysis and WILL still be committed:\n${shown.join(', ')}${suffix}.`;
}

export function evaluateCommitCapability(
  repositoryState: RepositoryState,
  targetCommit: string | null,
  commitTarget: CommitTarget | null,
): CommitCapability {
  if (repositoryState.inProgressOperation) {
    return {
      allowed: false,
      mode: 'commit',
      reason: `Commit is disabled while a git ${repositoryState.inProgressOperation} is in progress. Finish or abort the operation first.`,
    };
  }
  if (!targetCommit) return { allowed: true, mode: 'commit' };
  if (repositoryState.hasStagedChanges) {
    return {
      allowed: false,
      mode: 'commit',
      reason:
        'Staged changes are present. Amend and reword would carry them into the target commit, which the generated message does not describe. Unstage them first.',
    };
  }
  if (!commitTarget) {
    return {
      allowed: false,
      mode: 'commit',
      reason: 'Commit target could not be resolved. Analysis stays read-only.',
    };
  }
  if (commitTarget.isHeadDetached) {
    return {
      allowed: false,
      mode: 'commit',
      reason:
        'HEAD is detached. A commit made here is orphaned as soon as another branch is checked out. Check out a branch first.',
    };
  }
  if (commitTarget.isHead && !commitTarget.isPublished) {
    return { allowed: true, mode: 'amend', target: commitTarget };
  }
  if (!commitTarget.isAncestorOfHead) {
    return {
      allowed: false,
      mode: 'commit',
      reason:
        'The target commit is not reachable from HEAD. An amend! commit would land on this branch and never reach it. Check out a branch that contains the commit.',
    };
  }
  return { allowed: true, mode: 'reword', target: commitTarget };
}

async function captureIndexSnapshot(
  gitService: GitService,
  logger: Logger,
): Promise<IndexSnapshot | null> {
  const before = await gitService.getIndexTree(logger);
  const entries = await gitService.getIndexEntries(logger);
  const after = await gitService.getIndexTree(logger);
  if (before !== after) return null;
  return { tree: after, entries };
}

async function inspectTarget(
  gitService: GitService,
  targetHash: string | null,
  logger: Logger,
): Promise<CommitTarget | null> {
  if (!targetHash) return null;
  try {
    return await gitService.inspectCommitTarget(targetHash, logger);
  } catch (error) {
    logger.log('debug', `Could not inspect commit target: ${error}`);
    return null;
  }
}

function describeRewordResult(target: CommitTarget): string {
  const short = target.hash.slice(0, 7);
  const base = target.hasParent ? `${short}~1` : '--root';
  const lines = [
    `amend! commit created for ${short}. History is untouched until you fold it in:`,
    `  git rebase --autosquash ${base}`,
  ];
  if (target.hasAmbiguousSubject) {
    lines.push(
      `An older commit shares the subject "${target.subject}". Use exactly this base: a wider one folds the message into that commit instead.`,
    );
  }
  if (target.isPublished) {
    lines.push(
      'This commit is already on a remote branch. Folding the amend! commit in rewrites published history.',
    );
  }
  return lines.join('\n');
}

function cannotInspectRepository(): CommitActionInspection {
  return {
    repositoryState: null,
    capability: {
      allowed: false,
      mode: 'commit',
      reason: indexIndeterminateReason(),
    },
  };
}

function cannotInspectIndex(repositoryState: RepositoryState, detail?: string): CommitActionInspection {
  return {
    repositoryState,
    capability: { allowed: false, mode: 'commit', reason: indexIndeterminateReason(detail) },
  };
}

async function writeCommitAction(params: {
  gitService: GitService;
  logger: Logger;
  capability: CommitCapability;
  safety: CommitWriteSafety;
  message: string;
}): Promise<{ summary: string }> {
  const { gitService, logger, capability, safety, message } = params;
  if (capability.mode === 'amend') {
    await gitService.amendCommit(message, logger, safety);
    return { summary: 'HEAD amended.' };
  }
  if (capability.mode === 'reword' && capability.target) {
    await gitService.rewordCommit(capability.target, message, logger, safety);
    return { summary: describeRewordResult(capability.target) };
  }
  await gitService.commitChanges(message, logger, safety);
  return { summary: 'Commit successfully created!' };
}

export function createCommitActionService(params: {
  gitService: GitService;
  logger: Logger;
}): CommitActionService {
  const { gitService, logger } = params;

  async function inspect(
    targetHash: string | null,
    observedSnapshot?: IndexSnapshot,
  ): Promise<CommitActionInspection> {
    let repositoryState: RepositoryState;
    try {
      repositoryState = await gitService.getRepositoryState(logger);
    } catch (error) {
      logger.log('debug', `Could not inspect repository state: ${error}`);
      return cannotInspectRepository();
    }
    if (repositoryState.inProgressOperation || repositoryState.hasUnmergedPaths) {
      return cannotInspectIndex(repositoryState, 'Git has an unfinished operation or unresolved conflicts');
    }
    let snapshot: IndexSnapshot | null;
    try {
      snapshot = observedSnapshot ?? (await captureIndexSnapshot(gitService, logger));
    } catch (error) {
      logger.log('debug', `Could not capture index snapshot: ${error}`);
      return cannotInspectIndex(repositoryState);
    }
    if (!snapshot) return cannotInspectIndex(repositoryState, 'the index changed while it was being checked');
    const target = await inspectTarget(gitService, targetHash, logger);
    return {
      repositoryState,
      capability: { ...evaluateCommitCapability(repositoryState, targetHash, target), snapshot },
    };
  }

  async function apply(capability: CommitCapability, message: string): Promise<{ summary: string }> {
    if (!capability.allowed) throw refusal(capability.reason ?? 'Commit action is unavailable.');
    if (!capability.snapshot) throw refusal(indexIndeterminateReason('the original staged snapshot is missing'));
    if (capability.excludedPaths?.length && !capability.exclusionsAcknowledged) {
      throw refusal(
        `Explicit confirmation is required before committing excluded staged paths. ${describeExcludedPaths(capability.excludedPaths)}`,
      );
    }

    const revalidated = await inspect(capability.target?.hash ?? null);
    if (!revalidated.repositoryState || !revalidated.capability.snapshot) {
      throw refusal(revalidated.capability.reason ?? indexIndeterminateReason());
    }
    if (revalidated.capability.snapshot.tree !== capability.snapshot.tree) {
      throw refusal(describeIndexDrift(capability.snapshot.entries, revalidated.capability.snapshot.entries));
    }
    if (!revalidated.capability.allowed) {
      throw refusal(revalidated.capability.reason ?? 'The repository changed and the action is no longer available.');
    }
    if (revalidated.capability.mode !== capability.mode) {
      throw refusal(
        `The repository changed since generation: the action would now be a ${revalidated.capability.mode}, not a ${capability.mode}. Run again.`,
      );
    }
    if (
      capability.target &&
      (!revalidated.capability.target ||
        revalidated.capability.target.hash !== capability.target.hash ||
        revalidated.capability.target.headHash !== capability.target.headHash)
    ) {
      throw refusal('HEAD or target commit moved since generation. Regenerate the message, then try again.');
    }
    return writeCommitAction({
      gitService,
      logger,
      capability: revalidated.capability,
      safety: { snapshot: capability.snapshot, target: capability.target },
      message,
    });
  }

  return { inspect, apply };
}
