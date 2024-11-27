const eslint = require('@eslint/js');
const eslintPluginJest = require('eslint-plugin-jest');
const githubPlugin = require('eslint-plugin-github');
const globals = require('globals');
const tseslint = require('@typescript-eslint/eslint-plugin');
const tseslintParser = require('@typescript-eslint/parser');

module.exports = [
  eslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['dist/**', 'lib/**', 'node_modules/**', 'jest.config.js'],
    languageOptions: {
      globals: {
        ...globals.es2018,
        ...globals.node,
        ...eslintPluginJest.environments.globals.globals,
      },
      parser: tseslintParser,
      parserOptions: {
        ecmaVersion: 2018,
        project: './tsconfig.json',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      github: githubPlugin,
      jest: eslintPluginJest,
    },
    rules: {
      '@typescript-eslint/array-type': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/consistent-type-assertions': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {allowExpressions: true},
      ],
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {accessibility: 'no-public'},
      ],
      '@typescript-eslint/no-array-constructor': 'error',
      '@typescript-eslint/no-empty-interface': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-extraneous-class': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-inferrable-types': 'error',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-namespace': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-useless-constructor': 'error',
      '@typescript-eslint/no-var-requires': 'error',
      '@typescript-eslint/prefer-for-of': 'warn',
      '@typescript-eslint/prefer-function-type': 'warn',
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/unbound-method': 'error',
      camelcase: 'off',
      'eslint-comments/no-use': 'off',
      'func-call-spacing': ['error', 'never'],
      'i18n-text/no-en': 'off',
      'import/no-namespace': 'off',
      'no-unused-vars': 'off',
    },
  },
];