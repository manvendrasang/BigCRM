/**
 * ESLint flat configuration.
 *
 * Scope note: this is a *correctness* linter, not a style formatter. The rules
 * chosen are the ones that catch real defects in this codebase -- floating
 * promises, unhandled `any`, shadowed identifiers, accidental globals -- rather
 * than a broad stylistic set that would generate churn without finding bugs.
 *
 * `no-control-regex` is disabled per-line in three places (base32/CSV/sanitiser
 * character classes) because those rules exist precisely to match control
 * characters. The disable comments are real now rather than decorative.
 *
 * Anything that would require an `any` escape hatch is an error, not a warning:
 * the tenant-scoping code is only as safe as its types.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
 {
 ignores: [
 '**/node_modules/**',
 '**/dist/**',
 '**/coverage/**', // generated reports (c8/vitest), never source
 'server/src/db/migrations/**', // SQL, not JS
 // Disabled sources: commented out and excluded from tsconfig, so the
 // type-aware parser has no project for them.
 'server/src/integrations/mongodb.ts',
 'server/src/tests/unit/mongodb.test.ts',
 'client/dist/**',
 // Served verbatim from the Vite `public/` dir and deliberately outside
 // tsconfig (it must run before the bundle, in plain ES5-compatible script
 // form). The type-aware parser has no project for it.
 'client/public/**',
 '**/*.d.ts',
 // Tool output, not source. ZAP's HUD writes ~180 MB of vendored JavaScript
 // into its working directory; pointing that at docs/evidence/ put it under
 // the linter's feet and produced 107 parse errors that said nothing about
 // this codebase. The scan script now keeps that state in /tmp, and this
 // ignore is the belt to that pair of braces for anything else that writes
 // generated artefacts here.
 'docs/evidence/**',
 ],
 },

 js.configs.recommended,
 // `recommendedTypeChecked` only -- deliberately NOT `stylisticTypeChecked`.
 // The stylistic preset produced 280 findings, the overwhelming majority of
 // them `prefer-includes` and `dot-notation` rewrites that change no behaviour.
 // It would have generated a wall of churn that people learn to ignore, which is
 // the opposite of what a linter is for. These rules find bugs.
 ...tseslint.configs.recommendedTypeChecked,

 {
 languageOptions: {
 parserOptions: {
 projectService: true,
 tsconfigRootDir: import.meta.dirname,
 },
 },
 rules: {
 // `String(x)` after a narrowing check is the established idiom throughout
 // `lib/` and `services/` -- normaliseEmail, normalisePhone, slugify and
 // the sanitiser all take `unknown` and return a string. The rule flags all
 // 38 of those call sites and finds no defect in any of them, so it is off:
 // a rule that is wrong almost everywhere trains people to ignore it.
 '@typescript-eslint/no-base-to-string': 'off',

 //  correctness 
 '@typescript-eslint/no-floating-promises': 'error',
 '@typescript-eslint/no-misused-promises': 'error',
 '@typescript-eslint/await-thenable': 'error',
 '@typescript-eslint/no-unnecessary-type-assertion': 'error',
 '@typescript-eslint/restrict-template-expressions': ['error', {
 allowNumber: true, allowBoolean: true, allowNullish: true, allowRegExp: true,
 }],

 //  banned outright 
 // `any` erases exactly the type information the tenant guard depends on.
 '@typescript-eslint/no-explicit-any': 'error',
 '@typescript-eslint/no-unsafe-assignment': 'off', // boundary code parses JSON
 '@typescript-eslint/no-non-null-assertion': 'off', // used deliberately after existence checks
 'no-eval': 'error',
 'no-implied-eval': 'error',
 'no-new-func': 'error',

 //  noise reduction 
 '@typescript-eslint/no-unused-vars': ['error', {
 argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
 }],
 // `import('pg').PoolClient` as a TYPE annotation is deliberate: it lets
 // `driver.ts` name the pg types without a runtime import of pg in the
 // PGlite path. Turning it into a top-level `import type` would defeat that.
 '@typescript-eslint/consistent-type-imports': 'off',
 // A deliberately async function with no `await` -- the `EmailProvider`
 // interface requires a Promise, and several implementations throw
 // synchronously on purpose ("fail loudly rather than pretend to send").
 '@typescript-eslint/require-await': 'off',
 'no-console': ['warn', { allow: ['warn', 'error'] }],
 eqeqeq: ['error', 'always', { null: 'ignore' }],
 'prefer-const': 'error',
 'no-var': 'error',
 },
 },

 //  server: Node, no DOM 
 {
 files: ['server/**/*.ts'],
 languageOptions: {
 globals: { ...globals.node },
 },
 rules: {
 // Structured logging is the only sanctioned output path in the server.
 'no-console': 'error',

 // Express 5 changed its type exports: `Request`, `Response`, `NextFunction`
 // are no longer resolvable as runtime values from the 'express' package.
 // Middleware functions that use these types trigger false positives for
 // the unsafe-* rules even though the code is correct at runtime.
 // These rules are disabled for server files only; they remain active for
 // client code where Express types are not used.
 '@typescript-eslint/no-unsafe-argument': 'off',
 '@typescript-eslint/no-unsafe-member-access': 'off',
 '@typescript-eslint/no-unsafe-return': 'off',
 '@typescript-eslint/no-unsafe-call': 'off',
 },
 },

 //  client: browser 
 {
 files: ['client/**/*.{ts,tsx}'],
 plugins: { 'react-hooks': reactHooks },
 languageOptions: {
 globals: { ...globals.browser },
 parserOptions: { ecmaFeatures: { jsx: true } },
 },
 rules: {
 ...reactHooks.configs.recommended.rules,
 },
 },

 //  tests 
 //
 // Tests are held to the correctness rules but not the typing ones. A test that
 // asserts "this malformed input is rejected" has to hold the untyped value to
 // pass it in, and the `any` that costs is confined to a file that cannot ship.
 // The rules that remain on -- no-floating-promises, no-misused-promises -- are the
 // ones that catch a test that silently passes because its assertion never ran.
 {
 files: ['**/tests/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
 rules: {
 'no-console': 'off',
 '@typescript-eslint/no-non-null-assertion': 'off',
 '@typescript-eslint/no-explicit-any': 'off',
 '@typescript-eslint/no-unsafe-argument': 'off',
 '@typescript-eslint/no-unsafe-member-access': 'off',
 '@typescript-eslint/no-unsafe-assignment': 'off',
 '@typescript-eslint/no-unsafe-return': 'off',
 '@typescript-eslint/no-unsafe-call': 'off',
 '@typescript-eslint/no-redundant-type-constituents': 'off',
 },
 },

 //  end-to-end specs
 //
 // The Playwright specs live in `client/e2e/`, which is deliberately outside
 // `client/tsconfig.json` -- the browser bundle must not pull in the test
 // runner. That leaves them with no tsconfig project, so the type-aware parser
 // cannot resolve them and the type-aware rules cannot run. They are typechecked
 // separately (`npm run typecheck:e2e -w client`, `client/tsconfig.e2e.json`)
 // and linted here with the base config only, like the config files below.
 {
 files: ['client/e2e/**/*.ts'],
 ...tseslint.configs.disableTypeChecked,
 rules: {
 ...tseslint.configs.disableTypeChecked.rules,
 'no-console': 'off',
 },
 },

 // Standalone .mjs / config files belong to no tsconfig project, so the
 // type-aware parser cannot resolve them. Lint them with the base config only.
 {
 files: ['**/*.mjs', '**/*.config.ts', '**/*.config.js'],
 ...tseslint.configs.disableTypeChecked,
 },

 //  scripts and CLIs: stdout IS the interface 
 {
 files: ['scripts/**/*.mjs', '*.config.{ts,mjs,js}', 'server/src/db/cli.ts',
 'server/seed/**/*.ts', 'infra/scripts/**/*.mjs'],
 languageOptions: { globals: { ...globals.node } },
 rules: { 'no-console': 'off' },
 },
);
