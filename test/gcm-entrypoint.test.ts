import { expect, test } from 'bun:test';

test('gcm entrypoint: catches runner rejections', async () => {
  const fixturePath = new URL('./gcm-entrypoint.fixture.ts', import.meta.url).pathname;
  const entrypointPath = new URL('../gcm.ts', import.meta.url).pathname;
  const child = Bun.spawn({
    cmd: [process.execPath, '--preload', fixturePath, entrypointPath],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;

  expect(exitCode).toBe(1);
  expect(await stdout).toBe('');
  expect(await stderr).toBe('gcm: runner rejection\n');
});
