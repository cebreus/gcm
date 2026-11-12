import { expect, mock, test } from 'bun:test';

import { runModelsListCommand } from '../src/models-list-command.js';

test('list models redacts secrets from provider readiness errors', async () => {
  const cancel = mock(() => {});
  const exitCode = await runModelsListCommand({
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

test('list models redacts secrets from provider discovery errors', async () => {
  const cancel = mock(() => {});
  const exitCode = await runModelsListCommand({
    providerLabel: 'Local',
    models: async function () {
      throw new Error('Rejected sk-1234567890abcdef');
    },
    output: { cancel, note: function () {}, outro: function () {} },
  });

  expect(exitCode).toBe(2);
  expect(cancel).toHaveBeenCalledWith(
    'Failed to fetch models: Error: Rejected [REDACTED-KEY]',
  );
});
