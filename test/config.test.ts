import { expect, test } from 'bun:test';

async function readConfig(env: Record<string, string>): Promise<{ model: string; temp: number }> {
  const child = Bun.spawn({
    cmd: [
      'bun',
      '-e',
      "import { CONFIG } from './gcm.config.ts'; console.log(JSON.stringify({ model: CONFIG.MODEL, temp: CONFIG.TEMP }));",
    ],
    cwd: process.cwd(),
    env: { PATH: Bun.env.PATH || '/usr/bin:/bin', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
  return JSON.parse(stdout) as { model: string; temp: number };
}

test('config: reads the short GCM names', async () => {
  await expect(readConfig({ GCM_MODEL: 'test-model', GCM_TEMP: '0.25' })).resolves.toEqual({
    model: 'test-model',
    temp: 0.25,
  });
});
