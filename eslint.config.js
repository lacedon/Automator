import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**', '.next/**', 'coverage/**', 'test-results/**', 'playwright-report/**',
      'next-env.d.ts', '.agents/**', '.claude/**', '.superpowers/**', 'MCP/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nextVitals,
  { rules: { '@next/next/no-html-link-for-pages': 'off' } },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', require: 'readonly' } } },
);
