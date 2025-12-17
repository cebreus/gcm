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
    },
  },
];
