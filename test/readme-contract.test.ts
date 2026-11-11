import { expect, test } from 'bun:test';
import { CLI_OPTION_DEFINITIONS } from '../src/cli';
import { SECRET_FILE_EXCLUDE_PATTERNS } from '../src/constants';
import { parseLanguageModelOutput } from '../src/parser';
import { parseProjectConfig } from '../src/project-config';

// README is the user-facing contract. These tests fail when it and the code disagree,
// so a later change cannot silently flip a documented decision in either direction.
const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();
const configSource = await Bun.file(new URL('../gcm.config.ts', import.meta.url)).text();

function sentence(start: string): string {
  const from = readme.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return readme.slice(from, readme.indexOf('\n', from));
}

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]);
}

function tableColumn(heading: string): string[] {
  const from = readme.indexOf(heading);
  expect(from).toBeGreaterThanOrEqual(0);
  const rows = readme.slice(from).split('\n').slice(2);
  const end = rows.findIndex(row => !row.startsWith('|'));
  return rows.slice(0, end).map(row => codeSpans(row.split('|')[1])[0]);
}

const S = 'feat: subject';

test('README trailer denylist matches what the parser drops', () => {
  const listed = sentence('The diff is untrusted, so the model').match(
    /denylisted trailer \(([^)]+)\)/,
  )?.[1];
  const names = codeSpans(listed ?? '');
  expect(names.length).toBeGreaterThan(5);
  for (const name of names) {
    expect(parseLanguageModelOutput(`${S}\n\nBody.\n\n${name}: x`)).toBe(`${S}\n\nBody.`);
    expect(parseLanguageModelOutput(`${S}\n\nBREAKING CHANGE: y\n${name}: x`)).toBe(
      `${S}\n\nBREAKING CHANGE: y`,
    );
  }
});

test('README closing-keyword examples are dropped everywhere after the subject', () => {
  for (const line of ['Closes #12', 'fixes owner/repo#3', 'Resolves https://h.com/o/r/issues/4']) {
    expect(parseLanguageModelOutput(`${S}\n\nBody.\n${line}`)).toBe(`${S}\n\nBody.`);
    expect(parseLanguageModelOutput(`${S}\n\nBREAKING CHANGE: y\n${line}`)).toBe(
      `${S}\n\nBREAKING CHANGE: y`,
    );
  }
});

test('README CI skip markers are removed from the reply', () => {
  const listed = sentence('The diff is untrusted, so the model').match(
    /CI skip markers \(([^)]+)\)/,
  )?.[1];
  const markers = codeSpans(listed ?? '');
  expect(markers.length).toBeGreaterThan(3);
  for (const marker of markers) {
    expect(parseLanguageModelOutput(`${S} ${marker}\n\nBody ${marker} here.`)).toBe(
      `${S}\n\nBody here.`,
    );
  }
});

test('README secret-file excludes match the built-in patterns', () => {
  const documented = codeSpans(sentence('Files that usually hold secrets are excluded')).filter(
    span => !span.startsWith('dist') && !span.startsWith('--') && !span.includes(' '),
  );
  const fromCode = [
    ...new Set(SECRET_FILE_EXCLUDE_PATTERNS.map(pattern => pattern.replace(/^\*\*\//, ''))),
  ];
  const expanded = documented
    .flatMap(span => span.split(' / '))
    .filter(span => !['.env.example', '.env.sample'].includes(span));
  expect(new Set(expanded)).toEqual(new Set(fromCode));
});

test('README environment table lists exactly the variables gcm.config.ts reads', () => {
  const documented = tableColumn('| Variable ');
  const read = [...new Set([...configSource.matchAll(/env\.([A-Z_]+)/g)].map(match => match[1]))];
  // The Gemini key is documented in Install, not in the table.
  expect(new Set(documented)).toEqual(
    new Set(read.filter(name => name !== 'GOOGLE_GEMINI_API_KEY')),
  );
});

test('README options table lists exactly the CLI options', () => {
  expect(new Set(tableColumn('| Option '))).toEqual(
    new Set(CLI_OPTION_DEFINITIONS.map(option => option.usage)),
  );
});

test('README project configuration keys are accepted, others rejected', () => {
  const keys = tableColumn('| Key ');
  expect(keys).toEqual(['types', 'scopes', 'exclude', 'instructions']);
  const values: Record<string, unknown> = {
    types: ['feat'],
    scopes: ['cli'],
    exclude: ['generated/**'],
    instructions: 'Prefer user-visible outcomes.',
  };
  for (const key of keys) {
    expect(() => parseProjectConfig(JSON.stringify({ [key]: values[key] }))).not.toThrow();
  }
  expect(() => parseProjectConfig(JSON.stringify({ provider: 'gemini' }))).toThrow();
});
