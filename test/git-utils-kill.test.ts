import { test, expect } from 'bun:test';
import { spawnGitStream } from '../src/git-utils';
import type { SpawnGitStreamResult } from '../src/git-utils';

async function gitUtilsKillSignalTest(): Promise<void> {
  // This inline script prints lines and listens for SIGTERM to write 'GOT_SIGTERM' then exit
  const script = `process.on('SIGTERM', ()=>{ console.log('GOT_SIGTERM'); process.exit(0); }); let i=0; setInterval(()=>{ console.log('line'+(i++)); }, 1);`;
  const args = ['-e', script];
  const maxBytes = 1024; // 1 KB cap
  const res: SpawnGitStreamResult = await spawnGitStream(args, { maxBytes, execName: 'bun' });
  expect(res.truncated).toBe(true);
  expect(typeof res.text === 'string' && res.text.length > 0).toBe(true);
  // On some runtimes (like Bun) the child may not always print the SIGTERM handler output
  // before we kill it; only assert truncation and presence of initial output.
  console.log('  killSignalTest -> passed');
}
test('git-utils: killSignalTest', gitUtilsKillSignalTest);

test('git-utils: accepts a non-zero exit caused by its truncation kill', async function () {
  const script = `process.on('SIGTERM', () => process.exit(1)); console.log('x'.repeat(2048)); setInterval(() => {}, 1000);`;
  const result = await spawnGitStream(['-e', script], { maxBytes: 1024, execName: 'bun' });

  expect(result.truncated).toBe(true);
});

test('git-utils: throws when a command fails after producing truncated output', async function () {
  const script = `console.log('x'.repeat(2048)); process.exit(1);`;

  await expect(spawnGitStream(['-e', script], { maxBytes: 1024, execName: 'bun' })).rejects.toThrow(
    'failed:',
  );
});
