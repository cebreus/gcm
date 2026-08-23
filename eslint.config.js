import globals from 'globals';
import loveInfrastructure from 'eslint-config-love';

export default [
  {
    ignores: ['node_modules', 'dist'],
  },
  {
    files: ['**/*.js', '**/*.ts'],
    linterOptions: loveInfrastructure.linterOptions,
    languageOptions: {
      ...loveInfrastructure.languageOptions,
      globals: {
        ...loveInfrastructure.languageOptions?.globals,
        ...globals.bunBuiltin,
      },
    },
    plugins: loveInfrastructure.plugins,
    rules: {
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'start' }],
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
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.type='Literal'][arguments.0.value=/^(node:)?(fs|child_process)(\\/|$)/]",
          message: 'Use Bun.file, Bun.write, or Bun.spawn instead.',
        },
        {
          selector:
            "ImportExpression[source.type='Literal'][source.value=/^(node:)?(fs|child_process)(\\/|$)/]",
          message: 'Use Bun.file, Bun.write, or Bun.spawn instead.',
        },
      ],
    },
  },
];
