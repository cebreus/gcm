import { test, expect } from 'bun:test';
import { parseArgs } from '../src/cli';
import { shouldExcludeFile, filterExcludedFiles } from '../src/utils';

// Integration test for exclude patterns
test('exclude-files: should parse exclude patterns from CLI and filter files', () => {
  // Parse CLI arguments with exclude patterns
  const parsedArgs = parseArgs(['--exclude', '*manifest*,*lock*']);
  expect(parsedArgs.exclude).toEqual(['*manifest*', '*lock*']);

  // Filter files using parsed patterns
  const files = [
    'src/app.ts',
    'manifest.json',
    'package-lock.json',
    'src/manifest.ts',
    'package.json',
    'README.md',
  ];

  const filteredFiles = filterExcludedFiles(files, parsedArgs.exclude);
  expect(filteredFiles).toEqual(['src/app.ts', 'package.json', 'README.md']);
});

test('exclude-files: should support short flag -e', () => {
  const parsedArgs = parseArgs(['-e', '*test*']);
  expect(parsedArgs.exclude).toEqual(['*test*']);

  const files = ['src/app.ts', 'src/app.test.ts', 'src/test-utils.ts', 'src/utils.ts'];

  const filteredFiles = filterExcludedFiles(files, parsedArgs.exclude);
  expect(filteredFiles).toEqual(['src/app.ts', 'src/utils.ts']);
});

test('exclude-files: should handle multiple exclude flags with different patterns', () => {
  const parsedArgs = parseArgs([
    '--exclude',
    '*manifest*',
    '--exclude',
    '*lock*',
    '--exclude',
    'dist/*',
  ]);
  expect(parsedArgs.exclude).toEqual(['*manifest*', '*lock*', 'dist/*']);

  const files = [
    'src/app.ts',
    'manifest.json',
    'package-lock.json',
    'dist/index.js',
    'dist/app.js',
    'src/manifest.ts',
    'package.json',
  ];

  const filteredFiles = filterExcludedFiles(files, parsedArgs.exclude);
  expect(filteredFiles).toEqual(['src/app.ts', 'package.json']);
});

test('exclude-files: real-world scenario - excluding build and manifest files', () => {
  const parsedArgs = parseArgs(['--exclude', 'dist/*,build/*,*manifest*,*lock*']);

  const files = [
    'src/index.ts',
    'src/utils.ts',
    'dist/index.js',
    'dist/app.js',
    'build/output.txt',
    'manifest.json',
    'package-lock.json',
    'yarn.lock',
    'package.json',
    '.env.manifest',
    'src/.manifest',
  ];

  const filteredFiles = filterExcludedFiles(files, parsedArgs.exclude);
  expect(filteredFiles).toEqual(['src/index.ts', 'src/utils.ts', 'package.json']);
});
