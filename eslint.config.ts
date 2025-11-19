import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config({
  extends: [
    tseslint.configs.eslintRecommended,
    tseslint.configs.recommended,
    tseslint.configs.stylistic,
  ],
  languageOptions: {
    globals: {
      ...globals.browser,
      ...globals.node,
      Bun: true,
    },
  }
});
