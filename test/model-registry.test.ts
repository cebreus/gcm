import { expect, test } from 'bun:test';
import { getEffectiveMaxOutputTokens } from '../src/model-registry.js';

test('configured output policy is capped by an authoritative limit', function () {
  expect(getEffectiveMaxOutputTokens(16_384, 8_192)).toBe(8_192);
});

test('invalid configured output policy uses the application default', function () {
  expect(getEffectiveMaxOutputTokens(0, 16_384)).toBe(8_192);
});
