import { expect, test } from 'bun:test';
import { ESLint } from 'eslint';

test('production code rejects Node I/O imports', async () => {
  const eslint = new ESLint();
  const resolvedConfig = await eslint.calculateConfigForFile('src/runner.ts');
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
  expect(resolvedConfig?.languageOptions.globals).toHaveProperty('Bun');
  expect(resolvedConfig?.languageOptions.globals).not.toHaveProperty('window');
  expect(resolvedConfig?.languageOptions.globals).not.toHaveProperty('__dirname');
});
