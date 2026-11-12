export default {
  '*.{cjs,js,mjs,ts}': ['eslint --fix', 'prettier --write'],
  '*.{json,md,yaml,yml}': 'prettier --write',
};
