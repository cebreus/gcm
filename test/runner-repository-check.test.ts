import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, mock, test } from 'bun:test';

import { executeCommitMessageGeneration } from '../src/runner.js';

test('Should fail before creating a provider outside a git repository', async () => {
  const create = mock(async () => {
    throw new Error('must not create');
  });
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'gcm-norepo-'));
  const writes: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    process.chdir(dir);
    await executeCommitMessageGeneration(['--print'], {
      languageModelProviderFactories: [{ id: 'local', label: 'Local', create }],
    });
    expect(create).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(writes.join('')).toContain('Not inside a git repository');
  } finally {
    process.stderr.write = originalWrite;
    process.chdir(originalCwd);
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  }
});
