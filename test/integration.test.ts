import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await mock.module('@clack/prompts', () => ({
  intro: () => {},
  outro: () => {},
  spinner: () => ({ start: () => {}, stop: () => {} }),
  note: () => {},
  select: async (o: { message: string }) => {
    throw new Error(`Unexpected prompt: ${o.message}`);
  },
  text: async () => {
    throw new Error('Unexpected text prompt');
  },
  confirm: async () => {
    throw new Error('Unexpected confirm prompt');
  },
  isCancel: () => false,
  cancel: () => {},
}));

const { executeCommitMessageGeneration } = await import('../src/runner.js');

const RAW =
  'feat(app): add answer [skip ci]\n\nExplain the change.\n\nSigned-off-by: Evil <evil@example.com>\n';
const PARSED = 'feat(app): add answer\n\nExplain the change.';

const originalCwd = process.cwd();
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;
let repo = '';
let prompts: string[] = [];
let providerError: Error | null = null;

async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', ...args], cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if ((await child.exited) !== 0) throw new Error(err);
  return out;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'gcm-integration-'));
  prompts = [];
  providerError = null;
  await git('init', '--quiet');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'commit.gpgsign', 'false');
  await Bun.write(`${repo}/app.ts`, 'export const answer = 1;\n');
  await git('add', '--', 'app.ts');
  await git('commit', '--quiet', '-m', 'chore: initial');
  process.chdir(repo);
  process.exitCode = undefined;
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  await rm(repo, { recursive: true, force: true });
});

afterAll(() => {
  process.stdout.write = originalStdout;
});

// Runs the real entry point; only the language model is fake. Returns captured stdout.
async function run(...argv: string[]): Promise<string> {
  let stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await executeCommitMessageGeneration(argv, {
      isInteractive: false,
      logger: { log: () => {} },
      languageModelProvider: {
        id: 'fake',
        label: 'Fake',
        defaultModel: 'fake-model',
        models: async () => [
          {
            name: 'fake-model',
            label: 'Fake model',
            limits: { kind: 'separate' as const, maxInputTokens: 8_192, maxOutputTokens: 1_024 },
          },
        ],
        service: {
          generate: async params => {
            prompts.push(params.promptContext);
            if (providerError) throw providerError;
            return { text: RAW, usage: {} };
          },
        },
      },
    });
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  return stdout;
}

async function stage(file: string, content: string): Promise<void> {
  await Bun.write(`${repo}/${file}`, content);
  await git('add', '--', file);
}

test('--non-interactive --apply commits the parsed message', async () => {
  await stage('app.ts', 'export const answer = 42;\n');
  await run('--non-interactive', '--apply');
  expect(process.exitCode).toBe(0);
  expect(await git('rev-list', '--count', 'HEAD')).toBe('2\n');
  expect((await git('log', '-1', '--format=%B')).trim()).toBe(PARSED);
});

test('--non-interactive without --apply commits nothing', async () => {
  await stage('app.ts', 'export const answer = 42;\n');
  const before = await git('diff', '--staged');
  await run('--non-interactive');
  expect(await git('rev-list', '--count', 'HEAD')).toBe('1\n');
  expect(await git('diff', '--staged')).toBe(before);
});

test('--commit HEAD --apply amends HEAD to the parsed message', async () => {
  const tree = await git('rev-parse', 'HEAD^{tree}');
  await run('--commit', 'HEAD', '--non-interactive', '--apply');
  expect(process.exitCode).toBe(0);
  expect(await git('rev-list', '--count', 'HEAD')).toBe('1\n');
  expect((await git('log', '-1', '--format=%B')).trim()).toBe(PARSED);
  expect(await git('rev-parse', 'HEAD^{tree}')).toBe(tree);
});

test('--print writes only the parsed message to stdout', async () => {
  await stage('app.ts', 'export const answer = 42;\n');
  expect(await run('--print', '--non-interactive')).toBe(`${PARSED}\n`);
});

test('only excluded files staged: provider not called, exit 1, no commit', async () => {
  await stage('.env', 'API_KEY=hunter2\n');
  await run('--non-interactive', '--apply');
  expect(prompts).toHaveLength(0);
  expect(process.exitCode).toBe(1);
  expect(await git('rev-list', '--count', 'HEAD')).toBe('1\n');
});

test('prompt contains the staged diff but not excluded secret content', async () => {
  await stage('app.ts', 'export const answer = 42;\n');
  await stage('.env', 'API_KEY=hunter2\n');
  await run('--non-interactive');
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('export const answer = 42;');
  expect(prompts[0]).not.toContain('hunter2');
});

test('a provider failure surfaces once, exits 1 and commits nothing', async () => {
  await stage('app.ts', 'export const answer = 42;\n');
  providerError = new Error('MAX_TOKENS');
  await run('--non-interactive', '--apply');
  expect(process.exitCode).toBe(1);
  expect(prompts).toHaveLength(1);
  expect(await git('rev-list', '--count', 'HEAD')).toBe('1\n');
});
