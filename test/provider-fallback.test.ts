import { expect, test } from 'bun:test';
import { loadConfig } from '../gcm.config.js';
import { createGeminiProvider } from '../src/gemini-provider.js';
import { createFreeLlmApiProvider } from '../src/freellmapi-provider.js';

for (const kind of ['gemini', 'freellmapi'] as const) {
  for (const scenario of [
    'unavailable',
    'auth',
    'malformed',
    'small-fallback',
    'explicit-model',
  ] as const) {
    test(`${kind === 'gemini' ? 'gemini fallback respects' : 'freellmapi does not fall back on'} ${scenario}`, async function () {
      const primary = kind === 'gemini' ? 'gemini-3.5-flash-lite' : 'free-router';
      const fallback = kind === 'gemini' ? 'gemini-3.5-flash' : 'kilo-auto';
      const calls: string[] = [];
      const notices: string[] = [];
      const names = [primary, fallback];
      const config = loadConfig({ GOOGLE_GEMINI_API_KEY: 'test-key', GCM_MAX_RETRIES: '0' });
      async function respond(request: Request): Promise<Response> {
        if (request.method === 'GET')
          return Response.json({
            data: names.map((id, i) => ({
              id,
              context_window: scenario === 'small-fallback' && i === 1 ? 100 : 32_000,
            })),
          });
        const body = (await request.json()) as { model: string };
        calls.push(body.model);
        if (calls.length === 1) {
          if (scenario === 'malformed') return new Response('{bad JSON');
          return Response.json(
            { error: 'unavailable' },
            { status: scenario === 'auth' ? 401 : 404 },
          );
        }
        return Response.json({
          choices: [{ message: { content: 'fix: recover availability' }, finish_reason: 'stop' }],
        });
      }
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: respond });
      try {
        const provider =
          kind === 'gemini'
            ? createGeminiProvider({
                config,
                logger: {
                  log: function (_level, text) {
                    notices.push(text);
                  },
                },
                listModels: async function () {
                  return names.map((name, i) => ({
                    name,
                    label: name,
                    limits: {
                      kind: 'separate' as const,
                      maxInputTokens: scenario === 'small-fallback' && i === 1 ? 100 : 32_000,
                      maxOutputTokens: 8192,
                    },
                  }));
                },
                fetchImpl: async function (_input, init) {
                  return respond(new Request(server.url, init));
                },
              })
            : await createFreeLlmApiProvider({
                config,
                baseUrl: server.url.origin,
                model: primary,
              });
        const result = provider.service.generate({
          meta: {},
          modelName: scenario === 'explicit-model' ? fallback : primary,
          systemPrompt: 'rules',
          promptContext: 'diff',
          maxOutputTokens: 100,
        });
        if (scenario === 'unavailable' && kind === 'gemini') {
          await expect(result).resolves.toMatchObject({ text: 'fix: recover availability' });
          expect(calls).toEqual([primary, fallback]);
          expect(notices).toHaveLength(1);
        } else {
          await expect(result).rejects.toThrow();
          expect(calls).toHaveLength(1);
          expect(notices).toHaveLength(0);
        }
      } finally {
        await server.stop(true);
      }
    });
  }
}

test('Gemini timeout uses availability fallback, caller cancellation does not', async function () {
  for (const name of ['TimeoutError', 'AbortError']) {
    let calls = 0;
    const provider = createGeminiProvider({
      config: loadConfig({ GOOGLE_GEMINI_API_KEY: 'test-key', GCM_MAX_RETRIES: '0' }),
      logger: { log: function () {} },
      listModels: async function () {
        return ['gemini-3.5-flash-lite', 'gemini-3.5-flash'].map(model => ({
          name: model,
          label: model,
          limits: { kind: 'separate' as const, maxInputTokens: 32_000, maxOutputTokens: 8192 },
        }));
      },
      fetchImpl: async function () {
        calls += 1;
        if (calls === 1) throw new DOMException('request stopped', name);
        return Response.json({ choices: [{ message: { content: 'fix: recover timeout' } }] });
      },
    });
    const result = provider.service.generate({
      meta: {},
      modelName: 'gemini-3.5-flash-lite',
      systemPrompt: 'rules',
      promptContext: 'diff',
      maxOutputTokens: 100,
    });
    if (name === 'TimeoutError') {
      await expect(result).resolves.toMatchObject({ text: 'fix: recover timeout' });
      expect(calls).toBe(2);
    } else {
      await expect(result).rejects.toThrow('timed out');
      expect(calls).toBe(1);
    }
  }
});
