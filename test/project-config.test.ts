import { describe, expect, test } from 'bun:test';
import { parseProjectConfig } from '../src/project-config.js';
import { buildSystemPrompt } from '../src/generation.js';

describe('parseProjectConfig', function () {
  test('accepts every supported key', function () {
    expect(
      parseProjectConfig(
        JSON.stringify({
          types: ['feat', 'fix'],
          scopes: ['cli'],
          exclude: ['generated/**'],
          instructions: 'Prefer user-visible outcomes.',
        }),
      ),
    ).toEqual({
      types: ['feat', 'fix'],
      scopes: ['cli'],
      exclude: ['generated/**'],
      instructions: 'Prefer user-visible outcomes.',
    });
  });

  test('accepts an empty object', function () {
    expect(parseProjectConfig('{}')).toEqual({});
  });

  test('rejects invalid JSON', function () {
    expect(() => parseProjectConfig('{')).toThrow('invalid JSON');
  });

  test('rejects non-object input', function () {
    expect(() => parseProjectConfig('[]')).toThrow('must be an object');
  });

  test('rejects unknown keys', function () {
    expect(() => parseProjectConfig('{"model":"secret"}')).toThrow('unknown key "model"');
  });

  test('rejects arrays outside 1–50 items', function () {
    expect(() => parseProjectConfig('{"types":[]}')).toThrow('types must contain 1 to 50 items');
  });

  test('rejects non-string array items', function () {
    expect(() => parseProjectConfig('{"exclude":[1]}')).toThrow('exclude items must be strings');
  });

  test('rejects empty and overlong array items', function () {
    expect(() => parseProjectConfig('{"exclude":[""]}')).toThrow(
      'exclude items must contain 1 to 100 characters',
    );
    expect(() => parseProjectConfig(JSON.stringify({ exclude: ['x'.repeat(101)] }))).toThrow(
      'exclude items must contain 1 to 100 characters',
    );
  });

  test('rejects control characters in array items', function () {
    expect(() => parseProjectConfig(JSON.stringify({ exclude: ['x\u001b[2J'] }))).toThrow(
      'exclude items must not contain control characters',
    );
  });

  test('rejects invalid type and scope identifiers', function () {
    expect(() => parseProjectConfig('{"types":["Feature"]}')).toThrow(
      'types items must match /^[a-z][a-z0-9-]*$/',
    );
    expect(() => parseProjectConfig('{"scopes":["bad_scope"]}')).toThrow(
      'scopes items must match /^[a-z][a-z0-9-]*$/',
    );
  });

  test('rejects non-string and overlong instructions', function () {
    expect(() => parseProjectConfig('{"instructions":1}')).toThrow('instructions must be a string');
    expect(() => parseProjectConfig(JSON.stringify({ instructions: 'x'.repeat(2001) }))).toThrow(
      'instructions must contain at most 2000 characters',
    );
  });

  test('rejects terminal control sequences in instructions', function () {
    expect(() => parseProjectConfig(JSON.stringify({ instructions: 'hide\u001b[2J' }))).toThrow(
      'instructions must not contain terminal control sequences',
    );
  });
});

test('system prompt uses project conventions and preserves defaults without a file', function () {
  expect(buildSystemPrompt()).toContain(
    'Allowed types: feat, fix, refactor, perf, style, docs, test, build, ci, chore',
  );
  expect(buildSystemPrompt()).toContain(
    'Mark it with ! after the type or scope and add a BREAKING CHANGE: <impact> footer only when user instructions say the change is breaking',
  );
  const prompt = buildSystemPrompt({
    types: ['feat', 'fix'],
    scopes: ['cli', 'config'],
    instructions: 'Prefer user-visible outcomes.',
  });
  expect(prompt).toContain('Allowed types: feat, fix');
  expect(prompt).toContain('Use only these scopes: cli, config or no scope.');
  expect(prompt).toContain('Project instructions:\nPrefer user-visible outcomes.');
});
