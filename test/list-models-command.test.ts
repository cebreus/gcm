import { expect, mock, test } from 'bun:test';
import { runListModelsCommand } from '../src/list-models-command.js';

test('list models redacts secrets from provider readiness errors', async function () {
  const cancel = mock(function () {});
  const exitCode = await runListModelsCommand({
    providerLabel: 'Local',
    readinessError: 'Rejected sk-1234567890abcdef',
    models: async function () {
      return [];
    },
    output: { cancel, note: function () {}, outro: function () {} },
  });

  expect(exitCode).toBe(1);
  expect(cancel).toHaveBeenCalledWith('Error: Rejected [REDACTED-KEY]');
});

test('list models redacts secrets from provider discovery errors', async function () {
  const cancel = mock(function () {});
  const exitCode = await runListModelsCommand({
    providerLabel: 'Local',
    models: async function () {
      throw new Error('Rejected sk-1234567890abcdef');
    },
    output: { cancel, note: function () {}, outro: function () {} },
  });

  expect(exitCode).toBe(2);
  expect(cancel).toHaveBeenCalledWith('Failed to fetch models: Error: Rejected [REDACTED-KEY]');
});

test('list models rejects terminal-control model names', async function () {
  const cancel = mock(function () {});
  const exitCode = await runListModelsCommand({
    providerLabel: 'Local',
    models: async function () {
      return [
        {
          name: 'safe-model',
          label: 'Safe',
          limits: { kind: 'separate' as const, maxInputTokens: 8_192, maxOutputTokens: 1_024 },
        },
        {
          name: 'bad\u001b[2Jmodel',
          label: 'Bad',
          limits: { kind: 'separate' as const, maxInputTokens: 8_192, maxOutputTokens: 1_024 },
        },
      ];
    },
    output: { cancel, note: function () {}, outro: function () {} },
  });

  expect(exitCode).toBe(2);
  expect(cancel).toHaveBeenCalledWith(
    'Failed to fetch models: Error: Provider returned invalid model name',
  );
});

test('list models rejects an empty provider catalogue', async function () {
  const cancel = mock(function () {});
  const exitCode = await runListModelsCommand({
    providerLabel: 'Local',
    models: async function () {
      return [];
    },
    output: { cancel, note: function () {}, outro: function () {} },
  });

  expect(exitCode).toBe(2);
  expect(cancel).toHaveBeenCalledWith(
    'Failed to fetch models: Error: Provider returned no compatible models',
  );
});
