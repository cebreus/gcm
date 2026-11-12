import love from 'eslint-config-love';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules', 'dist'],
  },
  {
    ...love,
    files: ['**/*.js', '**/*.ts'],
    languageOptions: {
      ...love.languageOptions,
      globals: { ...love.languageOptions?.globals, ...globals.bunBuiltin },
    },
    rules: {
      ...love.rules,
      // love flags even -1, 0, 1 and 2; naming them adds noise, not meaning:
      // 2 is a pair, a half, a hex byte, argv offset or exponential base.
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ...love.rules['@typescript-eslint/no-magic-numbers'][1],
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
        },
      ],
      // love allows a brace-less single-line body; a block reads the same everywhere.
      curly: ['error', 'all'],
      'no-warning-comments': [
        'error',
        { terms: ['todo', 'fixme', 'xxx'], location: 'start' },
      ],
    },
  },
  {
    // Test profile; reasons in docs/TESTING.md.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'max-lines': 'off',
      'no-await-in-loop': 'off',
      'require-atomic-updates': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.object.name=/^(describe|it|test)$/][callee.property.name=/^(only|skip)$/]',
          message: 'Never commit .only or .skip.',
        },
      ],
    },
  },
  {
    ignores: ['commitlint.config.js', 'prettier.config.js'],
  },
  {
    files: ['src/**/*.{js,ts}', 'gcm.ts', 'gcm.config.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'fs',
                'fs/*',
                'node:fs',
                'node:fs/*',
                'child_process',
                'node:child_process',
              ],
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
      'src/project-config.ts',
      'src/utils.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'fs',
                'fs/*',
                'node:fs',
                'node:fs/*',
                'child_process',
                'node:child_process',
              ],
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
              message:
                'Pure core modules cannot import I/O or adapter modules.',
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
