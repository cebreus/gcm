import { expect, mock, test } from 'bun:test';
import { runListModelsCommand } from '../src/list-models-command.js';

test('list models redacts secrets from provider readiness errors', async function () {
  const cancel = mock(function () {});
  const exitCode = await runListModelsCommand({
    providerLabel: 'Local',
    readinessError: 'Rejected sk-1234567890abcdef',
    listModels: async function () {
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
    listModels: async function () {
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
    listModels: async function () {
      return ['safe-model', 'bad\u001b[2Jmodel'];
    },
    output: { cancel, note: function () {}, outro: function () {} },
  });

  expect(exitCode).toBe(2);
  expect(cancel).toHaveBeenCalledWith(
    'Failed to fetch models: Error: Provider returned invalid model name',
  );
});
