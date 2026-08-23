import { expect, test } from 'bun:test';

async function readConfig(env: Record<string, string>): Promise<unknown> {
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
  const config: unknown = JSON.parse(stdout);
  return config;
}

test('config: reads the short GCM names', async () => {
  await expect(readConfig({ GCM_MODEL: 'test-model', GCM_TEMP: '0.25' })).resolves.toEqual({
    model: 'test-model',
    temp: 0.25,
  });
});
