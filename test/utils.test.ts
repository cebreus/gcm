import { test, expect, mock, afterAll } from 'bun:test';
import {
  fileImportanceWeight,
  pushHunkToTop,
  unescapeNewlinesInText,
  detectRepoType,
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
const createHunk = (file: string, score: number): Hunk => ({ file, score, header: '', content: '', added: 0, removed: 0, bytes: 0 });

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
    exists: () => existsMock(path) 
}));
const originalBunFile = Bun.file;
Bun.file = fileMock as any;

afterAll(() => {
    Bun.file = originalBunFile;
});

test('utils: detectRepoType - should detect monorepo with lerna.json', async () => {
    existsMock.mockImplementation(async (path) => path === 'lerna.json');
    const result = await detectRepoType();
    expect(result).toBe('monorepo');
});

test('utils: detectRepoType - should detect monorepo with pnpm-workspace.yaml', async () => {
    existsMock.mockImplementation(async (path) => path === 'pnpm-workspace.yaml');
    const result = await detectRepoType();
    expect(result).toBe('monorepo');
});

test('utils: detectRepoType - should detect monorepo with packages/ and apps/ dirs', async () => {
    existsMock.mockImplementation(async (path) => path === 'packages' || path === 'apps');
    const result = await detectRepoType();
    expect(result).toBe('monorepo');
});

test('utils: detectRepoType - should return single for regular repo', async () => {
    existsMock.mockImplementation(async () => false);
    const result = await detectRepoType();
    expect(result).toBe('single');
});
