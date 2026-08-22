import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { createCommitActionService, type IndexEntry } from '../src/commit-action-service.js';
import type { CommitTarget, GitService, RepositoryState } from '../src/services/git-service.js';
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
  test('commits an unchanged staged snapshot', async () => {
    const fake = createFakeGitService({});
    const actions = createActionService(fake.service);

    const inspection = await actions.inspect(null);
    const result = await actions.apply(inspection.capability, 'feat: first');

    expect(result.summary).toBe('Commit successfully created!');
    expect(fake.writes).toEqual(['commit:feat: first']);
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
    for (const target of [
      { ...TARGET, isHead: true, isPublished: false },
      TARGET,
    ]) {
      const fake = createFakeGitService({
        states: [{ ...CLEAN, hasStagedChanges: false }, CLEAN],
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
      states: [{ ...CLEAN, hasStagedChanges: false }, { ...CLEAN, hasStagedChanges: false }],
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
    const cases: Array<{ state: RepositoryState; targetHash: string | null; target: CommitTarget | null }> = [
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

function runGit(repository: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: repository, stdout: 'pipe', stderr: 'pipe' });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

test('integration: refuses staging drift without creating a commit', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'gcm-commit-action-'));
  try {
    runGit(repository, ['init', '-q']);
    runGit(repository, ['config', 'user.email', 'test@gcm.local']);
    runGit(repository, ['config', 'user.name', 'GCM Test']);
    await writeFile(join(repository, 'base.ts'), 'export const base = true;\n');
    runGit(repository, ['add', 'base.ts']);
    runGit(repository, ['commit', '-qm', 'chore: base']);
    await writeFile(join(repository, 'first.ts'), 'export const first = true;\n');
    runGit(repository, ['add', 'first.ts']);

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
    runGit(repository, ['add', 'second.ts']);
    const inspection = await actions.inspect(null, staged.snapshot);

    await expect(actions.apply(inspection.capability, 'feat: first')).rejects.toThrow('Added: "second.ts"');
    expect(runGit(repository, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    expect(writeEntered).toBe(false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
