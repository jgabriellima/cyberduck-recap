// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Engine-generated runtime and run records are not project source.
    ignores: [
      '.claude/',
      '.agent/',
      '.outputs/',
      '.sdlc/',
      'dist/',
      'coverage/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The library's only output is its errors (spec): it never logs.
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  prettier,
);
