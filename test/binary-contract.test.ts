import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import pkg from '../package.json';

const ansiEscape = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const tempRoot = Bun.env.TMPDIR || '/tmp';
const packageVersion = pkg.version;
let binaryDirectory = '';
let binaryPath = '';
let gitRepository = '';
let nonRepository = '';
let whitespaceRepository = '';
let excludeRepository = '';

interface BinaryResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function clean(text: string): string {
  return text.replace(ansiEscape, '');
}

function controlledEnvironment(apiKey?: string): Record<string, string> {
  return {
    PATH: Bun.env.PATH || '/usr/bin:/bin',
    HOME: tempRoot,
    NO_COLOR: '1',
    TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GOOGLE_GEMINI_API_KEY: apiKey || '',
  };
}

async function runSubprocess(
  command: string[],
  cwd: string,
  apiKey?: string,
): Promise<BinaryResult> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: controlledEnvironment(apiKey),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 10_000);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  const result = {
    exitCode,
    stdout: await stdout,
    stderr: await stderr,
  };
  if (timedOut) {
    throw new Error(
      `Timed out: ${command.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

async function runCommand(command: string[], cwd: string): Promise<BinaryResult> {
  const result = await runSubprocess(command, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed: ${command.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

async function runBinary(
  args: string[],
  cwd = gitRepository,
  apiKey?: string,
): Promise<BinaryResult> {
  const result = await runSubprocess([binaryPath, ...args], cwd, apiKey);
  return {
    exitCode: result.exitCode,
    stdout: clean(result.stdout),
    stderr: clean(result.stderr),
  };
}

function expectCleanInputError(result: BinaryResult, message: string): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual([expect.stringContaining(message)]);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain('at ');
  expect(result.stdout).not.toContain('function(');
}

beforeAll(async () => {
  binaryDirectory = await mkdtemp(`${tempRoot}/gcm-binary-contract-build-`);
  binaryPath = `${binaryDirectory}/gcm`;
  gitRepository = await mkdtemp(`${tempRoot}/gcm-binary-contract-repository-`);
  nonRepository = await mkdtemp(`${tempRoot}/gcm-binary-contract-not-a-repository-`);
  whitespaceRepository = await mkdtemp(`${tempRoot}/gcm-binary-contract-whitespace-`);
  excludeRepository = await mkdtemp(`${tempRoot}/gcm-binary-contract-exclude-`);

  await runCommand(
    ['bun', 'build', './gcm.ts', '--outfile', binaryPath, '--target=bun', '--minify'],
    process.cwd(),
  );
  for (const repository of [gitRepository, whitespaceRepository, excludeRepository]) {
    await runCommand(['git', 'init', '--quiet'], repository);
  }

  await Bun.write(`${whitespaceRepository}/document.txt`, 'first line\n');
  await runCommand(['git', 'add', 'document.txt'], whitespaceRepository);
  await runCommand(['git', '-c', 'user.email=test@gcm.local', '-c', 'user.name=GCM Test', 'commit', '-qm', 'initial'], whitespaceRepository);
  await Bun.write(`${whitespaceRepository}/document.txt`, 'first line \n');
  await runCommand(['git', 'add', 'document.txt'], whitespaceRepository);

  await runCommand(['mkdir', '-p', './-generated'], excludeRepository);
  await Bun.write(`${excludeRepository}/-generated/sentinel.txt`, 'do not send\n');
  await Bun.write(`${excludeRepository}/included.txt`, 'send this\n');
  await runCommand(['git', 'add', '--', '-generated/sentinel.txt', 'included.txt'], excludeRepository);
}, 60_000);

afterAll(async () => {
  await Promise.all([
    rm(binaryDirectory, { recursive: true, force: true }),
    rm(gitRepository, { recursive: true, force: true }),
    rm(nonRepository, { recursive: true, force: true }),
    rm(whitespaceRepository, { recursive: true, force: true }),
    rm(excludeRepository, { recursive: true, force: true }),
  ]);
});

test('binary contract: reports its bundled package version outside the repository', async () => {
  const result = await runBinary(['--version']);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`gcm ${packageVersion}\n`);
  expect(result.stderr).toBe('');
});

test('binary contract: shows documented help', async () => {
  const result = await runBinary(['--help']);

  expect(result.exitCode).toBe(0);
  for (const flag of [
    '--commit',
    '--help',
    '--version',
    '--verbose',
    '--debug',
    '--exclude',
    '--mode',
    '--model',
    '--list-models',
  ]) {
    expect(result.stdout).toContain(flag);
  }
  expect(result.stderr).toBe('');
});

test('binary contract: reports no staged changes without calling Gemini', async () => {
  const result = await runBinary(['--mode', 'commit-only'], gitRepository, 'not-a-real-key');

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('No staged changes found');
  expect(result.stderr).toBe('');
});

test('binary contract: reports a missing Gemini API key', async () => {
  const result = await runBinary([], excludeRepository);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('GOOGLE_GEMINI_API_KEY');
  expect(result.stderr).toBe('');
});

test('binary contract: refuses whitespace-only staged changes without an API key', async () => {
  const result = await runBinary(['--mode', 'commit-only'], whitespaceRepository);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('Only whitespace-only staged changes detected in 1 file(s).');
  expect(result.stdout).not.toContain('GOOGLE_GEMINI_API_KEY');
  expect(result.stderr).toBe('');
});

test('binary contract: reports when the working directory is not a git repository', async () => {
  const result = await runBinary(['--mode', 'commit-only'], nonRepository, 'not-a-real-key');

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('Not inside a git repository');
  expect(result.stderr).toBe('');
});

for (const inputCase of [
  { args: ['--unknown'], message: 'Unknown flag: --unknown' },
  { args: ['-x'], message: 'Unknown flag: -x' },
  { args: ['--commmit', 'abc'], message: 'Unknown flag: --commmit' },
  { args: ['--commit'], message: 'Missing value for flag: --commit' },
  { args: ['--commit='], message: 'Missing value for flag: --commit' },
  {
    args: ['--mode', 'invalid'],
    message: 'Invalid value for --mode: invalid. Expected one of: full, commit-only',
  },
  {
    args: ['--commit', 'abc', '--commit', 'def'],
    message: 'Flag may only be specified once: --commit',
  },
  { args: ['-vx'], message: 'Unknown flag: -x' },
  { args: ['-cv', 'sha'], message: 'Value-taking flag must be last in cluster: -cv' },
] as const) {
  test(`binary contract: rejects ${inputCase.args.join(' ')}`, async () => {
    expectCleanInputError(await runBinary([...inputCase.args]), inputCase.message);
  });
}

test('binary contract: accepts clustered boolean flags', async () => {
  const result = await runBinary(['-vd']);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('No staged changes found');
  expect(result.stdout).not.toContain('Unknown flag');
});

test('binary contract: treats a lone dash as positional', async () => {
  const result = await runBinary(['-']);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('No staged changes found');
  expect(result.stdout).not.toContain('Unknown flag');
});

test('binary contract: stops parsing options after --', async () => {
  const result = await runBinary(['--', '--', '--commmit']);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('No staged changes found');
  expect(result.stdout).not.toContain('Unknown flag');
});

test('binary contract: excludes a dash-prefixed sentinel from the changed-file set', async () => {
  const result = await runBinary(
    ['--mode', 'commit-only', '--exclude', '-generated/*'],
    excludeRepository,
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('Excluded 1 file(s) matching patterns: -generated/*');
  expect(result.stdout).toContain('Found 1 file(s) changed');
  expect(result.stdout).toContain('GOOGLE_GEMINI_API_KEY');
  expect(result.stdout).not.toContain('Missing value for flag: --exclude');
  expect(result.stderr).toBe('');
});

test('binary contract: accepts an exclude pattern with a space', async () => {
  const result = await runBinary(['--exclude', 'path with space/*']);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('No staged changes found');
  expect(result.stdout).not.toContain('Missing value for flag: --exclude');
});
