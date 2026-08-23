import { expect, test } from 'bun:test';
import { ESLint } from 'eslint';

test('production code rejects Node I/O imports', async () => {
  const eslint = new ESLint();
  const source =
    "import { readFile } from 'fs/promises';\nimport { exec } from 'node:child_process';\n";
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
});
