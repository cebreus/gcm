import { test, expect, mock, afterAll } from 'bun:test';
import {
  fileImportanceWeight,
  pushHunkToTop,
  unescapeNewlinesInText,
  detectRepoType,
  formatCommitMessage,
} from '../src/utils';
import type { Hunk } from '../src/utils';

// --- Tests for fileImportanceWeight ---
test('utils: fileImportanceWeight - JS/TS files should have high weight', () => {
  expect(fileImportanceWeight('file.js')).toBe(10);
  expect(fileImportanceWeight('file.ts')).toBe(10);
  expect(fileImportanceWeight('file.jsx')).toBe(10);
  expect(fileImportanceWeight('file.tsx')).toBe(10);
  expect(fileImportanceWeight('file.svelte')).toBe(10);
});

test('utils: fileImportanceWeight - HTML/template files should have medium weight', () => {
  expect(fileImportanceWeight('file.html')).toBe(6);
  expect(fileImportanceWeight('file.hbs')).toBe(6);
  expect(fileImportanceWeight('file.njk')).toBe(6);
});

test('utils: fileImportanceWeight - CSS/style files should have lower weight', () => {
  expect(fileImportanceWeight('file.css')).toBe(4);
  expect(fileImportanceWeight('file.scss')).toBe(4);
  expect(fileImportanceWeight('file.sass')).toBe(4);
});

test('utils: fileImportanceWeight - Image files should have zero weight', () => {
  expect(fileImportanceWeight('file.png')).toBe(0);
  expect(fileImportanceWeight('file.jpg')).toBe(0);
  expect(fileImportanceWeight('file.gif')).toBe(0);
});

test('utils: fileImportanceWeight - Other files should have default weight', () => {
  expect(fileImportanceWeight('file.txt')).toBe(1);
  expect(fileImportanceWeight('README.md')).toBe(1);
});

test('utils: fileImportanceWeight - should handle no file name', () => {
  expect(fileImportanceWeight('')).toBe(0);
});

// --- Tests for pushHunkToTop ---
const createHunk = (file: string, score: number): Hunk => ({
  file,
  score,
  header: '',
  content: '',
  added: 0,
  removed: 0,
  bytes: 0,
});

test('utils: pushHunkToTop - should add hunk if array is not full', () => {
  const array: Hunk[] = [];
  pushHunkToTop(array, createHunk('file1', 10), 3);
  expect(array.length).toBe(1);
  expect(array[0].file).toBe('file1');
});

test('utils: pushHunkToTop - should not add hunk if score is too low and array is full', () => {
  const array = [createHunk('f1', 10), createHunk('f2', 20)];
  pushHunkToTop(array, createHunk('f3', 5), 2);
  expect(array.length).toBe(2);
  expect(array.find(h => h.file === 'f3')).toBeUndefined();
});

test('utils: pushHunkToTop - should replace lowest score hunk if array is full', () => {
  const array = [createHunk('f1', 10), createHunk('f2', 20)];
  pushHunkToTop(array, createHunk('f3', 15), 2);
  expect(array.length).toBe(2);
  expect(array.find(h => h.file === 'f1')).toBeUndefined();
  expect(array.find(h => h.file === 'f3')).toBeDefined();
});

test('utils: pushHunkToTop - should handle empty array', () => {
  const array: Hunk[] = [];
  pushHunkToTop(array, createHunk('f1', 10), 1);
  expect(array.length).toBe(1);
});

// --- Tests for unescapeNewlinesInText ---
test('utils: unescapeNewlinesInText - should unescape newlines in text fields', () => {
  const obj = { a: 1, data: { text: 'hello\nworld' } };
  const result = unescapeNewlinesInText(obj) as any;
  expect(result.data.text).toBe('hello\nworld');
});

test('utils: unescapeNewlinesInText - should handle nested objects and arrays', () => {
  const obj = { a: [{ text: 'a\nb' }, { c: { text: 'c\nd' } }] };
  const result = unescapeNewlinesInText(obj) as any;
  expect(result.a[0].text).toBe('a\nb');
  expect(result.a[1].c.text).toBe('c\nd');
});

// --- Tests for detectRepoType ---
const existsMock = mock(async () => false);
const fileMock = mock((path: string) => ({
  exists: () => existsMock(path),
}));
const originalBunFile = Bun.file;
Bun.file = fileMock as any;

afterAll(() => {
  Bun.file = originalBunFile;
});

test('utils: detectRepoType - should detect monorepo with lerna.json', async () => {
  existsMock.mockImplementation(async path => path === 'lerna.json');
  const result = await detectRepoType();
  expect(result).toBe('monorepo');
});

test('utils: detectRepoType - should detect monorepo with pnpm-workspace.yaml', async () => {
  existsMock.mockImplementation(async path => path === 'pnpm-workspace.yaml');
  const result = await detectRepoType();
  expect(result).toBe('monorepo');
});

test('utils: detectRepoType - should detect monorepo with packages/ and apps/ dirs', async () => {
  existsMock.mockImplementation(async path => path === 'packages' || path === 'apps');
  const result = await detectRepoType();
  expect(result).toBe('monorepo');
});

test('utils: detectRepoType - should return single for regular repo', async () => {
  existsMock.mockImplementation(async () => false);
  const result = await detectRepoType();
  expect(result).toBe('single');
});
// --- Tests for formatCommitMessage ---
test('utils: formatCommitMessage - should preserve short messages', () => {
  const msg = 'feat: add new feature';
  expect(formatCommitMessage(msg)).toBe(msg);
});

test('utils: formatCommitMessage - should wrap first line to 60 chars', () => {
  const msg =
    'feat: this is a very long commit message that exceeds the maximum allowed first line length';
  const result = formatCommitMessage(msg);
  const firstLine = result.split('\n')[0];
  expect(firstLine.length).toBeLessThanOrEqual(60);
  expect(result).toContain('feat:');
});

test('utils: formatCommitMessage - should wrap body lines to 80 chars', () => {
  const msg = `feat: add feature\n\nThis is a very long body line that definitely exceeds the maximum allowed length of eighty characters for body lines`;
  const result = formatCommitMessage(msg);
  const lines = result.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      expect(lines[i].length).toBeLessThanOrEqual(80);
    }
  }
});

test('utils: formatCommitMessage - should preserve bullet points', () => {
  const msg = `feat: add feature\n\n- This is a long bullet point item that might exceed the eighty character limit and should be wrapped`;
  const result = formatCommitMessage(msg);
  expect(result).toContain('- ');
  const lines = result.split('\n');
  for (const line of lines) {
    if (line.startsWith('-') || line.includes('- ')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  }
});

test('utils: formatCommitMessage - should preserve backticks', () => {
  const msg = `feat: add \`formatCommitMessage\` function\n\nImplemented a new formatter that wraps long lines while preserving \`backtick-enclosed\` code spans`;
  const result = formatCommitMessage(msg);
  expect(result).toContain('`formatCommitMessage`');
  expect(result).toContain('`backtick-enclosed`');
});

test('utils: formatCommitMessage - should preserve empty lines', () => {
  const msg = `feat: add feature\n\nBody paragraph one\n\nBody paragraph two`;
  const result = formatCommitMessage(msg);
  const lines = result.split('\n');
  expect(lines.length).toBe(5); // subject, blank, para1, blank, para2
  expect(lines[1]).toBe('');
  expect(lines[3]).toBe('');
});

test('utils: formatCommitMessage - should handle multiple short bullet points', () => {
  const msg = `feat: add feature\n\n- Item 1\n- Item 2\n- Item 3`;
  const result = formatCommitMessage(msg);
  expect(result).toContain('- Item 1');
  expect(result).toContain('- Item 2');
  expect(result).toContain('- Item 3');
});

test('utils: formatCommitMessage - should wrap long bullet continuation', () => {
  const msg = `fix: resolve issues\n\n- This is an extremely long bullet point that definitely exceeds eighty characters and must be wrapped to multiple lines`;
  const result = formatCommitMessage(msg);
  const lines = result.split('\n');
  for (const line of lines) {
    if (line.trim().length > 0) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  }
});

test('utils: formatCommitMessage - should handle empty string', () => {
  expect(formatCommitMessage('')).toBe('');
});

test('utils: formatCommitMessage - should handle null/undefined gracefully', () => {
  expect(formatCommitMessage(null as any)).toBe(null);
  expect(formatCommitMessage(undefined as any)).toBe(undefined);
});