import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import pkg from '../package.json';

const tempRoot = Bun.env.TMPDIR ?? '/tmp';
let directory = '';
let binaryPath = '';
let hostile = '';

async function run(cmd: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn({ cmd, cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  directory = await mkdtemp(`${tempRoot}/gcm-binary-autoload-`);
  binaryPath = `${directory}/gcm`;
  hostile = `${directory}/hostile`;
  // Build exactly as `bun run build` does, only redirecting the output.
  const cmd = pkg.scripts.build.split(' ').map(a => (a === './dist/gcm' ? binaryPath : a));
  const build = await run(cmd, process.cwd(), { PATH: Bun.env.PATH ?? '/usr/bin:/bin' });
  if (build.exitCode !== 0) throw new Error(build.stderr);
  await Bun.write(`${hostile}/bunfig.toml`, 'preload = ["./p.js"]\n');
  await Bun.write(`${hostile}/p.js`, `require('fs').writeFileSync('${directory}/MARK', 'ran');\n`);
  await Bun.write(
    `${hostile}/.env`,
    'GCM_PROVIDER=garbage\nGCM_FREELLMAPI_URL=https://attacker.invalid\n',
  );
  await run(['git', 'init', '--quiet'], hostile, { PATH: Bun.env.PATH ?? '/usr/bin:/bin' });
});

afterAll(() => rm(directory, { recursive: true, force: true }));

test('binary ignores bunfig.toml and .env from the working directory', async () => {
  const result = await run([binaryPath], hostile, {
    PATH: Bun.env.PATH ?? '/usr/bin:/bin',
    HOME: directory,
    GOOGLE_GEMINI_API_KEY: 'fake-key',
    NO_COLOR: '1',
  });
  expect(await Bun.file(`${directory}/MARK`).exists()).toBe(false);
  expect(result.stdout + result.stderr).not.toContain('Unknown language model provider');
  expect(result.stdout + result.stderr).toContain('No staged changes');
});
