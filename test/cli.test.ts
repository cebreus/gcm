import { test, expect } from 'bun:test';
import { parseArgs } from '../src/cli';

test('cli: should parse default arguments with empty argv', () => {
  const result = parseArgs([]);
  expect(result).toEqual({
    commit: null,
    dryRun: false,
    help: false,
    model: null,
    verbose: false,
    debug: false,
  });
});

test('cli: should handle -c/--commit flag with a SHA value', () => {
  const sha = 'a1b2c3d4';
  let result = parseArgs(['-c', sha]);
  expect(result.commit).toBe(sha);

  result = parseArgs([`--commit=${sha}`]);
  expect(result.commit).toBe(sha);
});

test('cli: should handle -h/--help flag', () => {
  let result = parseArgs(['-h']);
  expect(result.help).toBe(true);

  result = parseArgs(['--help']);
  expect(result.help).toBe(true);
});

test('cli: should handle -v/--verbose flag', () => {
  let result = parseArgs(['-v']);
  expect(result.verbose).toBe(true);

  result = parseArgs(['--verbose']);
  expect(result.verbose).toBe(true);
});

test('cli: should handle -d/--debug flag', () => {
  let result = parseArgs(['-d']);
  expect(result.debug).toBe(true);

  result = parseArgs(['--debug']);
  expect(result.debug).toBe(true);
});

test('cli: should handle --model flag with a model name', () => {
  const model = 'gemini-pro';
  const result = parseArgs(['--model', model]);
  expect(result.model).toBe(model);
});

test('cli: should handle combined flags', () => {
  const result = parseArgs(['-v', '-d', '--commit', 'HEAD']);
  expect(result.verbose).toBe(true);
  expect(result.debug).toBe(true);
  expect(result.commit).toBe('HEAD');
  expect(result.help).toBe(false);
});

test('cli: gives precedence to flags over string arguments', () => {
  // When a string argument for `--commit` looks like another flag (e.g., `-h`),
  // minimist gives precedence to parsing the flag.
  // `parseArgs(['-c', '-h'])` results in `commit: null` and `help: true`.
  const fakeSha = '-h';
  const result = parseArgs(['-c', fakeSha]);
  expect(result.commit).toBe(null);
  expect(result.help).toBe(true);
});

test('cli: should ignore unknown flags', () => {
  const result = parseArgs(['--unknown-flag', 'value', '-x']);
  expect(result).toEqual({
    commit: null,
    dryRun: false,
    help: false,
    model: null,
    verbose: false,
    debug: false,
  });
});

test('cli: should handle boolean flag variations for dry-run', () => {
  let result = parseArgs(['--dry-run']);
  expect(result.dryRun).toBe(true);

  //This is how minimist handles camelCase args
  result = parseArgs(['--dryRun']);
  expect(result.dryRun).toBe(true);
});
