import type { GitCommandRunner } from '../git-utils.js';
import type { Logger } from '../logger.js';
import { inspectCommitTarget } from './git-repository-service.js';
import type {
  CommitTarget,
  CommitWriteSafety,
  IndexEntry,
} from './git-service.js';

function parseFileList(text: string): string[] {
  return text.split('\0').filter((path) => path.length > 0);
}

export async function commitChanges(
  runGit: GitCommandRunner,
  message: string,
  logger: Logger | null,
  safety?: CommitWriteSafety,
): Promise<void> {
  await assertCommitWriteSafety(runGit, logger, safety);
  if (logger !== null) {
    logger.log('debug', 'Executing git commit');
  }
  await runGit(['commit', '-m', message], {
    timeoutMs: 0,
    allowTruncated: true,
  });
  await warnIfCommittedTreeChanged(runGit, logger, safety);
}

export async function getIndexTree(
  runGit: GitCommandRunner,
  logger: Logger | null,
): Promise<string> {
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
      if (separator < 0) {
        return [];
      }
      const [mode, objectId, stage] = line.slice(0, separator).split(' ');
      const path = line.slice(separator + 1);
      if (mode === '' || objectId === '' || stage !== '0' || path === '') {
        return [];
      }
      return [{ path, mode, objectId }];
    });
}

export async function getIndexEntries(
  runGit: GitCommandRunner,
  logger: Logger | null,
): Promise<IndexEntry[]> {
  logger?.log('debug', 'Capturing git index entries');
  const result = await runGit(['ls-files', '--stage', '-z']);
  return parseIndexEntries(result.text);
}

export async function amendCommit(
  runGit: GitCommandRunner,
  message: string,
  logger: Logger | null,
  safety?: CommitWriteSafety,
): Promise<void> {
  await assertCommitWriteSafety(runGit, logger, safety);
  logger?.log('debug', 'Executing git commit --amend');
  await runGit(['commit', '--amend', '-m', message], {
    timeoutMs: 0,
    allowTruncated: true,
  });
  await warnIfCommittedTreeChanged(runGit, logger, safety);
}

// An `amend!` commit carries the replacement message as an ordinary commit, so
// nothing is rewritten here. `git rebase --autosquash` folds it into the target
// later, when the user asks for it. Hash targeting remains unambiguous when
// multiple commits share a subject.
interface RewordCommitOptions {
  runGit: GitCommandRunner;
  target: CommitTarget;
  message: string;
  logger: Logger | null;
  safety?: CommitWriteSafety;
}

export async function rewordCommit(
  options: RewordCommitOptions,
): Promise<void> {
  const { runGit, target, message, logger, safety } = options;
  await assertCommitWriteSafety(runGit, logger, safety);
  logger?.log('debug', `Creating amend! commit for ${target.hash}`);
  const previousHead = (
    await runGit(['rev-parse', '--verify', 'HEAD'])
  ).text.trim();
  await runGit(
    ['commit', '--allow-empty', '-m', `amend! ${target.hash}`, '-m', message],
    {
      timeoutMs: 0,
      allowTruncated: true,
    },
  );
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
    throw commitActionRefusal(
      `The unsafe amend! commit ${createdHead} could not be rolled back automatically. ` +
        'Inspect HEAD and use git reset --soft only after confirming the target.',
    );
  }
}

async function assertAmendCommitIsEmpty(
  runGit: GitCommandRunner,
): Promise<void> {
  try {
    const [committed, parent] = await Promise.all([
      runGit(['rev-parse', '--verify', 'HEAD^{tree}']),
      runGit(['rev-parse', '--verify', 'HEAD^1^{tree}']),
    ]);
    if (committed.text.trim() === parent.text.trim()) {
      return;
    }
  } catch {
    throw commitActionRefusal(
      'The amend! commit was created, but its tree could not be verified. Batch processing must stop.',
    );
  }
  throw commitActionRefusal(
    'The amend! commit contains file changes introduced by a Git hook. Batch processing must stop.',
  );
}

async function warnIfCommittedTreeChanged(
  runGit: GitCommandRunner,
  logger: Logger | null,
  safety?: CommitWriteSafety,
): Promise<void> {
  if (safety === undefined) {
    return;
  }
  try {
    const committedTree = (
      await runGit(['rev-parse', '--verify', 'HEAD^{tree}'])
    ).text.trim();
    if (committedTree === safety.snapshot.tree) {
      return;
    }
    const changedPaths = parseFileList(
      (
        await runGit([
          'diff',
          '--name-only',
          '-z',
          safety.snapshot.tree,
          committedTree,
        ])
      ).text,
    ).map((path) => JSON.stringify(path));
    const changedPathList = changedPaths.join(', ');
    logger?.log(
      'warn',
      `Commit completed, but pre-commit hooks changed the committed tree after analysis. Paths that differ from the analysed snapshot: ${
        changedPathList === '' ? 'the tree contents' : changedPathList
      }.`,
    );
  } catch {
    logger?.log(
      'warn',
      'Commit completed, but its tree could not be verified against the analysed snapshot.',
    );
  }
}

export function commitActionRefusal(message: string): Error {
  const error = new Error(message);
  error.name = 'CommitActionRefusal';
  return error;
}

async function assertCommitWriteSafety(
  runGit: GitCommandRunner,
  logger: Logger | null,
  safety?: CommitWriteSafety,
): Promise<void> {
  if (safety === undefined) {
    return;
  }
  const tree = await getIndexTree(runGit, logger);
  if (tree !== safety.snapshot.tree) {
    throw commitActionRefusal(
      'Staged changes changed before the commit could be written. Regenerate the message, then try again.',
    );
  }
  if (safety.target === undefined) {
    return;
  }
  const target = await inspectCommitTarget(runGit, safety.target.hash, logger);
  if (
    target.hash !== safety.target.hash ||
    target.headHash !== safety.target.headHash
  ) {
    throw commitActionRefusal(
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
