import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import pkg from '../package.json';

const ansiEscape = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const tempRoot = Bun.env.TMPDIR ?? '/tmp';
const packageVersion = pkg.version;
const expectPath = Bun.which('expect');
let binaryDirectory = '';
let binaryPath = '';
let gitRepository = '';
let nonRepository = '';
let whitespaceRepository = '';
let excludeRepository = '';
let conflictRepository = '';
let rewordRepository = '';
let providerPreload = '';

interface BinaryResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function clean(text: string): string {
  return text.replace(ansiEscape, '');
}

function escapeTclDoubleQuoted(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('$', '\\$')
    .replaceAll('[', '\\[')
    .replaceAll('"', '\\"');
}

function controlledEnvironment(apiKey?: string): Record<string, string> {
  return {
    PATH: Bun.env.PATH ?? '/usr/bin:/bin',
    HOME: tempRoot,
    NO_COLOR: '1',
    TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GOOGLE_GEMINI_API_KEY: apiKey ?? '',
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

async function runInteractiveBinary(args: string[], cwd: string): Promise<BinaryResult> {
  if (expectPath === null) throw new Error('expect PTY is unavailable.');
  const command = ['bun', '--preload', providerPreload, binaryPath, ...args]
    .map(value => `'${value.replaceAll("'", "'\\''")}'`)
    .join(' ');
  const shellCommand = escapeTclDoubleQuoted(`stty rows 40 columns 200; exec ${command}`);
  const script = [
    'set timeout 10',
    `spawn -noecho sh -c "${shellCommand}"`,
    'expect {',
    '  "Reword via amend! commit; manual rebase required" { send "\\r" }',
    '  timeout { exit 124 }',
    '}',
    'expect eof',
    'catch wait result',
    'exit [lindex $result 3]',
  ].join('\n');
  const child = Bun.spawn({
    cmd: [expectPath, '-c', script],
    cwd,
    env: controlledEnvironment('fake-key'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout: clean(stdout), stderr: clean(stderr) };
}

function expectCleanInputError(result: BinaryResult, message: string): void {
  expect(result.exitCode).not.toBe(0);
  const lines = result.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(message);
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
  conflictRepository = await mkdtemp(`${tempRoot}/gcm-binary-contract-conflict-`);
  rewordRepository = await mkdtemp(`${tempRoot}/gcm-binary-contract-reword-`);
  providerPreload = `${binaryDirectory}/provider-preload.ts`;

  await Bun.write(
    providerPreload,
    `globalThis.fetch = async function () {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '<<START>>fix: corrected message<<END>>' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 }
      }));
    } as typeof fetch;`,
  );

  await runCommand(
    ['bun', 'build', './gcm.ts', '--outfile', binaryPath, '--target=bun', '--minify'],
    process.cwd(),
  );
  for (const repository of [
    gitRepository,
    whitespaceRepository,
    excludeRepository,
    rewordRepository,
  ]) {
    await runCommand(['git', 'init', '--quiet'], repository);
  }
  await runCommand(['git', 'init', '--quiet', '--initial-branch=main'], conflictRepository);
  await runCommand(['git', 'config', 'user.email', 'test@gcm.local'], conflictRepository);
  await runCommand(['git', 'config', 'user.name', 'GCM Test'], conflictRepository);

  await runCommand(['git', 'config', 'user.email', 'test@gcm.local'], rewordRepository);
  await runCommand(['git', 'config', 'user.name', 'GCM Test'], rewordRepository);
  await Bun.write(`${rewordRepository}/file.txt`, 'first\n');
  await runCommand(['git', 'add', 'file.txt'], rewordRepository);
  await runCommand(['git', 'commit', '-qm', 'feat: original subject'], rewordRepository);
  await Bun.write(`${rewordRepository}/file.txt`, 'second\n');
  await runCommand(['git', 'commit', '-am', 'feat: later work', '--quiet'], rewordRepository);

  await Bun.write(`${whitespaceRepository}/document.txt`, 'first line\n');
  await runCommand(['git', 'add', 'document.txt'], whitespaceRepository);
  await runCommand(
    [
      'git',
      '-c',
      'user.email=test@gcm.local',
      '-c',
      'user.name=GCM Test',
      'commit',
      '-qm',
      'initial',
    ],
    whitespaceRepository,
  );
  await Bun.write(`${whitespaceRepository}/document.txt`, 'first line \n');
  await runCommand(['git', 'add', 'document.txt'], whitespaceRepository);

  await runCommand(['mkdir', '-p', './-generated'], excludeRepository);
  await Bun.write(`${excludeRepository}/-generated/sentinel.txt`, 'do not send\n');
  await Bun.write(`${excludeRepository}/included.txt`, 'send this\n');
  await runCommand(
    ['git', 'add', '--', '-generated/sentinel.txt', 'included.txt'],
    excludeRepository,
  );

  await Bun.write(`${conflictRepository}/file.txt`, 'base\n');
  await runCommand(['git', 'add', 'file.txt'], conflictRepository);
  await runCommand(['git', 'commit', '-qm', 'base'], conflictRepository);
  await runCommand(['git', 'checkout', '-qb', 'other'], conflictRepository);
  await Bun.write(`${conflictRepository}/file.txt`, 'other\n');
  await runCommand(['git', 'commit', '-am', 'other', '--quiet'], conflictRepository);
  await runCommand(['git', 'checkout', '-q', 'main'], conflictRepository);
  await Bun.write(`${conflictRepository}/file.txt`, 'main\n');
  await runCommand(['git', 'commit', '-am', 'main', '--quiet'], conflictRepository);
  const merge = await runSubprocess(['git', 'merge', 'other'], conflictRepository);
  if (merge.exitCode === 0) throw new Error('Expected test repository merge to conflict.');
}, 60_000);

afterAll(async () => {
  await Promise.all([
    rm(binaryDirectory, { recursive: true, force: true }),
    rm(gitRepository, { recursive: true, force: true }),
    rm(nonRepository, { recursive: true, force: true }),
    rm(whitespaceRepository, { recursive: true, force: true }),
    rm(excludeRepository, { recursive: true, force: true }),
    rm(conflictRepository, { recursive: true, force: true }),
    rm(rewordRepository, { recursive: true, force: true }),
  ]);
});

test.skipIf(expectPath === null)(
  'binary contract: amend! is confirmed, created, and never rebased automatically (requires expect PTY)',
  async () => {
    const target = (
      await runCommand(['git', 'rev-parse', 'HEAD~1'], rewordRepository)
    ).stdout.trim();
    const result = await runInteractiveBinary(
      ['--commit', target, '--model', 'gemini-3.7-flash', '--mode', 'commit-only'],
      rewordRepository,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Interactive binary failed (${result.exitCode}):\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Reword via amend! commit; manual rebase required');
    expect(result.stdout).toContain('git rebase --autosquash');
    const subjects = (
      await runCommand(['git', 'log', '-3', '--format=%s'], rewordRepository)
    ).stdout
      .trim()
      .split('\n');
    expect(subjects).toEqual([
      'amend! feat: original subject',
      'feat: later work',
      'feat: original subject',
    ]);
  },
);

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
  expect(result.stdout).toContain('Use "git add" to stage files.');
  expect(result.stderr).toBe('');
});

test('binary contract: reports a missing Gemini API key', async () => {
  const result = await runBinary([], excludeRepository);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('GOOGLE_GEMINI_API_KEY');
  expect(result.stderr).toBe('');
});

test('binary contract: reports conflicts before showing settings', async () => {
  const result = await runBinary([], conflictRepository, 'not-a-real-key');

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain(
    'Git index has unresolved conflicts. Resolve conflicts before generating or committing.',
  );
  expect(result.stdout).not.toContain('Settings:');
  expect(result.stderr).toBe('');
});

test('binary contract: one generation setting still shows configuration', async () => {
  const result = await runBinary(['--mode', 'full'], excludeRepository, 'not-a-real-key');

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    'Settings: [Provider: Gemini] [Model: gemini-3.7-flash] [Mode: Full Report]',
  );
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
