import { expect, test } from 'bun:test';
import { loadConfig } from '../gcm.config.js';

const DEFAULT_CONFIG = {
  model: 'gemini-3.7-flash',
  temp: 1,
  maxBuffer: 50 * 1024 * 1024,
  maxHunks: 40,
  perFileBuffer: 1024 * 1024,
  tokenRatio: 3.5,
  maxOutputTokens: 8192,
  retries: 3,
  retryBase: 1000,
  retryMax: 60000,
  freeLlmApiUrl: 'http://127.0.0.1:3001',
  freeLlmApiModel: 'auto',
  freeLlmApiToken: null,
  autoChangeset: false,
};

async function readConfig(env: Record<string, string>): Promise<unknown> {
  const config = loadConfig(env);
  return {
    model: config.MODEL,
    temp: config.TEMP,
    maxBuffer: config.CHILD_PROCESS_MAX_BUFFER,
    maxHunks: config.MAX_HUNKS,
    perFileBuffer: config.PER_FILE_BUFFER,
    tokenRatio: config.TOKEN_BYTES_RATIO,
    maxOutputTokens: config.MAX_OUTPUT_TOKENS,
    retries: config.MAX_RETRIES,
    retryBase: config.RETRY_BASE_MS,
    retryMax: config.RETRY_MAX_MS,
    freeLlmApiUrl: config.FREELLMAPI_URL,
    freeLlmApiModel: config.FREELLMAPI_MODEL,
    freeLlmApiToken: config.FREELLMAPI_TOKEN ?? null,
    autoChangeset: config.AUTO_CHANGESET,
  };
}

async function runCli(env: Record<string, string>, args: string[] = ['--version']) {
  const child = Bun.spawn({
    cmd: ['bun', 'run', './gcm.ts', ...args],
    cwd: process.cwd(),
    env: { PATH: Bun.env.PATH ?? '/usr/bin:/bin', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test('config: reads the short GCM names', async () => {
  await expect(readConfig({ GCM_MODEL: 'test-model', GCM_TEMP: '0.25' })).resolves.toEqual({
    ...DEFAULT_CONFIG,
    model: 'test-model',
    temp: 0.25,
  });
});

test('config: resolves provider credentials and LM Studio settings from supplied environment', function () {
  expect(
    loadConfig({
      GCM_PROVIDER: 'lm-studio',
      GCM_LM_STUDIO_URL: 'http://127.0.0.1:4321',
      GCM_LM_STUDIO_MODEL: 'local-model',
      LM_API_TOKEN: 'local-token',
      GOOGLE_GEMINI_API_KEY: 'gemini-key',
    }),
  ).toMatchObject({
    PROVIDER: 'lm-studio',
    LM_STUDIO_URL: 'http://127.0.0.1:4321',
    LM_STUDIO_MODEL: 'local-model',
    LM_STUDIO_TOKEN: 'local-token',
    GEMINI_API_KEY: 'gemini-key',
  });
});

test('config: automatic changesets require the literal true opt-in', async function () {
  await expect(readConfig({})).resolves.toEqual(DEFAULT_CONFIG);
  await expect(readConfig({ GCM_AUTO_CHANGESET: 'true' })).resolves.toEqual({
    ...DEFAULT_CONFIG,
    autoChangeset: true,
  });
  await expect(readConfig({ GCM_AUTO_CHANGESET: '1' })).resolves.toEqual(DEFAULT_CONFIG);
});

test('config: reads retry settings', async () => {
  await expect(
    readConfig({
      GCM_MAX_RETRIES: '2',
      GCM_RETRY_BASE_MS: '20',
      GCM_RETRY_MAX_MS: '200',
    }),
  ).resolves.toEqual({
    ...DEFAULT_CONFIG,
    retries: 2,
    retryBase: 20,
    retryMax: 200,
  });
});

test('config: allows disabling transport retries', async () => {
  await expect(readConfig({ GCM_MAX_RETRIES: '0' })).resolves.toEqual({
    ...DEFAULT_CONFIG,
    retries: 0,
  });
});

test('config: reads only FreeLLMAPI-specific names', async () => {
  await expect(
    readConfig({
      GCM_FREELLMAPI_URL: 'https://free.example/v1',
      GCM_FREELLMAPI_MODEL: 'router',
      GCM_FREELLMAPI_TOKEN: 'free-token',
      GCM_OPENAI_URL: 'https://legacy.example/v1',
      GCM_OPENAI_MODEL: 'legacy-model',
      GCM_OPENAI_TOKEN: 'legacy-token',
      OPENAI_BASE_URL: 'https://generic.example/v1',
      OPENAI_MODEL: 'generic-model',
      OPENAI_API_KEY: 'generic-token',
    }),
  ).resolves.toEqual({
    ...DEFAULT_CONFIG,
    freeLlmApiUrl: 'https://free.example/v1',
    freeLlmApiModel: 'router',
    freeLlmApiToken: 'free-token',
  });
});

test('CLI names an invalid GCM_TEMP setting', async () => {
  const result = await runCli({ GCM_TEMP: 'garbage' }, ['--providers-list']);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid GCM_TEMP');
});

test('CLI names an invalid GCM_MAX_BUFFER setting', async () => {
  const result = await runCli({ GCM_MAX_BUFFER: '-2' }, ['--providers-list']);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid GCM_MAX_BUFFER');
});

test('CLI names an invalid GCM_MAX_RETRIES setting', async () => {
  const result = await runCli({ GCM_MAX_RETRIES: '20' }, ['--providers-list']);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid GCM_MAX_RETRIES');
});

const UNSAFE_MODEL = { GCM_MODEL: 'bad\u001b[2Jmodel' };

test('an unsafe GCM_MODEL still lets the CLI answer --version', async function () {
  const result = await runCli(UNSAFE_MODEL, ['--version']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('gcm ');
});

test('an unsafe GCM_MODEL stops --providers-list with the real reason', async function () {
  const result = await runCli(UNSAFE_MODEL, ['--providers-list']);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Invalid GCM_MODEL');
});

test('--help to a non-terminal stdout has no escape sequences', async function () {
  const result = await runCli({}, ['--help']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('Usage');
  expect(result.stdout).not.toContain('\u001b[');
});

test('an unsafe GCM_MODEL still lets the CLI answer --help', async function () {
  const result = await runCli(UNSAFE_MODEL, ['--help']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('Usage');
  expect(result.stdout + result.stderr).not.toContain('Invalid GCM_MODEL');
});

test('--help wins over --models-list', async function () {
  const result = await runCli({}, ['--help', '--models-list']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('Usage');
});

test('--version wins over --providers-list', async function () {
  const result = await runCli({}, ['--version', '--providers-list']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toMatch(/^gcm \S+$/);
});

test('--version wins over --models-list', async function () {
  const result = await runCli({}, ['--version', '--models-list']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toMatch(/^gcm \S+$/);
});

test('config: an empty GCM_FREELLMAPI_MODEL uses the default', async () => {
  await expect(readConfig({ GCM_FREELLMAPI_MODEL: '' })).resolves.toEqual(DEFAULT_CONFIG);
});

test('CLI names an invalid GCM_LOG_LEVEL setting', async () => {
  const result = await runCli({ GCM_LOG_LEVEL: 'nonsense' }, ['--providers-list']);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('Invalid GCM_LOG_LEVEL');
});
