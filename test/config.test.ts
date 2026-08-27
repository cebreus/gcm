import { expect, test } from 'bun:test';

const DEFAULT_CONFIG = {
  model: 'gemini-3.7-flash',
  temp: 1,
  maxBuffer: 50 * 1024 * 1024,
  maxHunks: 40,
  perFileBuffer: 1024 * 1024,
  tokenRatio: 3.5,
  maxOutputTokens: 8192,
  debugBytes: 32768,
  retries: 3,
  retryBase: 1000,
  retryMax: 60000,
  freeLlmApiUrl: 'http://127.0.0.1:3001',
  freeLlmApiModel: 'auto',
  freeLlmApiToken: null,
};

async function readConfig(env: Record<string, string>): Promise<unknown> {
  const child = Bun.spawn({
    cmd: [
      'bun',
      '-e',
      "import { CONFIG } from './gcm.config.ts'; console.log(JSON.stringify({ model: CONFIG.MODEL, temp: CONFIG.TEMP, maxBuffer: CONFIG.CHILD_PROCESS_MAX_BUFFER, maxHunks: CONFIG.MAX_HUNKS, perFileBuffer: CONFIG.PER_FILE_BUFFER, tokenRatio: CONFIG.TOKEN_BYTES_RATIO, maxOutputTokens: CONFIG.MAX_OUTPUT_TOKENS, debugBytes: CONFIG.DEBUG_MAX_BODY_LOG_BYTES, retries: CONFIG.MAX_RETRIES, retryBase: CONFIG.RETRY_BASE_MS, retryMax: CONFIG.RETRY_MAX_MS, freeLlmApiUrl: CONFIG.FREELLMAPI_URL, freeLlmApiModel: CONFIG.FREELLMAPI_MODEL, freeLlmApiToken: CONFIG.FREELLMAPI_TOKEN ?? null }));",
    ],
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
  expect(exitCode, stderr).toBe(0);
  const config: unknown = JSON.parse(stdout);
  return config;
}

test('config: reads the short GCM names', async () => {
  await expect(readConfig({ GCM_MODEL: 'test-model', GCM_TEMP: '0.25' })).resolves.toEqual({
    ...DEFAULT_CONFIG,
    model: 'test-model',
    temp: 0.25,
  });
});

test('config: reads general retry names before legacy Gemini aliases', async () => {
  await expect(
    readConfig({
      GCM_MAX_RETRIES: '2',
      GCM_RETRY_BASE_MS: '20',
      GCM_RETRY_MAX_MS: '200',
      GCM_GEMINI_MAX_RETRIES: '4',
      GCM_GEMINI_RETRY_BASE_MS: '40',
      GCM_GEMINI_RETRY_MAX_MS: '400',
    }),
  ).resolves.toEqual({
    ...DEFAULT_CONFIG,
    retries: 2,
    retryBase: 20,
    retryMax: 200,
  });

  await expect(
    readConfig({
      GCM_GEMINI_MAX_RETRIES: '4',
      GCM_GEMINI_RETRY_BASE_MS: '40',
      GCM_GEMINI_RETRY_MAX_MS: '400',
    }),
  ).resolves.toEqual({
    ...DEFAULT_CONFIG,
    retries: 4,
    retryBase: 40,
    retryMax: 400,
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

test('config: rejects unsafe numeric values by using safe defaults', async () => {
  await expect(
    readConfig({
      GCM_TEMP: 'garbage',
      GCM_MAX_BUFFER: '-2',
      GCM_MAX_HUNKS: '9007199254740991',
      GCM_PER_FILE_BUFFER: '9007199254740991',
      GCM_TOKEN_BYTES_RATIO: '5e-324',
      GCM_MAX_OUTPUT_TOKENS: '1e100',
      GCM_DEBUG_MAX_BODY_LOG_BYTES: '9007199254740991',
      GCM_MAX_RETRIES: '9007199254740991',
      GCM_RETRY_BASE_MS: '9007199254740991',
      GCM_RETRY_MAX_MS: '9007199254740991',
    }),
  ).resolves.toEqual(DEFAULT_CONFIG);
  await expect(readConfig({ GCM_TEMP: '   ' })).resolves.toEqual(DEFAULT_CONFIG);
});
