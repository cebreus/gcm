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
const flowRepositories: string[] = [];

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

function controlledEnvironment(
  apiKey?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: Bun.env.PATH ?? '/usr/bin:/bin',
    HOME: tempRoot,
    NO_COLOR: '1',
    TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GOOGLE_GEMINI_API_KEY: apiKey ?? '',
    ...extra,
  };
}

async function runSubprocess(
  command: string[],
  cwd: string,
  apiKey?: string,
  extraEnvironment?: Record<string, string>,
): Promise<BinaryResult> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: controlledEnvironment(apiKey, extraEnvironment),
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

async function runBinaryWithProvider(
  args: string[],
  cwd: string,
  extraEnvironment?: Record<string, string>,
): Promise<BinaryResult> {
  const result = await runSubprocess(
    ['bun', '--preload', providerPreload, binaryPath, '--model', 'gemini-3.7-flash', ...args],
    cwd,
    'fake-key',
    extraEnvironment,
  );
  return {
    exitCode: result.exitCode,
    stdout: clean(result.stdout),
    stderr: clean(result.stderr),
  };
}

async function createCommittedRepository(): Promise<string> {
  const repository = await mkdtemp(`${tempRoot}/gcm-binary-contract-flow-`);
  flowRepositories.push(repository);
  await runCommand(['git', 'init', '--quiet', '--initial-branch=main'], repository);
  await runCommand(['git', 'config', 'user.email', 'test@gcm.local'], repository);
  await runCommand(['git', 'config', 'user.name', 'GCM Test'], repository);
  await Bun.write(`${repository}/file.txt`, 'first\n');
  await runCommand(['git', 'add', 'file.txt'], repository);
  await runCommand(['git', 'commit', '-qm', 'feat: first subject'], repository);
  await Bun.write(`${repository}/file.txt`, 'second\n');
  await runCommand(['git', 'commit', '-qam', 'feat: second subject'], repository);
  return repository;
}

async function readSubjects(repository: string): Promise<string[]> {
  return (await runCommand(['git', 'log', '--format=%s'], repository)).stdout.trim().split('\n');
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
  const lines = result.stderr.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(message);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain('at ');
  expect(result.stderr).not.toContain('function(');
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
    `globalThis.fetch = async function (input) {
      if (!String(input).includes('/chat/completions')) {
        return Response.json({ models: [{ name: 'models/gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 }] });
      }
      if (process.env.FAKE_CHAT_STATUS) {
        return new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: Number(process.env.FAKE_CHAT_STATUS) });
      }
      return new Response(JSON.stringify({
choices: [{ finish_reason: process.env.FAKE_FINISH_REASON ?? 'stop', message: { role: 'assistant', content: 'fix: corrected message' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 }
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
    ...flowRepositories.map(repository => rm(repository, { recursive: true, force: true })),
  ]);
});

test.skipIf(expectPath === null)(
  'binary contract: amend! is confirmed, created, and never rebased automatically (requires expect PTY)',
  async () => {
    const target = (
      await runCommand(['git', 'rev-parse', 'HEAD~1'], rewordRepository)
    ).stdout.trim();
    const result = await runInteractiveBinary(
      ['--commit', target, '--model', 'gemini-3.7-flash'],
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
    expect(subjects).toEqual([`amend! ${target}`, 'feat: later work', 'feat: original subject']);
  },
);

for (const provider of ['codex', 'claude']) {
  for (const mode of ['print', 'apply', 'auth', 'truncated']) {
    test(`binary contract: ${provider} CLI ${mode}`, async function () {
      const repository = await createCommittedRepository();
      await Bun.write(`${repository}/file.txt`, 'third\n');
      await runCommand(['git', 'add', 'file.txt'], repository);
      const head = (await runCommand(['git', 'rev-parse', 'HEAD'], repository)).stdout;
      const staged = (await runCommand(['git', 'diff', '--cached'], repository)).stdout;
      const bin = `${binaryDirectory}/fake-${provider}-${mode}`;
      const executable = `${bin}/${provider}`;
      await Bun.write(
        executable,
        `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes('status')) {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLI_MODE !== 'auth' }));
  process.exit(process.env.FAKE_CLI_MODE === 'auth' ? 1 : 0);
}
if (process.cwd() === process.env.FAKE_REPOSITORY) throw new Error('CLI must not run in repository');
const prompt = await Bun.stdin.text();
if (!prompt.includes('third')) throw new Error('missing staged context');
const count = process.env.FAKE_CLI_MODE === 'truncated' ? 900000 : 8;
if (${JSON.stringify(provider)} === 'codex') {
  if (!args.includes('--ephemeral') || !args.includes('read-only') || !args.includes('shell_tool')) throw new Error('unsafe Codex arguments');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fix: local CLI message' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { output_tokens: count } }));
} else {
  if (!args.includes('--safe-mode') || args[args.indexOf('--tools') + 1] !== '') throw new Error('unsafe Claude arguments');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fix: local CLI message', usage: { output_tokens: count } }));
}
`,
      );
      await runCommand(['chmod', '+x', executable], repository);
      const result = await runSubprocess(
        [
          'bun',
          binaryPath,
          '--provider',
          `${provider}-cli`,
          ...(mode === 'apply' ? ['--non-interactive', '--apply'] : ['--print']),
        ],
        repository,
        undefined,
        {
          PATH: `${bin}:${Bun.env.PATH ?? '/usr/bin:/bin'}`,
          FAKE_CLI_MODE: mode,
          FAKE_REPOSITORY: repository,
        },
      );
      if (mode === 'auth' || mode === 'truncated') {
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
      } else {
        expect(result.exitCode).toBe(0);
        if (mode === 'print') expect(result.stdout.trim()).toBe('fix: local CLI message');
      }
      if (mode === 'apply') {
        expect((await readSubjects(repository))[0]).toBe('fix: local CLI message');
        expect((await runCommand(['git', 'status', '--porcelain'], repository)).stdout).toBe('');
      } else {
        expect((await runCommand(['git', 'rev-parse', 'HEAD'], repository)).stdout).toBe(head);
        expect((await runCommand(['git', 'diff', '--cached'], repository)).stdout).toBe(staged);
      }
    });
  }
}

test('binary contract: non-interactive generation stays read-only without --apply', async () => {
  const repository = await createCommittedRepository();
  await Bun.write(`${repository}/file.txt`, 'third\n');
  await runCommand(['git', 'add', 'file.txt'], repository);

  const result = await runBinaryWithProvider(['--non-interactive'], repository);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('fix: corrected message');
  expect(await readSubjects(repository)).toEqual(['feat: second subject', 'feat: first subject']);
});

test('binary contract: --print writes only generated message and stays read-only', async () => {
  const repository = await createCommittedRepository();
  await Bun.write(`${repository}/file.txt`, 'third\n');
  await runCommand(['git', 'add', 'file.txt'], repository);
  const result = await runBinaryWithProvider(['--print'], repository);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('fix: corrected message\n');
  expect(await readSubjects(repository)).toEqual(['feat: second subject', 'feat: first subject']);
});
test('binary contract: --print refuses truncated generated message', async () => {
  const repository = await createCommittedRepository();
  await Bun.write(`${repository}/file.txt`, 'third\n');
  await runCommand(['git', 'add', 'file.txt'], repository);
  const result = await runBinaryWithProvider(['--print'], repository, {
    FAKE_FINISH_REASON: 'length',
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Refusing to print it.');
});
test('binary contract: --print=true argument error keeps stdout empty', async () => {
  const result = await runBinary(['--print=true', '--apply']);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toBe('');
});
test('binary contract: --print keeps stdout empty on provider failure', async () => {
  const repository = await createCommittedRepository();
  await Bun.write(`${repository}/file.txt`, 'third\n');
  await runCommand(['git', 'add', 'file.txt'], repository);
  const result = await runSubprocess(
    ['bun', '--preload', providerPreload, binaryPath, '--model', 'gemini-3.7-flash', '--print'],
    repository,
    'fake-key',
    { FAKE_CHAT_STATUS: '400' },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toBe('');
});
test('binary contract: --print keeps stdout empty without staged changes', async () => {
  const result = await runBinaryWithProvider(['--print'], gitRepository);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toBe('');
});
test('binary contract: --apply commits the staged changes with the generated message', async () => {
  const repository = await createCommittedRepository();
  await Bun.write(`${repository}/file.txt`, 'third\n');
  await runCommand(['git', 'add', 'file.txt'], repository);

  const result = await runBinaryWithProvider(['--non-interactive', '--apply'], repository);

  expect(result.exitCode).toBe(0);
  expect(await readSubjects(repository)).toEqual([
    'fix: corrected message',
    'feat: second subject',
    'feat: first subject',
  ]);
  expect((await runCommand(['git', 'status', '--porcelain'], repository)).stdout).toBe('');
});

test('binary contract: --commit-range --apply adds one amend! per target and skips them on a re-run', async () => {
  const repository = await createCommittedRepository();
  await Bun.write(`${repository}/file.txt`, 'third\n');
  await runCommand(['git', 'commit', '-qam', 'feat: third subject'], repository);
  const [third, second, first] = (
    await runCommand(['git', 'log', '--format=%H'], repository)
  ).stdout
    .trim()
    .split('\n');
  const args = ['--commit-range', `${first}..HEAD`, '--non-interactive', '--apply'];
  const expected = [
    `amend! ${third}`,
    `amend! ${second}`,
    'feat: third subject',
    'feat: second subject',
    'feat: first subject',
  ];

  const result = await runBinaryWithProvider(args, repository);

  expect(result.exitCode).toBe(0);
  expect(await readSubjects(repository)).toEqual(expected);

  const repeated = await runBinaryWithProvider(args, repository);

  expect(repeated.exitCode).toBe(0);
  expect(repeated.stdout).toContain('0 completed, 2 skipped');
  expect(await readSubjects(repository)).toEqual(expected);
});

test('binary contract: a provider failure is reported once', async () => {
  const repository = await createCommittedRepository();
  await Bun.write(`${repository}/file.txt`, 'third\n');
  await runCommand(['git', 'add', 'file.txt'], repository);

  const result = await runSubprocess(
    [
      'bun',
      '--preload',
      providerPreload,
      binaryPath,
      '--model',
      'gemini-3.7-flash',
      '--non-interactive',
    ],
    repository,
    'fake-key',
    { FAKE_CHAT_STATUS: '400' },
  );

  expect(result.exitCode).toBe(1);
  const reports =
    `${clean(result.stdout)}\n${clean(result.stderr)}`.match(/quota exhausted/g) ?? [];
  expect(reports).toHaveLength(1);
});
test('binary contract: GCM_MAX_BUFFER limits Git output', async () => {
  const repository = await createCommittedRepository();
  await Bun.write(`${repository}/long-file-name.txt`, 'content\n');
  await runCommand(['git', 'add', 'long-file-name.txt'], repository);
  const result = await runBinaryWithProvider([], repository, { GCM_MAX_BUFFER: '8' });
  expect(result.exitCode).toBe(1);
  expect(`${result.stdout}${result.stderr}`).toContain('output was truncated');
});

test('binary contract: an invalid configuration value is reported without a stack trace', async () => {
  const result = await runSubprocess([binaryPath, '--providers-list'], gitRepository, undefined, {
    GCM_MAX_HUNKS: 'abc',
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('gcm: Invalid GCM_MAX_HUNKS\n');
});

test('binary contract: invalid project configuration stops generation', async function () {
  const path = `${gitRepository}/.gcmrc.json`;
  await Bun.write(path, '{"model":"untrusted"}');
  try {
    const result = await runBinaryWithProvider([], gitRepository);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim().split('\n').at(-1)).toContain(
      'Error: Invalid .gcmrc.json: unknown key "model".',
    );
  } finally {
    await rm(path, { force: true });
  }
});

test('binary contract: reports its bundled package version outside the repository', async () => {
  const result = await runBinary(['--version'], nonRepository);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`gcm ${packageVersion}\n`);
  expect(result.stderr).toBe('');
});

test('binary contract: shows documented help', async () => {
  const result = await runBinary(['--help']);

  expect(result.exitCode).toBe(0);
  for (const flag of [
    '--commit',
    '--commit-range',
    '--help',
    '--version',
    '--verbose',
    '--debug',
    '--exclude',
    '--model',
    '--provider',
    '--hint',
    '--models-list',
    '--providers-list',
    '--non-interactive',
    '--apply',
  ]) {
    expect(result.stdout).toContain(flag);
  }
  expect(result.stdout).toContain("gcm --commit-range 'abc123^..def456'");
  expect(result.stdout).toContain(
    '\n        Generate from abc123 through def456; ^ includes abc123.\n',
  );
  expect(result.stdout).not.toContain('--list-');
  const wideLines = Bun.stripANSI(result.stdout)
    .split('\n')
    .filter(line => line.length > 80);
  expect(wideLines).toEqual([]);
  expect(result.stdout).toContain('GCM_PROVIDER=lm-studio gcm');
  expect(result.stdout).toContain('gemini, freellmapi, lm-studio');
  expect(result.stderr).toBe('');
});

test('binary contract: reports no staged changes without calling Gemini', async () => {
  const result = await runBinary([], gitRepository, 'not-a-real-key');

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('No staged changes found');
  expect(result.stderr).toContain('Use "git add" to stage files.');
});

test('binary contract: reports a missing Gemini API key', async () => {
  const result = await runBinary([], excludeRepository);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('GOOGLE_GEMINI_API_KEY');
});

test('binary contract: reports conflicts before showing settings', async () => {
  const result = await runBinary([], conflictRepository, 'not-a-real-key');

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    'Git index has unresolved conflicts. Resolve conflicts before generating or committing.',
  );
  expect(result.stdout).not.toContain('Settings:');
});

test('binary contract: an unconfigured run still shows configuration', async () => {
  const result = await runBinary([], excludeRepository, 'not-a-real-key');

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('Settings: [Provider: Gemini] [Model: gemini-3.7-flash]');
  expect(result.stderr).toBe('');
});

test('binary contract: analyses whitespace-only staged changes as is', async () => {
  const result = await runBinaryWithProvider(['--print'], whitespaceRepository);

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim().length).toBeGreaterThan(0);
  expect(result.stderr).not.toContain('whitespace-only');
});

test('binary contract: reports when the working directory is not a git repository', async () => {
  const result = await runBinary([], nonRepository, 'not-a-real-key');

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Not inside a git repository');
});

for (const inputCase of [
  { args: ['--unknown'], message: 'Unknown flag: --unknown' },
  { args: ['-x'], message: 'Unknown flag: -x' },
  { args: ['--commmit', 'abc'], message: 'Unknown flag: --commmit' },
  { args: ['--commit'], message: 'Missing value for flag: --commit' },
  { args: ['--commit='], message: 'Missing value for flag: --commit' },
  {
    args: ['--mode', 'commit-only'],
    message: 'Unknown flag: --mode',
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

test('binary contract: rejects a lone positional argument', async () => {
  const result = await runBinary(['-']);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Unexpected positional argument');
});

test('binary contract: rejects positional arguments after --', async () => {
  const result = await runBinary(['--', '--', '--commmit']);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Unexpected positional argument');
});

test('binary contract: excludes a dash-prefixed sentinel from the changed-file set', async () => {
  const result = await runBinary(['--exclude', '-generated/*'], excludeRepository);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain('Excluded 1 file(s) matching patterns: -generated/*');
  expect(result.stdout).toContain('Found 1 file(s) changed');
  expect(result.stderr).toContain('GOOGLE_GEMINI_API_KEY');
  expect(result.stdout).not.toContain('Missing value for flag: --exclude');
  expect(result.stderr).not.toContain('Missing value for flag: --exclude');
});

test('binary contract: accepts an exclude pattern with a space', async () => {
  const result = await runBinary(['--exclude', 'path with space/*']);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('No staged changes found');
  expect(result.stdout).not.toContain('Missing value for flag: --exclude');
});

test('binary contract: --debug and GCM_DEBUG_API print API traces to stderr', async () => {
  const repository = await createCommittedRepository();
  await Bun.write(`${repository}/file.txt`, 'third\n');
  await runCommand(['git', 'add', 'file.txt'], repository);

  const quiet = await runBinaryWithProvider(['--print'], repository);
  expect(quiet.stderr).not.toContain('Gemini API request');
  expect(quiet.stderr).not.toContain('Gemini API response');

  const flagged = await runBinaryWithProvider(['--print', '--debug'], repository);
  const environment = await runBinaryWithProvider(['--print'], repository, {
    GCM_DEBUG_API: 'true',
  });
  for (const result of [flagged, environment]) {
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('fix: corrected message\n');
    expect(result.stderr).toContain('Gemini API request');
    expect(result.stderr).toContain('Gemini API response');
  }
});

test('binary contract: an argument error goes to stderr only', async () => {
  const result = await runBinary(['--bogus']);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Unknown flag: --bogus');
});

test('binary contract: a missing repository is reported on stderr only', async () => {
  const result = await runBinary([], nonRepository, 'not-a-real-key');

  expect(result.exitCode).toBe(1);
  expect(result.stdout).not.toContain('Not inside a git repository');
  expect(result.stderr).toContain('Not inside a git repository');
});

test('binary contract: --apply without --non-interactive is reported on stderr only', async () => {
  const result = await runBinary(['--apply'], excludeRepository, 'not-a-real-key');

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('--apply');
});

test('binary contract: --version ignores invalid configuration', async () => {
  const result = await runSubprocess([binaryPath, '--version'], nonRepository, undefined, {
    GCM_TEMP: 'abc',
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`gcm ${packageVersion}\n`);
});

const misconfigurations: Array<Record<string, string>> = [
  { GCM_TEMP: 'abc' },
  { GCM_PROVIDER: 'bogus' },
];
for (const environment of misconfigurations) {
  test(`binary contract: --help survives ${Object.keys(environment)[0]} misconfiguration`, async () => {
    const result = await runSubprocess(
      [binaryPath, '--help'],
      nonRepository,
      undefined,
      environment,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--commit-range');
  });
}
