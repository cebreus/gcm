import { expect, test } from 'bun:test';

// Runs in its own process: test/list-models.test.ts installs a process-wide
// module mock for listModels that would otherwise replace the real one here.
test('listModels: sends the API key only as a request header', async function () {
  const script = `
    const apiKey = 'AIzaFakeListModelsKey1234567890';
    let requestUrl = '';
    let headerKey = null;
    globalThis.fetch = async function (input, init) {
      requestUrl = String(input);
      headerKey = new Headers(init?.headers).get('x-goog-api-key');
      return new Response(JSON.stringify({
        models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }],
      }));
    };
    const { listGeminiModels } = await import('${import.meta.dir}/../../src/gemini-client/listModels.ts');
    const models = await listGeminiModels(apiKey);
    console.log(JSON.stringify({ models, requestUrl, headerKey, leaks: requestUrl.includes(apiKey) }));
  `;
  const child = Bun.spawnSync({ cmd: [process.execPath, '-e', script], stdout: 'pipe', stderr: 'pipe' });
  const stderr = new TextDecoder().decode(child.stderr);
  expect(stderr).toBe('');
  const result = JSON.parse(new TextDecoder().decode(child.stdout)) as {
    models: string[];
    requestUrl: string;
    headerKey: string | null;
    leaks: boolean;
  };

  expect(result.models).toEqual(['models/gemini-test']);
  expect(result.leaks).toBe(false);
  expect(result.requestUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  expect(result.headerKey).toBe('AIzaFakeListModelsKey1234567890');
});
