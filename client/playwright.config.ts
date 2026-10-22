/**
 * Playwright configuration for the end-to-end smoke test.
 *
 * Two servers, on ports nothing else uses
 * ---------------------------------------
 * The run must not disturb a development session and must not depend on one
 * either. It boots its own API -- a throwaway PGlite database, migrated at
 * boot by the server itself -- and its own Vite dev server, and points the
 * dev proxy at that API with `VITE_API_TARGET` (see `vite.config.ts`).
 *
 * Why the timezone is pinned to UTC
 * ---------------------------------
 * The calendar keys its day cells on the browser's local date, while the API
 * stores `due_date` as an instant. A machine in UTC-5 would show a task due on
 * the 1st on the 30th, and the test would fail (or worse, pass) for reasons
 * that have nothing to do with the code under test. Pinning the timezone makes
 * the day arithmetic deterministic wherever the test runs.
 *
 * Why this runs serially
 * ----------------------
 * The suites share one API and one database, and the smoke test creates a
 * workspace of its own. Serial execution keeps the run legible: one failure at
 * a time, in the order it happened.
 *
 * Where the API's configuration comes from
 * ---------------------------------------
 * Entirely from here. The API is booted with an explicit environment rather
 * than `--env-file=server/.env.test`, because that file is gitignored and
 * absent from a fresh checkout -- a CI run would have died on a missing file
 * before it reached a single assertion. The values below are the same fake
 * test secrets the CI workflow already carries in plaintext for the server
 * suite; none of them is a credential for anything.
 */
import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ORIGIN = 'http://localhost:5273';
const API_ORIGIN = 'http://localhost:3100';
/** This file's directory, so the report lands where the CI artifact step looks. */
const CONFIG_DIR = fileURLToPath(new URL('.', import.meta.url));
/** A scratch database. Wiped before each run so the run starts from nothing. */
const E2E_DB_DIR = join(tmpdir(), 'bigcrm-e2e-pglite');

/** The parent environment, minus undefined values (Playwright wants strings). */
const inherited: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
 if (value !== undefined) inherited[key] = value;
}

/** The API's environment, in full. See the note above: nothing is inherited. */
const apiEnv: Record<string, string> = {
 ...inherited,
 NODE_ENV: 'test',
 ENV_NAME: 'test',
 LOG_LEVEL: 'silent',
 PORT: '3100',
 APP_ORIGINS: APP_ORIGIN,
 PGLITE_DATA_DIR: E2E_DB_DIR,
 // The smoke test registers its own workspace owner.
 BLOCK_NEW_ACCOUNTS: 'false',
 JWT_ISSUER: 'bigcrm.e2e',
 JWT_AUDIENCE: 'bigcrm.e2e.api',
 JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789abcdef0123456789',
 JWT_REFRESH_SECRET: 'e2e-refresh-secret-0123456789abcdef0123456789',
 SECRETS_PEPPER: 'e2e-pepper-0123456789abcdef0123456789abcdef',
 STORAGE_SIGNING_SECRET: 'e2e-storage-secret-0123456789abcdef0123',
};

export default defineConfig({
 testDir: './e2e',
 timeout: 120_000,
 expect: { timeout: 15_000 },
 fullyParallel: false,
 workers: 1,
 retries: 0,
 // The HTML report is what a CI run leaves behind to be looked at; `list` is
 // what a human watching the terminal wants.
 reporter: [['list'], ['html', { open: 'never', outputFolder: join(CONFIG_DIR, 'playwright-report') }]],
 use: {
 baseURL: APP_ORIGIN,
 trace: 'retain-on-failure',
 screenshot: 'only-on-failure',
 timezoneId: 'UTC',
 locale: 'en-GB',
 },
 projects: [
 {
 name: 'chromium',
 use: { ...devices['Desktop Chrome'] },
 },
 ],
 webServer: [
 {
 // The API boots against a throwaway database, migrating it itself. The
 // environment is explicit (see `apiEnv`), so this command depends on nothing
 // but the repository.
 command: `rm -rf "${E2E_DB_DIR}" && node --experimental-strip-types --no-warnings server/src/index.ts`,
 cwd: '..',
 url: `${API_ORIGIN}/health`,
 reuseExistingServer: false,
 timeout: 180_000,
 env: apiEnv,
 },
 {
 command: 'npm run dev -w client -- --port 5273 --strictPort',
 cwd: '..',
 url: `${APP_ORIGIN}/login`,
 reuseExistingServer: false,
 timeout: 180_000,
 env: { ...inherited, VITE_API_TARGET: API_ORIGIN },
 },
 ],
});
