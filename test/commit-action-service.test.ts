import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createCommitActionService } from '../src/commit-action-service.js';
import type {
  CommitTarget,
  GitService,
  IndexEntry,
  RepositoryState,
} from '../src/services/git-service.js';
import { createGitService } from '../src/services/git-service.js';
import { spawnGitStream } from '../src/git-utils.js';

const CLEAN: RepositoryState = {
  hasStagedChanges: true,
  hasUnstagedChanges: false,
  hasUntrackedFiles: false,
  hasUnmergedPaths: false,
  inProgressOperation: null,
  changedFiles: ['first.ts'],
};

const TARGET: CommitTarget = {
  hash: 'a'.repeat(40),
  headHash: 'b'.repeat(40),
  subject: 'feat: target',
  isHead: false,
  isPublished: false,
  isAncestorOfHead: true,
  isHeadDetached: false,
  hasParent: true,
  hasAmbiguousSubject: false,
};

function entries(...paths: string[]): IndexEntry[] {
  return paths.map(function (path, index) {
    return { path, mode: '100644', objectId: String(index).padStart(40, '0') };
  });
}

function createFakeGitService(params: {
  states?: RepositoryState[];
  trees?: string[];
  indexEntries?: IndexEntry[][];
  target?: CommitTarget | null;
  targets?: Array<CommitTarget | null>;
}) {
  const states = params.states ?? [CLEAN, CLEAN];
  const trees = params.trees ?? ['tree', 'tree'];
  const snapshots = params.indexEntries ?? [entries('first.ts'), entries('first.ts')];
  let stateIndex = 0;
  let treeIndex = 0;
  let snapshotIndex = 0;
  let targetIndex = 0;
  const writes: string[] = [];
  const service: GitService = {
    retrieveStagedChanges: async function () {
      return null;
    },
    commitChanges: async function (message) {
      writes.push(`commit:${message}`);
    },
    amendCommit: async function (message) {
      writes.push(`amend:${message}`);
    },
    rewordCommit: async function (_target, message) {
      writes.push(`reword:${message}`);
    },
    inspectCommitTarget: async function () {
      const targets = params.targets ?? [params.target ?? null];
      const target = targets[Math.min(targetIndex++, targets.length - 1)];
      if (!target) throw new Error('target unavailable');
      return target;
    },
    getIndexTree: async function () {
      return trees[Math.min(treeIndex++, trees.length - 1)] ?? '';
    },
    getIndexEntries: async function () {
      return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] ?? [];
    },
    getRepositoryState: async function () {
      return states[Math.min(stateIndex++, states.length - 1)] ?? CLEAN;
    },
  };
  return { service, writes };
}

function createActionService(gitService: GitService) {
  return createCommitActionService({ gitService, logger: { log: function () {} } });
}

describe('commit action service', () => {
  test('refuses an observed snapshot that is already stale', async () => {
    const fake = createFakeGitService({ trees: ['current-tree', 'current-tree'] });
    const actions = createActionService(fake.service);

    const inspection = await actions.inspect(null, {
      tree: 'read-tree',
      entries: entries('first.ts'),
    });

    expect(inspection.capability.allowed).toBe(false);
    expect(inspection.capability.reason).toContain('index changed');
  });

  test('reports stale observed snapshot even when a Git operation started', async () => {
    const fake = createFakeGitService({
      states: [{ ...CLEAN, inProgressOperation: 'rebase' }],
      trees: ['current-tree'],
    });
    const actions = createActionService(fake.service);

    const inspection = await actions.inspect(null, {
      tree: 'read-tree',
      entries: entries('first.ts'),
    });

    expect(inspection.observedSnapshotInvalid).toBe(true);
  });

  test('keeps a stable snapshot and the exact rebase capability reason', async () => {
    const repositoryState = { ...CLEAN, inProgressOperation: 'rebase' as const };
    const fake = createFakeGitService({ states: [repositoryState, repositoryState] });
    const actions = createActionService(fake.service);
    const snapshot = { tree: 'tree', entries: entries('first.ts') };

    const inspection = await actions.inspect(null, snapshot);

    expect(inspection.capability.snapshot).toEqual(snapshot);
    expect(inspection.capability.allowed).toBe(false);
    expect(inspection.capability.reason).toBe(
      'Commit is disabled while a git rebase is in progress. Finish or abort the operation first.',
    );
  });

  test('stops when an observed snapshot cannot be verified and refreshes conflicts', async () => {
    const fake = createFakeGitService({
      states: [CLEAN, { ...CLEAN, hasUnmergedPaths: true }],
    });
    fake.service.getIndexTree = async function () {
      throw new Error('write-tree failed');
    };
    const actions = createActionService(fake.service);

    const inspection = await actions.inspect(null, {
      tree: 'read-tree',
      entries: entries('first.ts'),
    });

    expect(inspection.observedSnapshotInvalid).toBe(true);
    expect(inspection.repositoryState?.hasUnmergedPaths).toBe(true);
  });

  test('commits an unchanged staged snapshot', async () => {
    const fake = createFakeGitService({});
    const actions = createActionService(fake.service);

    const inspection = await actions.inspect(null);
    const result = await actions.apply(inspection.capability, 'feat: first');

    expect(result.summary).toBe('Commit successfully created!');
    expect(fake.writes).toEqual(['commit:feat: first']);
  });

  test('uses repository state refreshed after the index snapshot', async () => {
    const fake = createFakeGitService({
      states: [
        { ...CLEAN, hasStagedChanges: false },
        { ...CLEAN, hasStagedChanges: true },
      ],
      target: { ...TARGET, isHead: true },
    });
    const actions = createActionService(fake.service);

    const inspection = await actions.inspect(TARGET.hash);

    expect(inspection.capability.allowed).toBe(false);
    expect(inspection.capability.reason).toContain('Staged changes');
  });

  test('range policy creates amend! even when the target is unpublished HEAD', async () => {
    const head = { ...TARGET, hash: 'b'.repeat(40), headHash: 'b'.repeat(40), isHead: true };
    const fake = createFakeGitService({
      states: [
        { ...CLEAN, hasStagedChanges: false },
        { ...CLEAN, hasStagedChanges: false },
      ],
      target: head,
    });
    const actions = createCommitActionService({
      gitService: fake.service,
      logger: { log: function () {} },
      allowDirectAmend: false,
    });

    const inspection = await actions.inspect(head.hash);
    await actions.apply(inspection.capability, 'fix: replacement');

    expect(inspection.capability.mode).toBe('reword');
    expect(fake.writes).toEqual(['reword:fix: replacement']);
  });

  test('refuses excluded staged paths until they are explicitly acknowledged', async () => {
    const fake = createFakeGitService({});
    const actions = createActionService(fake.service);
    const inspection = await actions.inspect(null);
    const capability = { ...inspection.capability, excludedPaths: ['secrets.txt'] };

    await expect(actions.apply(capability, 'feat: first')).rejects.toThrow(
      'Explicit confirmation is required before committing excluded staged paths',
    );
    expect(fake.writes).toEqual([]);

    await actions.apply({ ...capability, exclusionsAcknowledged: true }, 'feat: first');
    expect(fake.writes).toEqual(['commit:feat: first']);
  });

  test('refuses a changed index and names changed paths', async () => {
    const fake = createFakeGitService({
      trees: ['first-tree', 'first-tree', 'second-tree', 'second-tree'],
      indexEntries: [
        [
          { path: 'first.ts', mode: '100644', objectId: '1'.repeat(40) },
          { path: 'modified.ts', mode: '100644', objectId: '2'.repeat(40) },
          { path: 'removed.ts', mode: '100644', objectId: '3'.repeat(40) },
        ],
        [
          { path: 'first.ts', mode: '100644', objectId: '1'.repeat(40) },
          { path: 'modified.ts', mode: '100644', objectId: '4'.repeat(40) },
          { path: 'second.ts', mode: '100644', objectId: '5'.repeat(40) },
        ],
      ],
    });
    const actions = createActionService(fake.service);
    const inspection = await actions.inspect(null);

    await expect(actions.apply(inspection.capability, 'feat: first')).rejects.toThrow(
      'Added: "second.ts"',
    );
    await expect(actions.apply(inspection.capability, 'feat: first')).rejects.toThrow(
      'Modified: "modified.ts", Removed: "removed.ts"',
    );
    expect(fake.writes).toEqual([]);
  });

  test('escapes changed paths before putting them in a refusal', async () => {
    const fake = createFakeGitService({
      trees: ['first-tree', 'first-tree', 'second-tree', 'second-tree'],
      indexEntries: [entries('first.ts'), entries('first.ts', 'later\nAdded: forged\u001B[2J.ts')],
    });
    const actions = createActionService(fake.service);
    const inspection = await actions.inspect(null);

    await expect(actions.apply(inspection.capability, 'feat: first')).rejects.toThrow(
      'Added: "later\\nAdded: forged\\u001b[2J.ts"',
    );
    expect(fake.writes).toEqual([]);
  });

  test('refuses a capability without the snapshot that describes its message', async () => {
    const fake = createFakeGitService({});
    const actions = createActionService(fake.service);

    await expect(actions.apply({ allowed: true, mode: 'commit' }, 'feat: first')).rejects.toThrow(
      'the original staged snapshot is missing',
    );
    expect(fake.writes).toEqual([]);
  });

  test('refuses an indeterminate index state', async () => {
    const fake = createFakeGitService({
      states: [CLEAN, { ...CLEAN, hasUnmergedPaths: true }],
    });
    const actions = createActionService(fake.service);
    const inspection = await actions.inspect(null);

    await expect(actions.apply(inspection.capability, 'feat: first')).rejects.toThrow(
      'Cannot safely determine the staged changes',
    );
    expect(fake.writes).toEqual([]);
  });

  test('refuses drift before amend and reword writes', async () => {
    for (const target of [{ ...TARGET, isHead: true, isPublished: false }, TARGET]) {
      const fake = createFakeGitService({
        states: [
          { ...CLEAN, hasStagedChanges: false },
          { ...CLEAN, hasStagedChanges: false },
          CLEAN,
        ],
        trees: ['first-tree', 'first-tree', 'second-tree', 'second-tree'],
        indexEntries: [entries(), entries('later.ts')],
        target,
      });
      const actions = createActionService(fake.service);
      const inspection = await actions.inspect(target.hash);

      await expect(actions.apply(inspection.capability, 'feat: first')).rejects.toThrow(
        'Added: "later.ts"',
      );
      expect(fake.writes).toEqual([]);
    }
  });

  test('refuses when HEAD moved after a reword target was inspected', async () => {
    const oldHead = 'b'.repeat(40);
    const newHead = 'c'.repeat(40);
    const fake = createFakeGitService({
      states: [
        { ...CLEAN, hasStagedChanges: false },
        { ...CLEAN, hasStagedChanges: false },
      ],
      targets: [
        { ...TARGET, headHash: oldHead },
        { ...TARGET, headHash: newHead },
      ],
    });
    const actions = createActionService(fake.service);
    const inspection = await actions.inspect(TARGET.hash);

    await expect(actions.apply(inspection.capability, 'feat: first')).rejects.toThrow(
      'HEAD or target commit moved',
    );
    expect(fake.writes).toEqual([]);
  });

  test('keeps all existing refusal guards at the commit-action seam', async () => {
    const cases: Array<{
      state: RepositoryState;
      targetHash: string | null;
      target: CommitTarget | null;
    }> = [
      { state: { ...CLEAN, inProgressOperation: 'rebase' }, targetHash: null, target: null },
      { state: { ...CLEAN, hasUnmergedPaths: true }, targetHash: null, target: null },
      { state: CLEAN, targetHash: 'missing', target: null },
      { state: { ...CLEAN, hasStagedChanges: true }, targetHash: TARGET.hash, target: TARGET },
      {
        state: { ...CLEAN, hasStagedChanges: false },
        targetHash: TARGET.hash,
        target: { ...TARGET, isHeadDetached: true },
      },
      {
        state: { ...CLEAN, hasStagedChanges: false },
        targetHash: TARGET.hash,
        target: { ...TARGET, isAncestorOfHead: false },
      },
    ];

    for (const refusal of cases) {
      const fake = createFakeGitService({ states: [refusal.state], target: refusal.target });
      const actions = createActionService(fake.service);
      const inspection = await actions.inspect(refusal.targetHash);

      expect(inspection.capability.allowed).toBe(false);
      await expect(actions.apply(inspection.capability, 'feat: first')).rejects.toThrow();
      expect(fake.writes).toEqual([]);
    }
  });
});

async function runGit(repository: string, args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: ['git', ...args],
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

test('integration: refuses staging drift without creating a commit', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-commit-action-'));
  try {
    await runGit(repository, ['init', '-q']);
    await runGit(repository, ['config', 'user.email', 'test@gcm.local']);
    await runGit(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, 'base.ts'), 'export const base = true;\n');
    await runGit(repository, ['add', 'base.ts']);
    await runGit(repository, ['commit', '-qm', 'chore: base']);
    await writeFile(join(repository, 'first.ts'), 'export const first = true;\n');
    await runGit(repository, ['add', 'first.ts']);

    let writeEntered = false;
    const gitService = createGitService({
      gitCommandRunner: function (args) {
        if (args[0] === 'commit') writeEntered = true;
        return spawnGitStream(['-C', repository, ...args]);
      },
    });
    const actions = createActionService(gitService);
    const staged = await gitService.retrieveStagedChanges(null, null);
    if (!staged) throw new Error('Expected staged changes');
    await writeFile(join(repository, 'second.ts'), 'export const second = true;\n');
    await runGit(repository, ['add', 'second.ts']);
    const inspection = await actions.inspect(null, staged.snapshot);

    expect(inspection.capability.reason).toContain('the index changed after its diff was read');
    await expect(actions.apply(inspection.capability, 'feat: first')).rejects.toThrow(
      'the index changed after its diff was read',
    );
    expect((await runGit(repository, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
    expect(writeEntered).toBe(false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('integration: keeps a stable snapshot read-only during a rebase', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-rebase-action-'));
  const previousDirectory = process.cwd();
  let writeEntered = false;
  try {
    await runGit(repository, ['init', '-q']);
    await runGit(repository, ['config', 'user.email', 'test@gcm.local']);
    await runGit(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, 'base.ts'), 'export const base = true;\n');
    await runGit(repository, ['add', 'base.ts']);
    await runGit(repository, ['commit', '-qm', 'chore: base']);
    await writeFile(join(repository, 'first.ts'), 'export const first = true;\n');
    await runGit(repository, ['add', 'first.ts']);
    process.chdir(repository);

    const gitService = createGitService({
      gitCommandRunner: function (args) {
        if (args[0] === 'commit') writeEntered = true;
        return spawnGitStream(args);
      },
    });
    const actions = createActionService(gitService);
    const staged = await gitService.retrieveStagedChanges(null, null);
    if (!staged?.snapshot) throw new Error('Expected a stable staged snapshot');
    await mkdir(join(repository, '.git', 'rebase-merge'));

    const inspection = await actions.inspect(null, staged.snapshot);

    expect(inspection.repositoryState?.inProgressOperation).toBe('rebase');
    expect(inspection.capability.snapshot).toEqual(staged.snapshot);
    expect(inspection.capability.reason).toBe(
      'Commit is disabled while a git rebase is in progress. Finish or abort the operation first.',
    );
    await expect(actions.apply(inspection.capability, 'feat: first')).rejects.toThrow(
      'Commit is disabled while a git rebase is in progress.',
    );
    expect((await runGit(repository, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
    expect(writeEntered).toBe(false);
  } finally {
    process.chdir(previousDirectory);
    await rm(repository, { recursive: true, force: true });
  }
});
