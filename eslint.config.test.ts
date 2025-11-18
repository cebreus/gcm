import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['**/*.test.ts'],
  extends: [
    tseslint.configs.eslintRecommended,
    tseslint.configs.recommended,
    tseslint.configs.stylistic,
  ],
  languageOptions: {
    globals: {
      ...globals.bun, // Add Bun test globals
    },
  },
  rules: {
    // Test specific rules
    '@typescript-eslint/no-unused-vars': 'off', // Often test files have unused vars
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-empty-function': 'off',
  },
});
