import { test, expect } from 'bun:test';
import { parseGeminiOutput } from '../src/parser';
import type { Labels } from '../src/parser';
import { fileImportanceWeight, pushHunkToTop } from '../src/utils';

interface Hunk {
  file: string;
  header: string;
  content: string;
  added: number;
  removed: number;
  bytes: number;
  score: number;
}

async function metaParserUtilsSmokeTest(): Promise<void> {
  // Parser check: ensure parseGeminiOutput parses basic labeled fields
  const sample = `BRANCH: feat/add-thing\nCOMMIT_MESSAGE: feat(core): add thing\nPR_TITLE: feat(core): add thing\nPR_DESCRIPTION: Adds thing`;
  const parsed: Labels = parseGeminiOutput(sample);
  expect(parsed.BRANCH).toBe('feat/add-thing');
  expect(parsed.COMMIT_MESSAGE).toContain('feat(core): add thing');

  // utils checks: file importance heuristics and hunk priority
  expect(fileImportanceWeight('index.js')).toBe(10);
  expect(fileImportanceWeight('styles.css')).toBe(4);
  expect(fileImportanceWeight('image.png')).toBe(0);

  const arr: Partial<Hunk>[] = [];
  pushHunkToTop(arr as Hunk[], { score: 5 } as Hunk, 2);
  pushHunkToTop(arr as Hunk[], { score: 10 } as Hunk, 2);
  pushHunkToTop(arr as Hunk[], { score: 3 } as Hunk, 2);
  expect(arr).toHaveLength(2);
  expect(
    arr.reduce(function (a, b) {
      return a + (b.score || 0);
    }, 0),
  ).toBeGreaterThanOrEqual(13);
}
test('meta: parser & utils smoke tests', metaParserUtilsSmokeTest);
