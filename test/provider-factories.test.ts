import { expect, test } from 'bun:test';

import { loadConfig } from '../gcm.config.js';
import { createProviderFactories } from '../src/provider-factories.js';

test('local CLI registration follows installed binaries without probing during help', async () => {
  const calls: string[][] = [];
  const factories = createProviderFactories(
    {
      which: function (command) {
        return command === 'codex' ? '/fake/codex' : null;
      },
      localCliRun: async function (request) {
        calls.push(request.cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    { log: function () {} },
    false,
    loadConfig({}),
  );
  expect(factories.map((factory) => factory.id)).toEqual([
    'gemini',
    'freellmapi',
    'lm-studio',
    'codex-cli',
  ]);
  expect(calls).toEqual([]);
  const provider = await factories.at(-1)?.create({ probeOnly: true });
  expect(provider?.id).toBe('codex-cli');
  expect(calls).toEqual([['/fake/codex', 'login', 'status']]);
});

test('Claude factory refuses a logged-out CLI even when status exits zero', async () => {
  const factories = createProviderFactories(
    {
      which: function (command) {
        return command === 'claude' ? '/fake/claude' : null;
      },
      localCliRun: async function () {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ loggedIn: false }),
          stderr: '',
        };
      },
    },
    { log: function () {} },
    false,
    loadConfig({}),
  );
  await expect(factories.at(-1)?.create({ probeOnly: true })).rejects.toThrow(
    'login is required',
  );
});

test('Copilot factory registers an installed binary without an auth side effect', async () => {
  const calls: string[][] = [];
  const factories = createProviderFactories(
    {
      which: function (command) {
        return command === 'copilot' ? '/fake/copilot' : null;
      },
      localCliRun: async function (request) {
        calls.push(request.cmd);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    { log: function () {} },
    false,
    loadConfig({}),
  );

  expect(factories.map((factory) => factory.id)).toContain('copilot-cli');
  const provider = await factories.at(-1)?.create({ probeOnly: true });
  expect(provider?.id).toBe('copilot-cli');
  expect(calls).toEqual([]);
});

test('injected factories keep precedence over local CLI discovery', () => {
  const factories: [] = [];
  expect(
    createProviderFactories(
      {
        languageModelProviderFactories: factories,
        which: function () {
          throw new Error('must not discover');
        },
      },
      { log: function () {} },
      false,
      loadConfig({}),
    ),
  ).toBe(factories);
});

test('LM Studio factory reads its URL when the factory runs', async () => {
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
  const {
    env: { GCM_LM_STUDIO_URL: previousUrl },
  } = process;
  try {
    const {
      url: { origin: staleOrigin },
    } = staleServer;
    process.env.GCM_LM_STUDIO_URL = staleOrigin;
    const factories = createProviderFactories(
      {},
      {
        log: function () {},
      },
      false,
      loadConfig({ GCM_LM_STUDIO_URL: activeServer.url.origin }),
    );
    const {
      url: { origin: activeOrigin },
    } = activeServer;
    process.env.GCM_LM_STUDIO_URL = activeOrigin;
    const factory = factories.find((candidate) => candidate.id === 'lm-studio');
    expect(factory).toBeDefined();
    if (factory === undefined) {
      throw new Error('LM Studio factory not found');
    }

    const provider = await factory.create({ probeOnly: true });

    expect(provider.defaultModel).toBe('local-model');
    expect(staleRequests).toBe(0);
  } finally {
    if (previousUrl === undefined) {
      delete process.env.GCM_LM_STUDIO_URL;
    } else {
      process.env.GCM_LM_STUDIO_URL = previousUrl;
    }
    await staleServer.stop(true);
    await activeServer.stop(true);
  }
});
