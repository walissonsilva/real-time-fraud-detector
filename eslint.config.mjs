import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'docs/**', 'load/k6/vendor/**', '.codex-remote-attachments/**'] },
  js.configs.recommended,
  { files: ['load/k6/*.js'], languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', console: 'readonly' } } },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  { files: ['**/*.js', '**/*.mjs'], languageOptions: { globals: globals.node } },
);
