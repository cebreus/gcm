import { test, expect, mock, afterAll } from 'bun:test';
import {
  fileImportanceWeight,
  pushHunkToTop,
  unescapeNewlinesInText,
  detectRepoType,
  formatCommitMessage,
  shouldExcludeFile,
  filterExcludedFiles,
  sanitizeForDisplay,
  stripTerminalControlSequences,
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

test('utils: pushHunkToTop - ignores zero capacity', () => {
  const array: Hunk[] = [];
  pushHunkToTop(array, createHunk('f1', 10), 0);
  expect(array).toEqual([]);
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
const existsMock = mock(async (_path?: string) => false);
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

test('utils: formatCommitMessage - should preserve long single-line messages without wrapping', () => {
  const msg =
    'feat: this is a very long commit message that exceeds the maximum allowed first line length';
  const result = formatCommitMessage(msg);
  expect(result).toBe(msg);
});

test('utils: formatCommitMessage - should ensure empty line between subject and body', () => {
  const msg = `feat: add feature\nThis is the body line`;
  const result = formatCommitMessage(msg);
  expect(result).toBe('feat: add feature\n\nThis is the body line');
});

test('utils: formatCommitMessage - should preserve bullet points without wrapping', () => {
  const msg = `feat: add feature\n\n- This is a long bullet point item that might exceed the eighty character limit and should be preserved`;
  const result = formatCommitMessage(msg);
  expect(result).toBe(msg);
});

test('utils: formatCommitMessage - should preserve backticks', () => {
  const msg = `feat: add \`formatCommitMessage\` function\n\nImplemented a new formatter that wraps long lines while preserving \`backtick-enclosed\` code spans`;
  const result = formatCommitMessage(msg);
  expect(result).toContain('`formatCommitMessage`');
  expect(result).toContain('`backtick-enclosed`');
});

test('utils: formatCommitMessage - should ensure double newline separating subject and body', () => {
  const msg = `feat: add feature\n\nBody paragraph one\nBody paragraph two`;
  const result = formatCommitMessage(msg);
  expect(result).toBe('feat: add feature\n\nBody paragraph one\nBody paragraph two');
});

test('utils: formatCommitMessage - should handle multiple short bullet points', () => {
  const msg = `feat: add feature\n\n- Item 1\n- Item 2\n- Item 3`;
  const result = formatCommitMessage(msg);
  expect(result).toContain('- Item 1');
  expect(result).toContain('- Item 2');
  expect(result).toContain('- Item 3');
});

test('utils: formatCommitMessage - should preserve long bullet continuation without wrapping', () => {
  const msg = `fix: resolve issues\n\n- This is an extremely long bullet point that definitely exceeds eighty characters and must be preserved without manual wrapping`;
  const result = formatCommitMessage(msg);
  expect(result).toBe(msg);
});

test('utils: formatCommitMessage - should handle empty string', () => {
  expect(formatCommitMessage('')).toBe('');
});

test('utils: formatCommitMessage - should handle null/undefined gracefully', () => {
  expect((formatCommitMessage as any)(null)).toBe(null);
  expect((formatCommitMessage as any)(undefined)).toBe(undefined);
});

// --- Tests for shouldExcludeFile ---
test('utils: shouldExcludeFile - should match exact patterns', () => {
  expect(shouldExcludeFile('manifest.json', ['manifest.json'])).toBe(true);
  expect(shouldExcludeFile('package.json', ['manifest.json'])).toBe(false);
});

test('utils: shouldExcludeFile - should match wildcard patterns', () => {
  expect(shouldExcludeFile('manifest.json', ['*manifest*'])).toBe(true);
  expect(shouldExcludeFile('src/manifest.json', ['*manifest*'])).toBe(true);
  expect(shouldExcludeFile('manifest-prod.json', ['*manifest*'])).toBe(true);
  expect(shouldExcludeFile('package.json', ['*manifest*'])).toBe(false);
});

test('utils: shouldExcludeFile - asterisk crosses directory separators', () => {
  expect(shouldExcludeFile('a/b/c.env', ['*.env'])).toBe(true);
});

test('utils: shouldExcludeFile - asterisk alone matches every path', () => {
  expect(shouldExcludeFile('a/b/c.env', ['*'])).toBe(true);
});

test('utils: shouldExcludeFile - question mark matches exactly one character', () => {
  expect(shouldExcludeFile('file1.env', ['file?.env'])).toBe(true);
  expect(shouldExcludeFile('file12.env', ['file?.env'])).toBe(false);
});

test('utils: shouldExcludeFile - patterns are case-sensitive', () => {
  expect(shouldExcludeFile('UPPER.ENV', ['*.env'])).toBe(false);
});

test('utils: shouldExcludeFile - patterns are anchored at both ends', () => {
  expect(shouldExcludeFile('config/.env', ['.env'])).toBe(false);
});

test('utils: shouldExcludeFile - a question mark filename character matches question mark', () => {
  expect(shouldExcludeFile('file?.env', ['file?.env'])).toBe(true);
});

test('utils: shouldExcludeFile - should match multiple patterns', () => {
  expect(shouldExcludeFile('manifest.json', ['*manifest*', '*lock*'])).toBe(true);
  expect(shouldExcludeFile('package-lock.json', ['*manifest*', '*lock*'])).toBe(true);
  expect(shouldExcludeFile('src/app.ts', ['*manifest*', '*lock*'])).toBe(false);
});

test('utils: shouldExcludeFile - should match extension patterns', () => {
  expect(shouldExcludeFile('file.lock', ['*.lock'])).toBe(true);
  expect(shouldExcludeFile('package-lock.json', ['*.lock'])).toBe(false);
});

test('utils: shouldExcludeFile - should handle empty patterns', () => {
  expect(shouldExcludeFile('manifest.json', [])).toBe(false);
  expect(shouldExcludeFile('manifest.json', [''])).toBe(false);
});

test('utils: shouldExcludeFile - should handle path-based patterns', () => {
  expect(shouldExcludeFile('dist/manifest.json', ['dist/*'])).toBe(true);
  expect(shouldExcludeFile('src/manifest.json', ['dist/*'])).toBe(false);
});

test('utils: shouldExcludeFile - should be case-sensitive', () => {
  expect(shouldExcludeFile('Manifest.json', ['*manifest*'])).toBe(false);
  expect(shouldExcludeFile('manifest.json', ['*manifest*'])).toBe(true);
});

// --- Tests for filterExcludedFiles ---
test('utils: filterExcludedFiles - should filter multiple files', () => {
  const files = ['src/app.ts', 'manifest.json', 'src/manifest.ts', 'package.json'];
  const result = filterExcludedFiles(files, ['*manifest*']);
  expect(result).toEqual(['src/app.ts', 'package.json']);
});

test('utils: filterExcludedFiles - should handle multiple patterns', () => {
  const files = ['src/app.ts', 'manifest.json', 'package-lock.json', 'package.json'];
  const result = filterExcludedFiles(files, ['*manifest*', '*lock*']);
  expect(result).toEqual(['src/app.ts', 'package.json']);
});

test('utils: filterExcludedFiles - should return all files when no patterns', () => {
  const files = ['src/app.ts', 'manifest.json', 'package.json'];
  const result = filterExcludedFiles(files, []);
  expect(result).toEqual(files);
});

test('utils: filterExcludedFiles - should return empty array when all excluded', () => {
  const files = ['manifest.json', 'manifest.ts'];
  const result = filterExcludedFiles(files, ['*manifest*']);
  expect(result).toEqual([]);
});

// --- Tests for sanitizeForDisplay ---
test('utils: sanitizeForDisplay - should remove <<START>> marker', () => {
  const input = '<<START>> content';
  const result = sanitizeForDisplay(input);
  expect(result).toBe('content');
});

test('utils: sanitizeForDisplay - should remove <<END>> marker', () => {
  const input = 'content <<END>>';
  const result = sanitizeForDisplay(input);
  expect(result).toBe('content');
});

test('utils: sanitizeForDisplay - should remove backticked .<<END>> marker', () => {
  const input = 'feat: add feature\n\nDescription text`.<<END>>`';
  const result = sanitizeForDisplay(input);
  expect(result).toBe('feat: add feature\n\nDescription text');
});

test('utils: sanitizeForDisplay - should remove .<<END>> marker without backticks', () => {
  const input = 'feat: add feature\n\nDescription text.<<END>>';
  const result = sanitizeForDisplay(input);
  expect(result).toBe('feat: add feature\n\nDescription text');
});

test('utils: sanitizeForDisplay - should remove <<END_TRUNCATED>> marker', () => {
  const input = 'content <<END_TRUNCATED>>';
  const result = sanitizeForDisplay(input);
  expect(result).toBe('content');
});

test('utils: sanitizeForDisplay - should remove all markers in single text', () => {
  const input = '<<START>> content with markers and more.<<END_TRUNCATED>>';
  const result = sanitizeForDisplay(input);
  expect(result).toBe('content with markers and more');
});

test('utils: sanitizeForDisplay - should preserve marker-like literals inside text', () => {
  const input = 'Docs: explain what <<END>> marker means for parser behavior';
  const result = sanitizeForDisplay(input);
  expect(result).toBe(input);
});

test('utils: sanitizeForDisplay - should preserve regular content', () => {
  const input = 'feat(api): add new endpoint\n\n- Add authentication\n- Update tests';
  const result = sanitizeForDisplay(input);
  expect(result).toBe(input);
});

test('utils: sanitizeForDisplay - should remove non-printable characters', () => {
  const input = 'content\x00with\x01special\x02chars';
  const result = sanitizeForDisplay(input);
  expect(result).toBe('contentwithspecialchars');
});

test('utils: sanitizeForDisplay - should preserve tabs, newlines, and carriage returns', () => {
  const input = 'line1\nline2\tindented\rcarriage';
  const result = sanitizeForDisplay(input);
  expect(result).toBe(input);
});

test('utils: sanitizeForDisplay - should handle empty string', () => {
  const result = sanitizeForDisplay('');
  expect(result).toBe('');
});

test('utils: sanitizeForDisplay - should handle variant with backtick prefix', () => {
  const input = 'commit message`<<END>>';
  const result = sanitizeForDisplay(input);
  expect(result).toBe('commit message');
});

test('utils: sanitizeForDisplay - should handle multiple occurrences', () => {
  const input = '<<START>>text1<<END>> middle <<START>>text2<<END>>';
  const result = sanitizeForDisplay(input);
  expect(result).toBe('text1 middle text2');
});

test('utils: stripTerminalControlSequences removes ANSI and controls but keeps newlines and tabs', () => {
  expect(stripTerminalControlSequences('first\tline\n\u001B]8;;https://example.test\u0007link\u001B]8;;\u0007\u009B2J\u0000')).toBe(
    'first\tline\nlink',
  );
});
