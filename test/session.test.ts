import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';

const directory = await mkdtemp(`${Bun.env.TMPDIR ?? '/tmp'}/gcm-session-`);

afterAll(async function (): Promise<void> {
  await rm(directory, { recursive: true, force: true });
});

test('session: rejects persisted values outside its provider-scoped schema', async function () {
  await Bun.write(
    `${directory}/.gcm-session.json`,
    JSON.stringify({ modelName: 'gemini-old', outputMode: 'commit-only' }),
  );
  const child = Bun.spawn({
    cmd: [
      'bun',
      '-e',
      "import {loadSession} from './src/session.ts'; console.log(JSON.stringify(await loadSession()));",
    ],
    cwd: process.cwd(),
    env: { ...Bun.env, HOME: directory },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  expect(JSON.parse(stdout)).toEqual({ providerId: null, modelName: null, outputMode: null });
});

test('session: restores a validated non-Gemini provider model', async function () {
  await Bun.write(
    `${directory}/.gcm-session.json`,
    JSON.stringify({ providerId: 'lm-studio', modelName: 'qwen/qwen3-8b', outputMode: 'full' }),
  );
  const child = Bun.spawn({
    cmd: [
      'bun',
      '-e',
      "import {loadSession} from './src/session.ts'; console.log(JSON.stringify(await loadSession()));",
    ],
    cwd: process.cwd(),
    env: { ...Bun.env, HOME: directory },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  expect(JSON.parse(stdout)).toEqual({
    providerId: 'lm-studio',
    modelName: 'qwen/qwen3-8b',
    outputMode: 'full',
  });
});
