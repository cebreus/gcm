import { expect, test } from 'bun:test';
import { createProviderFactories } from '../src/provider-factories.js';

test('LM Studio factory reads its URL when the factory runs', async function () {
  let staleRequests = 0;
  const staleServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      staleRequests += 1;
      return new Response('stale server must not be called', { status: 500 });
    },
  });
  const activeServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: function () {
      return Response.json({
        models: [
          {
            key: 'local-model',
            type: 'llm',
            max_context_length: 8_192,
            loaded_instances: [{ config: { context_length: 8_192 } }],
          },
        ],
      });
    },
  });
  const previousUrl = process.env.GCM_LM_STUDIO_URL;
  try {
    process.env.GCM_LM_STUDIO_URL = staleServer.url.origin;
    const factories = createProviderFactories(
      {},
      {
        log: function () {},
      },
    );
    process.env.GCM_LM_STUDIO_URL = activeServer.url.origin;
    const factory = factories.find(function (candidate) {
      return candidate.id === 'lm-studio';
    });
    expect(factory).toBeDefined();
    if (!factory) throw new Error('LM Studio factory not found');

    const provider = await factory.create({ probeOnly: true });

    expect(provider.defaultModel).toBe('local-model');
    expect(staleRequests).toBe(0);
  } finally {
    if (previousUrl === undefined) delete process.env.GCM_LM_STUDIO_URL;
    else process.env.GCM_LM_STUDIO_URL = previousUrl;
    await staleServer.stop(true);
    await activeServer.stop(true);
  }
});
