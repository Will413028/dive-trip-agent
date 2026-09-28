import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', '.next/**', 'coverage/**', '.vitest/**', '.artifacts/**', 'backend/.venv/**'] },
  js.configs.recommended,
  { files: ['backend/tests/*.mjs'], languageOptions: { globals: {
    process: 'readonly', Response: 'readonly', Request: 'readonly', AbortController: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly',
  } } },
  ...tseslint.configs.recommended,
];
