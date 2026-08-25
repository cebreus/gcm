import { describe, expect, test } from 'bun:test';

import { runCommitBatch } from '../src/batch-generation.js';

describe('commit range batch', () => {
  test('processes frozen targets in order and advances only through expected HEAD values', async () => {
    const processed: string[] = [];
    const heads = ['head-0', 'head-1', 'head-1', 'head-2'];
    let headRead = 0;

    const result = await runCommitBatch({
      targets: ['first', 'second'],
      initialHead: 'head-0',
      getHead: async function () {
        return heads[Math.min(headRead++, heads.length - 1)] ?? '';
      },
      hasAmendment: async function () {
        return false;
      },
      runOne: async function (hash) {
        processed.push(hash);
        return true;
      },
      report: function () {},
    });

    expect(processed).toEqual(['first', 'second']);
    expect(result).toEqual({ completed: ['first', 'second'], skipped: [], failed: null });
  });

  test('skips existing amendments and stops on the first failure', async () => {
    const processed: string[] = [];
    let head = 'head-0';

    const result = await runCommitBatch({
      targets: ['done', 'fails', 'untouched'],
      initialHead: head,
      getHead: async function () {
        return head;
      },
      hasAmendment: async function (hash) {
        return hash === 'done';
      },
      runOne: async function (hash) {
        processed.push(hash);
        if (hash === 'fails') return false;
        head = `after-${hash}`;
        return true;
      },
      report: function () {},
    });

    expect(processed).toEqual(['fails']);
    expect(result).toEqual({ completed: [], skipped: ['done'], failed: 'fails' });
  });

  test('refuses unexpected HEAD movement before processing the next target', async () => {
    let currentHead = 'head-0';
    let reads = 0;
    const result = await runCommitBatch({
      targets: ['first', 'second'],
      initialHead: currentHead,
      getHead: async function () {
        reads += 1;
        if (reads === 3) currentHead = 'external-head';
        return currentHead;
      },
      hasAmendment: async function () {
        return false;
      },
      runOne: async function (hash) {
        currentHead = hash === 'first' ? 'head-1' : currentHead;
        return true;
      },
      report: function () {},
    });

    expect(result.failed).toBe('second');
    expect(result.completed).toEqual(['first']);
  });
});
