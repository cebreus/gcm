import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, test } from 'bun:test';

import { spawnGitStream } from '../src/git-utils';
import type { SpawnGitStreamResult } from '../src/git-utils';

async function gitUtilsKillSignalTest(): Promise<void> {
  // This inline script prints lines and listens for SIGTERM to write 'GOT_SIGTERM' then exit
  const marker = join(
    await mkdtemp(join(tmpdir(), 'gcm-kill-')),
    'got-sigterm',
  );
  const script = `process.on('SIGTERM', ()=>{ require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }); let i=0; setInterval(()=>{ console.log('line'+(i++)); }, 1);`;
  const args = ['-e', script];
  const maxBytes = 1024; // 1 KB cap
  const res: SpawnGitStreamResult = await spawnGitStream(args, {
    maxBytes,
    execName: 'bun',
    allowTruncated: true,
  });
  expect(res.truncated).toBe(true);
  expect(typeof res.text === 'string' && res.text.length > 0).toBe(true);
  expect(res.text).toContain('line0');
  for (let i = 0; i < 50 && !(await Bun.file(marker).exists()); i += 1) {
    await Bun.sleep(20);
  }
  expect(await Bun.file(marker).exists()).toBe(true);
  await rm(dirname(marker), { recursive: true, force: true });
}
test('git-utils: killSignalTest', gitUtilsKillSignalTest);

test('git-utils: accepts a non-zero exit caused by its truncation kill', async () => {
  const script = `process.on('SIGTERM', () => process.exit(1)); console.log('x'.repeat(2048)); setInterval(() => {}, 1000);`;
  const result = await spawnGitStream(['-e', script], {
    maxBytes: 1024,
    execName: 'bun',
    allowTruncated: true,
  });

  expect(result.truncated).toBe(true);
});

test('git-utils: times out a Git process that does not produce output', async () => {
  await expect(
    spawnGitStream(['-e', 'setInterval(() => {}, 1_000)'], {
      execName: 'bun',
      timeoutMs: 20,
    }),
  ).rejects.toThrow('timed out');
});

test('git-utils: throws when a command fails after producing truncated output', async () => {
  const script = `console.log('x'.repeat(2048)); process.exit(1);`;

  await expect(
    spawnGitStream(['-e', script], { maxBytes: 1024, execName: 'bun' }),
  ).rejects.toThrow('output was truncated');
});
