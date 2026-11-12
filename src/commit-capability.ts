import type {
  CommitTarget,
  IndexSnapshot,
  RepositoryState,
} from './services/git-service.js';

export interface CommitCapability {
  allowed: boolean;
  mode: 'commit' | 'amend' | 'reword';
  reason?: string;
  target?: CommitTarget;
  snapshot?: IndexSnapshot;
  excludedPaths?: string[];
  exclusionsAcknowledged?: boolean;
}

export function evaluateCommitCapability(
  repositoryState: RepositoryState,
  targetCommit: string | null,
  commitTarget: CommitTarget | null,
  allowDirectAmend = true,
): CommitCapability {
  if (repositoryState.inProgressOperation !== null) {
    return {
      allowed: false,
      mode: 'commit',
      reason: `Commit is disabled while a git ${repositoryState.inProgressOperation} is in progress. Finish or abort the operation first.`,
    };
  }
  if (targetCommit === null) {
    return { allowed: true, mode: 'commit' };
  }
  if (repositoryState.hasStagedChanges) {
    return {
      allowed: false,
      mode: 'commit',
      reason:
        'Staged changes are present. Amend and reword would carry them into the target commit, which the generated message does not describe. Unstage them first.',
    };
  }
  if (commitTarget === null) {
    return {
      allowed: false,
      mode: 'commit',
      reason: 'Commit target could not be resolved. Analysis stays read-only.',
    };
  }
  return evaluateResolvedTarget(commitTarget, allowDirectAmend);
}

function evaluateResolvedTarget(
  commitTarget: CommitTarget,
  allowDirectAmend: boolean,
): CommitCapability {
  if (commitTarget.isHeadDetached) {
    return {
      allowed: false,
      mode: 'commit',
      reason:
        'HEAD is detached. A commit made here can be orphaned as soon as another branch is checked out. Check out a branch first.',
    };
  }
  if (allowDirectAmend && commitTarget.isHead && !commitTarget.isPublished) {
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
