import { expect, test } from 'bun:test';
import { resolveTokenBudget } from '../src/model-registry.js';

test('separate limits cap the output and spend the prompt budget on input only', function () {
  expect(
    resolveTokenBudget(
      { kind: 'separate', maxInputTokens: 1_000_000, maxOutputTokens: 4_096 },
      8_192,
      100,
    ),
  ).toEqual({ maxOutputTokens: 4_096, maxAvailableTokens: 999_900 });
});

test('a shared context window reserves the output half and subtracts the system prompt', function () {
  expect(resolveTokenBudget({ kind: 'shared-context', contextWindowTokens: 32_768 }, 8_192, 200)) //
    .toEqual({ maxOutputTokens: 8_192, maxAvailableTokens: 24_376 });
});

test('a shared context window never reserves more than half for output', function () {
  expect(resolveTokenBudget({ kind: 'shared-context', contextWindowTokens: 4_000 }, 8_192, 0)) //
    .toEqual({ maxOutputTokens: 2_000, maxAvailableTokens: 2_000 });
});

test('a system prompt that exhausts the window leaves no input budget', function () {
  expect(
    resolveTokenBudget({ kind: 'separate', maxInputTokens: 100, maxOutputTokens: 50 }, 8_192, 100),
  ).toEqual({ maxOutputTokens: 50, maxAvailableTokens: 0 });
});
