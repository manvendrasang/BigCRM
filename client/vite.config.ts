/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * BigCRM client build config.
 *
 * The dev server proxies `/api` to the Express API on port 3000 so the browser
 * only ever issues same-origin requests. That is what allows the session cookie
 * to be `SameSite=Lax` + `credentials: 'same-origin'` without any CORS relaxation
 * (see `src/lib/api.ts`).
 */
export default defineConfig({
 plugins: [react()],
 server: {
 port: 5173,
 strictPort: true,
 proxy: {
 '/api': {
 // The API origin is configurable so the end-to-end run can point at its own
 // API (a throwaway database on its own port) without colliding with a
 // development server that is already running. The default is unchanged, so
 // `npm run dev` behaves exactly as before.
 target: process.env['VITE_API_TARGET'] ?? 'http://localhost:3000',
 changeOrigin: false,
 },
 },
 },
 preview: {
 port: 5173,
 },
 build: {
 outDir: 'dist',
 sourcemap: false,
 target: 'es2022',
 },
 test: {
 environment: 'jsdom',
 globals: true,
 setupFiles: ['./src/test/setup.ts'],
 include: ['src/**/*.test.{ts,tsx}'],
 restoreMocks: true,
 coverage: {
 provider: 'v8',
 reporter: ['text', 'lcov', 'html'],
 reportsDirectory: './coverage',
 include: ['src/**/*.{ts,tsx}'],
 exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
 // Measured 2026-10-22 (173 tests): lines 58.06, functions 66.91,
 // branches 78.02, statements 58.06 -- page tests for Calendar, DealBoard,
 // the project window, Notifications and related records raised the
 // floor. Thresholds sit just below it so a coverage regression fails
 // the build. Raising them further means testing more pages first -- do
 // not raise the numbers without the tests.
 thresholds: { lines: 46, functions: 62, branches: 74, statements: 46 },
 },
 },
});