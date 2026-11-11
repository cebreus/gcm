import { expect, mock, test } from 'bun:test';
import { runProvidersListCommand } from '../src/providers-list-command.js';
import {
  createLanguageModelApiError,
  type LanguageModelProvider,
} from '../src/language-model-service.js';

const model = {
  name: 'model-a',
  label: 'Model A',
  limits: { kind: 'separate' as const, maxInputTokens: 8_192, maxOutputTokens: 1_024 },
};

function createProvider(overrides: Partial<LanguageModelProvider> = {}): LanguageModelProvider {
  return {
    id: 'ready',
    label: 'Ready',
    defaultModel: model.name,
    models: async function () {
      return [model];
    },
    service: {
      generate: async function () {
        return null;
      },
    },
    ...overrides,
  };
}

test('list providers reports a safe mixed result and returns 1', async function () {
  const note = mock(function (_message: string, _title?: string) {});
  const exitCode = await runProvidersListCommand({
    factories: [
      {
        id: 'ready',
        label: 'Ready',
        create: async function () {
          return createProvider();
        },
      },
      {
        id: 'offline',
        label: 'Offline',
        create: async function () {
          throw new TypeError('getaddrinfo ENOTFOUND private.host');
        },
      },
    ],
    output: {
      note,
      outro: function () {},
      style: {
        available: function (text) {
          return `<green>${text}</green>`;
        },
        unavailable: function (text) {
          return `<yellow>${text}</yellow>`;
        },
      },
    },
  });

  expect(exitCode).toBe(1);
  expect(note).toHaveBeenCalledWith(
    '<green>ready</green>: <green>available</green> — 1 model\n<yellow>offline</yellow>: <yellow>unavailable</yellow> — Cannot connect to the provider.',
    'AI providers',
  );
  expect(note.mock.calls[0]?.[0]).not.toContain('private.host');
});

test('list providers rejects unusable providers and returns 2', async function () {
  const note = mock(function (_message: string, _title?: string) {});
  const exitCode = await runProvidersListCommand({
    factories: [
      {
        id: 'empty',
        label: 'Empty',
        create: async function () {
          return createProvider({
            id: 'empty',
            label: 'Empty',
            models: async function () {
              throw createLanguageModelApiError('Gemini returned no compatible text models', {
                kind: 'no-models',
              });
            },
          });
        },
      },
    ],
    output: { note, outro: function () {} },
  });

  expect(exitCode).toBe(2);
  expect(note.mock.calls[0]?.[0]).toContain('No supported models found.');
});

test.each([
  ['request failed (401)', { status: 401 }, 'The API key was not accepted.'],
  ['request timed out', { kind: 'timeout' }, 'The provider took too long to reply.'],
  ['unknown failure', {}, 'Provider check failed.'],
])('list providers explains %s', async function (error, metadata, expected) {
  const note = mock(function (_message: string, _title?: string) {});
  await runProvidersListCommand({
    factories: [
      {
        id: 'failed',
        label: 'Failed',
        create: async function () {
          throw createLanguageModelApiError(error, metadata);
        },
      },
    ],
    output: { note, outro: function () {} },
  });

  expect(note.mock.calls[0]?.[0]).toContain(expected);
});
