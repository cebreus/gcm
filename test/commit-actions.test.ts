import { describe, expect, mock, test } from 'bun:test';

import { evaluateCommitCapability } from '../src/commit-action-service.js';
import { createGitService } from '../src/services/git-service.js';
import type { CommitTarget, RepositoryState } from '../src/services/git-service.js';

function createRecorder(responses: Record<string, string> = {}) {
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    const key = args.join(' ');
    const matched = Object.keys(responses).find(prefix => key.startsWith(prefix));
    if (matched === undefined) throw new Error(`git ${key} failed: fatal: no such thing`);
    return { text: responses[matched], truncated: false };
  };
  return { calls, runner };
}

const TARGET: CommitTarget = {
  hash: 'a'.repeat(40),
  headHash: 'b'.repeat(40),
  subject: 'feat: original subject',
  isHead: false,
  isPublished: false,
  isAncestorOfHead: true,
  isHeadDetached: false,
  hasParent: true,
  hasAmbiguousSubject: false,
};

describe('commit actions', () => {
  test('freezes first-parent range targets and excludes autosquash commits', async () => {
    const first = '1'.repeat(40);
    const fixup = '2'.repeat(40);
    const second = '3'.repeat(40);
    const { calls, runner } = createRecorder({
      log: `${first}\0feat: first\0${fixup}\0amend! ${first}\0${second}\0fix: second\0`,
    });
    const service = createGitService({ gitCommandRunner: runner });

    const hashes = await service.listCommitHashes?.('base^..HEAD', null);

    expect(hashes).toEqual([first, second]);
    expect(calls[0]).toEqual([
      'log',
      '--reverse',
      '--first-parent',
      '--format=%H%x00%s%x00',
      'base^..HEAD',
    ]);
  });

  test('detects an existing exact amend marker and reads HEAD', async () => {
    const target = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const { runner } = createRecorder({
      log: `other\namend! ${target}\n`,
      'rev-parse --verify HEAD': `${head}\n`,
    });
    const service = createGitService({ gitCommandRunner: runner });

    expect(await service.hasAmendment?.(target, null)).toBe(true);
    expect(await service.getHeadHash?.(null)).toBe(head);
  });

  test('refuses a truncated repository status', async () => {
    const gitService = createGitService({
      gitCommandRunner: async function (args) {
        if (args[0] === 'status') {
          return { text: 'M  visible.ts\n', truncated: true };
        }
        throw new Error(`unexpected git command: ${args.join(' ')}`);
      },
    });

    await expect(gitService.getRepositoryState(null)).rejects.toThrow(
      'Repository status output was truncated',
    );
  });

  test('parses NUL-delimited status paths literally, including rename destinations', async () => {
    const { calls, runner } = createRecorder({
      'status --porcelain=v1 -z':
        'M  line\nname.ts\0R  new name.ts\0old name.ts\0?? trailing .ts \0',
      'rev-parse --git-dir': '.git\n',
    });
    const service = createGitService({ gitCommandRunner: runner });

    const state = await service.getRepositoryState(null);

    expect(calls[0]).toEqual(['status', '--porcelain=v1', '-z']);
    expect(state.changedFiles).toEqual(['line\nname.ts', 'new name.ts', 'trailing .ts ']);
    expect(state.hasStagedChanges).toBe(true);
    expect(state.hasUntrackedFiles).toBe(true);
  });

  test('binds a staged diff to a stable index snapshot after one retry', async () => {
    let treeRead = 0;
    let diffRead = 0;
    const { calls, runner } = createRecorder({
      'diff --staged --name-only': 'first.ts\n',
      'ls-files --stage -z': '100644 1111111111111111111111111111111111111111 0\tfirst.ts\0',
      'diff --staged -w': 'diff --git a/first.ts b/first.ts\n',
    });
    const gitService = createGitService({
      gitCommandRunner: async function (args) {
        if (args[0] === 'write-tree') {
          treeRead += 1;
          return {
            text:
              treeRead === 3 ? 'second-tree\n' : treeRead < 3 ? 'first-tree\n' : 'second-tree\n',
            truncated: false,
          };
        }
        if (args[0] === 'diff' && !args.includes('--name-only')) diffRead += 1;
        return runner(args);
      },
    });

    const staged = await gitService.retrieveStagedChanges(null, null);

    expect(staged?.snapshot).toEqual({
      tree: 'second-tree',
      entries: [{ path: 'first.ts', mode: '100644', objectId: '1'.repeat(40) }],
    });
    expect(diffRead).toBe(2);
    expect(treeRead).toBe(6);
  });

  test('refuses a staged diff that remains unstable after one retry', async () => {
    let treeRead = 0;
    const { runner } = createRecorder({
      'diff --staged --name-only': 'first.ts\n',
      'ls-files --stage -z': '100644 1111111111111111111111111111111111111111 0\tfirst.ts\0',
      'diff --staged -w': 'diff --git a/first.ts b/first.ts\n',
    });
    const gitService = createGitService({
      gitCommandRunner: async function (args) {
        if (args[0] === 'write-tree') {
          treeRead += 1;
          return {
            text:
              [
                'first-tree',
                'first-tree',
                'second-tree',
                'second-tree',
                'second-tree',
                'third-tree',
              ][treeRead - 1] ?? '',
            truncated: false,
          };
        }
        return runner(args);
      },
    });

    await expect(gitService.retrieveStagedChanges(null, null)).rejects.toThrow(
      'Staged changes changed while their diff was being read',
    );
  });

  test('amend rewrites the message of HEAD', async () => {
    const { calls, runner } = createRecorder({
      commit: '',
      'rev-parse --verify HEAD^{tree}': 'tree',
      'rev-parse --verify HEAD^1^{tree}': 'tree',
    });
    const service = createGitService({ gitCommandRunner: runner });

    await service.amendCommit('feat(scope): new subject', null);

    expect(calls).toEqual([['commit', '--amend', '-m', 'feat(scope): new subject']]);
  });

  test('refuses an index mutation at the delegated write boundary', async () => {
    let writeEntered = false;
    const service = createGitService({
      gitCommandRunner: async function (args) {
        if (args[0] === 'write-tree') return { text: 'changed-tree\n', truncated: false };
        if (args[0] === 'commit') writeEntered = true;
        return { text: '', truncated: false };
      },
    });

    await expect(
      service.commitChanges('feat: first', null, {
        snapshot: { tree: 'original-tree', entries: [] },
      }),
    ).rejects.toThrow('Staged changes changed before the commit could be written');
    expect(writeEntered).toBe(false);
  });

  test('refuses a moved HEAD at the delegated amend boundary', async () => {
    let writeEntered = false;
    const originalHead = 'a'.repeat(40);
    const movedHead = 'b'.repeat(40);
    const originalTarget = { ...TARGET, hash: originalHead, headHash: originalHead, isHead: true };
    const service = createGitService({
      gitCommandRunner: async function (args) {
        if (args[0] === 'write-tree') return { text: 'tree\n', truncated: false };
        if (args[0] === 'rev-parse') {
          return {
            text: `${args[args.length - 1]?.startsWith('HEAD') ? movedHead : originalHead}\n`,
            truncated: false,
          };
        }
        if (args[0] === 'log') return { text: 'feat: original subject\n', truncated: false };
        if (args[0] === 'branch') return { text: '', truncated: false };
        if (args[0] === 'merge-base') return { text: `${originalHead}\n`, truncated: false };
        if (args[0] === 'symbolic-ref') return { text: 'refs/heads/main\n', truncated: false };
        if (args[0] === 'commit') writeEntered = true;
        return { text: '', truncated: false };
      },
    });

    await expect(
      service.amendCommit('feat: first', null, {
        snapshot: { tree: 'tree', entries: [] },
        target: originalTarget,
      }),
    ).rejects.toThrow('HEAD or target commit moved before the commit could be written');
    expect(writeEntered).toBe(false);
  });

  // The amend! hash is what git matches during autosquash; the second -m
  // becomes the replacement message. Hash targeting stays unambiguous when
  // multiple commits have the same subject.
  test('reword creates an amend! commit instead of rewriting history', async () => {
    const { calls, runner } = createRecorder({
      commit: '',
      'rev-parse --verify HEAD^{tree}': 'tree',
      'rev-parse --verify HEAD^1^{tree}': 'tree',
      'rev-parse --verify HEAD': TARGET.headHash,
    });
    const service = createGitService({ gitCommandRunner: runner });

    await service.rewordCommit(TARGET, 'feat(scope): new subject\n\n- new bullet', null);

    expect(calls.find(args => args[0] === 'commit')).toEqual([
      'commit',
      '--allow-empty',
      '-m',
      `amend! ${TARGET.hash}`,
      '-m',
      'feat(scope): new subject\n\n- new bullet',
    ]);
  });

  test('reword never rewrites history on its own', async () => {
    const { calls, runner } = createRecorder({
      commit: '',
      'rev-parse --verify HEAD^{tree}': 'tree',
      'rev-parse --verify HEAD^1^{tree}': 'tree',
      'rev-parse --verify HEAD': TARGET.headHash,
    });
    const service = createGitService({ gitCommandRunner: runner });

    await service.rewordCommit(TARGET, 'chore: message', null);

    const rewriting = calls.filter(args => ['rebase', 'reset', 'push'].includes(args[0] ?? ''));
    expect(rewriting).toEqual([]);
    expect(calls.some(args => args.includes('--amend'))).toBe(false);
  });

  test('reword rolls back after a hook adds content to the amend commit', async () => {
    const commands: string[][] = [];
    const service = createGitService({
      gitCommandRunner: async function (args) {
        commands.push(args);
        if (args[0] === 'commit') return { text: '', truncated: false };
        if (args.join(' ') === 'rev-parse --verify HEAD^{tree}') {
          return { text: 'changed-tree\n', truncated: false };
        }
        if (args.join(' ') === 'rev-parse --verify HEAD^1^{tree}') {
          return { text: 'parent-tree\n', truncated: false };
        }
        if (args.join(' ') === 'rev-parse --verify HEAD') {
          const headReads = commands.filter(command => command.join(' ') === args.join(' '));
          return {
            text: headReads.length === 1 ? TARGET.headHash : 'created-head',
            truncated: false,
          };
        }
        if (args.join(' ') === 'rev-parse --verify HEAD^') {
          return { text: TARGET.headHash, truncated: false };
        }
        if (args.join(' ') === `reset --soft ${TARGET.headHash}`)
          return { text: '', truncated: false };
        throw new Error(`unexpected git command: ${args.join(' ')}`);
      },
    });

    await expect(service.rewordCommit(TARGET, 'fix: replacement', null)).rejects.toThrow(
      'amend! commit contains file changes',
    );
    expect(commands).toContainEqual(['reset', '--soft', TARGET.headHash]);
  });

  test('inspect reports an unpublished head', async () => {
    const { runner } = createRecorder({
      'rev-parse --verify HEAD': 'b'.repeat(40),
      'rev-parse --verify': 'b'.repeat(40),
      'log -1': 'fix: tip subject',
      'branch --remotes --contains': '',
      remote: '',
      'merge-base HEAD': 'b'.repeat(40),
      'symbolic-ref': 'refs/heads/main',
      'log --format=%s': 'chore: other\nchore: base',
    });
    const service = createGitService({ gitCommandRunner: runner });

    const target = await service.inspectCommitTarget('HEAD', null);

    expect(target.isHead).toBe(true);
    expect(target.headHash).toBe('b'.repeat(40));
    expect(target.isPublished).toBe(false);
    expect(target.subject).toBe('fix: tip subject');
  });

  test('inspect reports a commit held by a remote branch as published', async () => {
    const { runner } = createRecorder({
      'rev-parse --verify HEAD': 'c'.repeat(40),
      'rev-parse --verify': 'd'.repeat(40),
      'log -1': 'chore: older subject',
      'branch --remotes --contains': '  origin/main\n',
      'merge-base HEAD': 'd'.repeat(40),
      'symbolic-ref': 'refs/heads/main',
      'log --format=%s': 'chore: other',
    });
    const service = createGitService({ gitCommandRunner: runner });

    const target = await service.inspectCommitTarget('d'.repeat(40), null);

    expect(target.isHead).toBe(false);
    expect(target.isPublished).toBe(true);
  });

  // Publication cannot be confirmed, so the amend path must not be unlocked.
  test('inspect treats an unanswerable remote lookup as published', async () => {
    const { runner } = createRecorder({
      'rev-parse --verify HEAD': 'e'.repeat(40),
      'rev-parse --verify': 'e'.repeat(40),
      'log -1': 'chore: subject',
      'symbolic-ref': 'refs/heads/main',
      'log --format=%s': '',
    });
    const service = createGitService({ gitCommandRunner: runner });

    const target = await service.inspectCommitTarget('HEAD', null);

    expect(target.isPublished).toBe(true);
  });
});

describe('commit capability', () => {
  const CLEAN: RepositoryState = {
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    hasUntrackedFiles: false,
    hasUnmergedPaths: false,
    inProgressOperation: null,
    changedFiles: [],
  };

  function target(overrides: Partial<CommitTarget> = {}): CommitTarget {
    return { ...TARGET, ...overrides };
  }

  test('staged work commits normally when no commit is targeted', () => {
    const capability = evaluateCommitCapability(CLEAN, null, null);
    expect(capability).toEqual({ allowed: true, mode: 'commit' });
  });

  test('an in-progress git operation blocks every action', () => {
    const capability = evaluateCommitCapability(
      { ...CLEAN, inProgressOperation: 'rebase' },
      null,
      null,
    );
    expect(capability.allowed).toBe(false);
    expect(capability.reason).toContain('rebase');
  });

  // Both amend and an amend! commit take the index with them, and the message
  // was generated from the target commit rather than from staged work.
  test('staged changes block amend and reword', () => {
    const capability = evaluateCommitCapability(
      { ...CLEAN, hasStagedChanges: true },
      'abc1234',
      target({ isHead: true }),
    );
    expect(capability.allowed).toBe(false);
    expect(capability.reason).toContain('Unstage');
  });

  test('an unpublished head is amended', () => {
    const capability = evaluateCommitCapability(
      CLEAN,
      'abc1234',
      target({ isHead: true, isPublished: false }),
    );
    expect(capability.mode).toBe('amend');
    expect(capability.allowed).toBe(true);
  });

  test('a published head is reworded instead of amended', () => {
    const capability = evaluateCommitCapability(
      CLEAN,
      'abc1234',
      target({ isHead: true, isPublished: true }),
    );
    expect(capability.mode).toBe('reword');
  });

  test('an older commit is reworded', () => {
    const capability = evaluateCommitCapability(CLEAN, 'abc1234', target());
    expect(capability.mode).toBe('reword');
    expect(capability.target?.hash).toBe(TARGET.hash);
  });

  // The amend! commit is created on the current branch, so a target the branch
  // cannot reach would keep its old message and leave the commit behind.
  test('a target unreachable from HEAD is refused', () => {
    const capability = evaluateCommitCapability(
      CLEAN,
      'abc1234',
      target({ isAncestorOfHead: false }),
    );
    expect(capability.allowed).toBe(false);
    expect(capability.reason).toContain('not reachable from HEAD');
  });

  test('inspect marks a commit on another branch as unreachable', async () => {
    const { runner } = createRecorder({
      'rev-parse --verify HEAD': 'f'.repeat(40),
      'rev-parse --verify': '9'.repeat(40),
      'log -1': 'feat: on another branch',
      'branch --remotes --contains': '',
      'merge-base HEAD': '0'.repeat(40),
      'symbolic-ref': 'refs/heads/main',
      'log --format=%s': '',
    });
    const service = createGitService({ gitCommandRunner: runner });

    const inspected = await service.inspectCommitTarget('9'.repeat(40), null);

    expect(inspected.isAncestorOfHead).toBe(false);
  });

  test('an unresolvable target stays read-only', () => {
    const capability = evaluateCommitCapability(CLEAN, 'nope', null);
    expect(capability.allowed).toBe(false);
    expect(capability.reason).toContain('read-only');
  });
});

describe('reword edge cases', () => {
  const CLEAN_STATE: RepositoryState = {
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    hasUntrackedFiles: false,
    hasUnmergedPaths: false,
    inProgressOperation: null,
    changedFiles: [],
  };

  test('a detached HEAD refuses both actions', () => {
    const capability = evaluateCommitCapability(CLEAN_STATE, 'abc1234', {
      ...TARGET,
      isHead: true,
      isHeadDetached: true,
    });
    expect(capability.allowed).toBe(false);
    expect(capability.reason).toContain('detached');
  });

  test('inspect detects a detached HEAD', async () => {
    const { runner } = createRecorder({
      'rev-parse --verify HEAD': '1'.repeat(40),
      'rev-parse --verify': '1'.repeat(40),
      'log -1': 'chore: tip',
      'branch --remotes --contains': '',
      'merge-base HEAD': '1'.repeat(40),
      'log --format=%s': '',
    });
    const service = createGitService({ gitCommandRunner: runner });

    const inspected = await service.inspectCommitTarget('HEAD', null);

    expect(inspected.isHeadDetached).toBe(true);
  });

  test('inspect flags an older commit sharing the subject', async () => {
    const { runner } = createRecorder({
      'rev-parse --verify HEAD': '2'.repeat(40),
      'rev-parse --verify': '2'.repeat(40),
      'log -1': 'fix: typo',
      'branch --remotes --contains': '',
      'merge-base HEAD': '2'.repeat(40),
      'symbolic-ref': 'refs/heads/main',
      'log --format=%s': 'chore: middle\nfix: typo\nchore: base',
    });
    const service = createGitService({ gitCommandRunner: runner });

    const inspected = await service.inspectCommitTarget('HEAD', null);

    expect(inspected.hasAmbiguousSubject).toBe(true);
    expect(inspected.hasParent).toBe(true);
  });

  test('inspect reports the root commit as parentless', async () => {
    const { runner } = createRecorder({
      'rev-parse --verify HEAD': '3'.repeat(40),
      'rev-parse --verify': '3'.repeat(40),
      'log -1': 'chore: root',
      'branch --remotes --contains': '',
      'merge-base HEAD': '3'.repeat(40),
      'symbolic-ref': 'refs/heads/main',
    });
    const service = createGitService({ gitCommandRunner: runner });

    const inspected = await service.inspectCommitTarget('HEAD', null);

    expect(inspected.hasParent).toBe(false);
    expect(inspected.hasAmbiguousSubject).toBe(false);
  });
});
