import { expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';

test('production code rejects Node I/O imports', async () => {
  const eslint = new ESLint();
  const resolvedConfig = (await eslint.calculateConfigForFile('src/runner.ts')) as Linter.Config;
  const source = [
    "import { readFile } from 'fs/promises';",
    "import { exec } from 'node:child_process';",
    "require('node:fs');",
    "await import('child_process');",
    "import path from 'node:path';",
    "import os from 'node:os';",
  ].join('\n');
  const [result] = await eslint.lintText(source, { filePath: 'src/runner.ts' });
  const [entrypoint] = await eslint.lintText(source, { filePath: 'gcm.ts' });
  const [config] = await eslint.lintText(source, { filePath: 'gcm.config.ts' });

  expect(result?.messages.filter(({ ruleId }) => ruleId === 'no-restricted-imports')).toHaveLength(
    2,
  );
  expect(
    entrypoint?.messages.filter(({ ruleId }) => ruleId === 'no-restricted-imports'),
  ).toHaveLength(2);
  expect(config?.messages.filter(({ ruleId }) => ruleId === 'no-restricted-imports')).toHaveLength(
    2,
  );
  for (const checked of [result, entrypoint, config]) {
    expect(
      checked?.messages.filter(({ ruleId }) => ruleId === 'no-restricted-syntax'),
    ).toHaveLength(2);
  }
  const configuredGlobals = resolvedConfig?.languageOptions?.globals;
  if (!configuredGlobals) throw new Error('Expected configured globals');
  expect(configuredGlobals).toHaveProperty('Bun');
  expect(configuredGlobals).not.toHaveProperty('window');
  expect(configuredGlobals).not.toHaveProperty('__dirname');
});

test('selected type-aware rules lint production and tests', async () => {
  const eslint = new ESLint();
  const production = (await eslint.calculateConfigForFile('src/runner.ts')) as Linter.Config;
  const tests = (await eslint.calculateConfigForFile('test/runner.test.ts')) as Linter.Config;

  if (!production?.rules || !tests?.rules) throw new Error('Expected type-aware rules');
  expect(tests.rules['@typescript-eslint/no-explicit-any']).toEqual(
    production.rules['@typescript-eslint/no-explicit-any'],
  );
  const nullishRule = production.rules['@typescript-eslint/prefer-nullish-coalescing'];
  if (!Array.isArray(nullishRule)) throw new Error('Expected configured nullish rule');
  expect(nullishRule[0]).toBe(2);
});

test('pure core modules reject adapter imports and I/O globals', async () => {
  const eslint = new ESLint();
  const coreFiles = [
    'src/atomic-commit-planner.ts',
    'src/config-values.ts',
    'src/constants.ts',
    'src/diff-summary.ts',
    'src/model-registry.ts',
    'src/scope-detector.ts',
    'src/parser.ts',
    'src/runner-utils.ts',
    'src/utils.ts',
  ];
  const source = [
    "import './services/git-service.js';",
    "import './git-utils.js';",
    "import './git-utils';",
    "import './session.js';",
    "import './session.ts';",
    "import '../gcm.config.js';",
    "import '../gcm.config.ts';",
    "import '@clack/prompts';",
    "import 'bun:ffi';",
    'void Bun;',
    'void fetch;',
  ].join('\n');

  for (const filePath of coreFiles) {
    const [result] = await eslint.lintText(source, { filePath });
    expect(
      result?.messages.filter(function ({ ruleId }) {
        return ruleId === 'no-restricted-imports';
      }),
    ).toHaveLength(9);
    expect(
      result?.messages.filter(function ({ ruleId }) {
        return ruleId === 'no-restricted-globals';
      }),
    ).toHaveLength(2);
  }

  const [runner] = await eslint.lintText(source, { filePath: 'src/runner.ts' });
  expect(
    runner?.messages.filter(function ({ ruleId }) {
      return ruleId === 'no-restricted-imports' || ruleId === 'no-restricted-globals';
    }),
  ).toHaveLength(0);
});
