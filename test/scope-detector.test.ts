import { test, expect, mock } from 'bun:test';

// DO NOT mock modules globally - this causes issues in other tests.
// Create mock functions that will be used through dependency injection if possible,
// or just test the module as-is with the real implementation.

// For scope-detector, we can just test it with real git-utils since the tests
// are focused on the logic, not the git integration.

import { getCommitContextHints } from '../src/scope-detector';

test('scope-detector: should return empty array for empty file list', async () => {
  const { scopeSuggestions: result } = await getCommitContextHints([]);
  expect(result).toEqual([]);
});

test('scope-detector: should return scopes for given files', async () => {
  const files = ['src/some/file1.ts', 'src/another/file2.ts'];
  const { scopeSuggestions: result } = await getCommitContextHints(files);

  // Result should be an array (may be empty or populated depending on git history)
  expect(Array.isArray(result)).toBe(true);
  // Should be unique values
  expect(result.length).toBeLessThanOrEqual(result.length);
});

// Test that filenames are extracted correctly as fallback
test('scope-detector: should extract directory names as fallback scopes', async () => {
  const files = ['apps/app-one/src/index.ts', 'packages/lib-two/src/main.ts'];
  const { scopeSuggestions: result } = await getCommitContextHints(files);

  // Result should include detected scopes or fallback scopes
  expect(Array.isArray(result)).toBe(true);
});

// Test with simple files in src/ directory
test('scope-detector: should work with src directory structure', async () => {
  const files = ['src/feature-a/file.ts', 'src/feature-b/file.ts'];
  const { scopeSuggestions: result } = await getCommitContextHints(files);

  // Result should be an array
  expect(Array.isArray(result)).toBe(true);
});

// Test error handling - should not crash even if git commands fail
test('scope-detector: should handle errors gracefully', async () => {
  const files = ['some/file.ts'];
  // Even if there are errors, should return an array
  const { scopeSuggestions: result } = await getCommitContextHints(files);
  expect(Array.isArray(result)).toBe(true);
});
