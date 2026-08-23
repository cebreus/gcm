import globals from 'globals';
import love from 'eslint-config-love';

export default [
  {
    ignores: ['node_modules', 'dist', 'test/**', '*.test.ts'],
  },
  {
    ...love,
    files: ['**/*.js', '**/*.ts'],
    languageOptions: {
      ...love.languageOptions,
      globals: {
        ...love.languageOptions?.globals,
        ...globals.browser,
        ...globals.node,
        Bun: true,
      },
    },
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      'no-negated-condition': 'error',
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'start' }],
      'max-nested-callbacks': ['error', { max: 2 }],
      'max-params': ['warn', { max: 4 }],
      'max-statements': ['warn', { max: 18 }],
    },
  },
  {
    files: ['src/**/*.{js,ts}', 'gcm.ts', 'gcm.config.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fs', 'fs/*', 'node:fs', 'node:fs/*', 'child_process', 'node:child_process'],
              message: 'Use Bun.file, Bun.write, or Bun.spawn instead.',
            },
          ],
        },
      ],
    },
  },
];
