import {
  type CommitCapability,
  evaluateCommitCapability,
} from './commit-capability.js';
import type { Logger } from './logger.js';
import type {
  CommitTarget,
  CommitWriteSafety,
  GitService,
  IndexEntry,
  IndexSnapshot,
  RepositoryState,
} from './services/git-service.js';
import { commitActionRefusal } from './services/git-write-service.js';
import { hasText } from './utils.js';

const MAX_DISPLAYED_PATHS = 4;
const SHORT_HASH_LENGTH = 7;

interface CommitActionInspection {
  repositoryState: RepositoryState | null;
  capability: CommitCapability;
  observedSnapshotInvalid?: true;
}

export interface CommitActionResult {
  summary: string;
}

export interface CommitActionService {
  inspect: (
    targetHash: string | null,
    observedSnapshot?: IndexSnapshot,
  ) => Promise<CommitActionInspection>;
  apply: (
    capability: CommitCapability,
    message: string,
  ) => Promise<CommitActionResult>;
}

export function isCommitActionRefusal(error: unknown): error is Error {
  return error instanceof Error && error.name === 'CommitActionRefusal';
}

function indexIndeterminateReason(detail?: string): string {
  const suffix = hasText(detail) ? ` (${detail})` : '';
  return `Cannot safely determine the staged changes${suffix}. No commit action was taken. Resolve the Git state, regenerate the message, then try again.`;
}

export function indexEntryKey(entry: IndexEntry): string {
  return `${entry.mode}:${entry.objectId}`;
}

function describeChangedIndexPaths(
  before: IndexEntry[],
  after: IndexEntry[],
): string | null {
  const oldEntries = new Map(
    before.map((entry) => [entry.path, indexEntryKey(entry)]),
  );
  const newEntries = new Map(
    after.map((entry) => [entry.path, indexEntryKey(entry)]),
  );
  const changes: string[] = [];
  for (const path of newEntries.keys()) {
    const displayed = JSON.stringify(path);
    if (!oldEntries.has(path)) {
      changes.push(`Added: ${displayed}`);
    } else if (oldEntries.get(path) !== newEntries.get(path)) {
      changes.push(`Modified: ${displayed}`);
    }
  }
  for (const path of oldEntries.keys()) {
    if (!newEntries.has(path)) {
      changes.push(`Removed: ${JSON.stringify(path)}`);
    }
  }
  changes.sort((left, right) => left.localeCompare(right));
  if (changes.length === 0) {
    return null;
  }
  const shown = changes.slice(0, MAX_DISPLAYED_PATHS);
  const more = changes.length - shown.length;
  return more > 0
    ? `${shown.join(', ')}; ${more} more.`
    : `${shown.join(', ')}.`;
}

function describeIndexDrift(before: IndexEntry[], after: IndexEntry[]): string {
  const changedPaths = describeChangedIndexPaths(before, after);
  if (changedPaths === null) {
    return indexIndeterminateReason(
      'the changed staged paths could not be identified',
    );
  }
  return `Staged changes were modified while this message was on screen, so the message no longer describes what would be committed. ${changedPaths} Regenerate the message, review it, then commit.`;
}

export function describeExcludedPaths(paths: string[]): string {
  const shown = paths
    .slice(0, MAX_DISPLAYED_PATHS)
    .map((path) => JSON.stringify(path));
  const more = paths.length - shown.length;
  const suffix = more > 0 ? `; ${more} more` : '';
  const noun = paths.length === 1 ? 'path was' : 'paths were';
  return `${paths.length} staged ${noun} excluded from analysis and WILL still be committed:\n${shown.join(', ')}${suffix}.`;
}

async function captureIndexSnapshot(
  gitService: GitService,
  logger: Logger,
): Promise<IndexSnapshot | null> {
  const before = await gitService.getIndexTree(logger);
  const entries = await gitService.getIndexEntries(logger);
  const after = await gitService.getIndexTree(logger);
  if (before !== after) {
    return null;
  }
  return { tree: after, entries };
}

async function resolveIndexSnapshot(
  gitService: GitService,
  logger: Logger,
  observedSnapshot?: IndexSnapshot,
): Promise<{
  snapshot: IndexSnapshot | null;
  observedSnapshotChanged: boolean;
}> {
  if (observedSnapshot === undefined) {
    return {
      snapshot: await captureIndexSnapshot(gitService, logger),
      observedSnapshotChanged: false,
    };
  }
  return {
    snapshot: observedSnapshot,
    observedSnapshotChanged:
      (await gitService.getIndexTree(logger)) !== observedSnapshot.tree,
  };
}

async function inspectTarget(
  gitService: GitService,
  targetHash: string | null,
  logger: Logger,
): Promise<CommitTarget | null> {
  if (targetHash === null) {
    return null;
  }
  try {
    return await gitService.inspectCommitTarget(targetHash, logger);
  } catch (error) {
    logger.log('debug', `Could not inspect commit target: ${String(error)}`);
    return null;
  }
}

function describeRewordResult(target: CommitTarget): string {
  const short = target.hash.slice(0, SHORT_HASH_LENGTH);
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

function cannotInspectIndex(
  repositoryState: RepositoryState,
  detail?: string,
): CommitActionInspection {
  return {
    repositoryState,
    capability: {
      allowed: false,
      mode: 'commit',
      reason: indexIndeterminateReason(detail),
    },
  };
}

async function inspectRepositoryState(
  gitService: GitService,
  logger: Logger,
): Promise<RepositoryState | null> {
  try {
    return await gitService.getRepositoryState(logger);
  } catch (error) {
    logger.log('debug', `Could not inspect repository state: ${String(error)}`);
    return null;
  }
}

async function cannotVerifyObservedSnapshot(
  gitService: GitService,
  logger: Logger,
  repositoryState: RepositoryState,
): Promise<CommitActionInspection> {
  const refreshedState =
    (await inspectRepositoryState(gitService, logger)) ?? repositoryState;
  return {
    ...cannotInspectIndex(
      refreshedState,
      'the analysed index could not be verified',
    ),
    observedSnapshotInvalid: true,
  };
}

async function inspectTargetCapability(options: {
  gitService: GitService;
  logger: Logger;
  targetHash: string | null;
  snapshot: IndexSnapshot;
  allowDirectAmend: boolean;
}): Promise<CommitActionInspection> {
  const { gitService, logger, targetHash, snapshot, allowDirectAmend } =
    options;
  const repositoryState = await inspectRepositoryState(gitService, logger);
  if (repositoryState === null) {
    return cannotInspectRepository();
  }
  if (repositoryState.hasUnmergedPaths) {
    return cannotInspectIndex(repositoryState, 'Git has unresolved conflicts');
  }
  const target = await inspectTarget(gitService, targetHash, logger);
  return {
    repositoryState,
    capability: {
      ...evaluateCommitCapability(
        repositoryState,
        targetHash,
        target,
        allowDirectAmend,
      ),
      snapshot,
    },
  };
}

async function writeCommitAction(params: {
  gitService: GitService;
  logger: Logger;
  capability: CommitCapability;
  safety: CommitWriteSafety;
  message: string;
}): Promise<CommitActionResult> {
  const { gitService, logger, capability, safety, message } = params;
  if (capability.mode === 'amend') {
    await gitService.amendCommit(message, logger, safety);
    return { summary: 'HEAD amended.' };
  }
  if (capability.mode === 'reword' && capability.target !== undefined) {
    await gitService.rewordCommit(capability.target, message, logger, safety);
    return { summary: describeRewordResult(capability.target) };
  }
  await gitService.commitChanges(message, logger, safety);
  return { summary: 'Commit successfully created!' };
}

function validateRevalidatedCapability(
  original: CommitCapability & { snapshot: IndexSnapshot },
  revalidated: CommitActionInspection,
): CommitCapability {
  const {
    capability: {
      snapshot: refreshedSnapshot,
      allowed,
      reason,
      mode,
      target: refreshedTarget,
    },
  } = revalidated;
  const {
    snapshot: originalSnapshot,
    mode: originalMode,
    target: originalTarget,
  } = original;
  if (revalidated.repositoryState === null || refreshedSnapshot === undefined) {
    throw commitActionRefusal(reason ?? indexIndeterminateReason());
  }
  if (refreshedSnapshot.tree !== originalSnapshot.tree) {
    throw commitActionRefusal(
      describeIndexDrift(originalSnapshot.entries, refreshedSnapshot.entries),
    );
  }
  if (!allowed) {
    throw commitActionRefusal(
      reason ?? 'The repository changed and the action is no longer available.',
    );
  }
  if (mode !== originalMode) {
    throw commitActionRefusal(
      `The repository changed since generation: the action would now be a ${mode}, not a ${originalMode}. Run again.`,
    );
  }
  if (hasTargetMoved(originalTarget, refreshedTarget)) {
    throw commitActionRefusal(
      'HEAD or target commit moved since generation. Regenerate the message, then try again.',
    );
  }
  return revalidated.capability;
}

function hasTargetMoved(
  original: CommitTarget | undefined,
  refreshed: CommitTarget | undefined,
): boolean {
  return (
    original !== undefined &&
    (refreshed?.hash !== original.hash ||
      refreshed.headHash !== original.headHash)
  );
}

async function inspectSnapshot(options: {
  gitService: GitService;
  logger: Logger;
  repositoryState: RepositoryState;
  observedSnapshot?: IndexSnapshot;
}): Promise<
  { snapshot: IndexSnapshot | null } | { failure: CommitActionInspection }
> {
  const { gitService, logger, repositoryState, observedSnapshot } = options;
  try {
    const resolved = await resolveIndexSnapshot(
      gitService,
      logger,
      observedSnapshot,
    );
    if (resolved.observedSnapshotChanged) {
      return {
        failure: {
          ...cannotInspectIndex(
            repositoryState,
            'the index changed after its diff was read',
          ),
          observedSnapshotInvalid: true,
        },
      };
    }
    return { snapshot: resolved.snapshot };
  } catch (error) {
    logger.log('debug', `Could not capture index snapshot: ${String(error)}`);
    if (observedSnapshot !== undefined) {
      return {
        failure: await cannotVerifyObservedSnapshot(
          gitService,
          logger,
          repositoryState,
        ),
      };
    }
    return { failure: cannotInspectIndex(repositoryState) };
  }
}

export function createCommitActionService(params: {
  gitService: GitService;
  logger: Logger;
  allowDirectAmend?: boolean;
}): CommitActionService {
  const { gitService, logger, allowDirectAmend = true } = params;

  async function inspect(
    targetHash: string | null,
    observedSnapshot?: IndexSnapshot,
  ): Promise<CommitActionInspection> {
    const repositoryState = await inspectRepositoryState(gitService, logger);
    if (repositoryState === null) {
      return cannotInspectRepository();
    }
    if (repositoryState.hasUnmergedPaths) {
      return cannotInspectIndex(
        repositoryState,
        'Git has unresolved conflicts',
      );
    }
    const snapshotInspection = await inspectSnapshot({
      gitService,
      logger,
      repositoryState,
      observedSnapshot,
    });
    if ('failure' in snapshotInspection) {
      return snapshotInspection.failure;
    }
    const { snapshot } = snapshotInspection;
    if (snapshot === null) {
      return cannotInspectIndex(
        repositoryState,
        'the index changed while it was being checked',
      );
    }
    return await inspectTargetCapability({
      gitService,
      logger,
      targetHash,
      snapshot,
      allowDirectAmend,
    });
  }

  async function apply(
    capability: CommitCapability,
    message: string,
  ): Promise<CommitActionResult> {
    if (!capability.allowed) {
      throw commitActionRefusal(
        capability.reason ?? 'Commit action is unavailable.',
      );
    }
    if (capability.snapshot === undefined) {
      throw commitActionRefusal(
        indexIndeterminateReason('the original staged snapshot is missing'),
      );
    }
    if (
      capability.excludedPaths !== undefined &&
      capability.excludedPaths.length > 0 &&
      capability.exclusionsAcknowledged !== true
    ) {
      throw commitActionRefusal(
        `Explicit confirmation is required before committing excluded staged paths. ${describeExcludedPaths(capability.excludedPaths)}`,
      );
    }

    const originalCapability = { ...capability, snapshot: capability.snapshot };
    const revalidated = validateRevalidatedCapability(
      originalCapability,
      await inspect(capability.target?.hash ?? null),
    );
    return await writeCommitAction({
      gitService,
      logger,
      capability: revalidated,
      safety: { snapshot: capability.snapshot, target: capability.target },
      message,
    });
  }

  return { inspect, apply };
}
