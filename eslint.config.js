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
  {
    files: [
      'src/atomic-commit-planner.ts',
      'src/config-values.ts',
      'src/constants.ts',
      'src/diff-summary.ts',
      'src/model-registry.ts',
      'src/scope-detector.ts',
      'src/parser.ts',
      'src/runner-utils.ts',
      'src/utils.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fs', 'fs/*', 'node:fs', 'node:fs/*', 'child_process', 'node:child_process'],
              message: 'Use Bun.file, Bun.write, or Bun.spawn instead.',
            },
            {
              group: [
                './services/*',
                '../services/*',
                './git-utils',
                './git-utils.*',
                '../git-utils',
                '../git-utils.*',
                './session',
                './session.*',
                '../session',
                '../session.*',
                '../gcm.config',
                '../gcm.config.*',
                '../../gcm.config',
                '../../gcm.config.*',
                '@clack/prompts',
                'bun:*',
              ],
              message: 'Pure core modules cannot import I/O or adapter modules.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Bun', message: 'Pure core modules cannot use Bun I/O.' },
        { name: 'fetch', message: 'Pure core modules cannot use HTTP.' },
      ],
    },
  },
];
