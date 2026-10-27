// Lint: ESLint's recommended rules, with the right globals for each kind of file. Run with: npm run lint
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/', '.claude/'] },
  js.configs.recommended,
  // Build scripts and tests: Node, ES modules.
  { files: ['**/*.mjs'], languageOptions: { sourceType: 'module', globals: globals.node } },
  // Code that runs in the visitor's browser: classic scripts.
  { files: ['site/**/*.js'], languageOptions: { sourceType: 'script', globals: globals.browser } },
  { files: ['scripts/lib/sw.js'], languageOptions: { sourceType: 'script', globals: globals.serviceworker } },
];
