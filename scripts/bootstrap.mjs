/**
 * Generates `server/.env` from `server/.env.example` with fresh random secrets.
 *
 *   node --experimental-strip-types scripts/bootstrap.mjs
 *
 * Every secret is generated locally with crypto.randomBytes and printed only as
 * "<generated>" — the values are never shown on screen, because a secret that
 * appears in a terminal ends up in a shell history or a screen share.
 *
 * Existing .env is never overwritten without `--force`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'server', '.env.example');
const TARGET = join(ROOT, 'server', '.env');
const FORCE = process.argv.includes('--force');

const secret = (bytes = 48) => randomBytes(bytes).toString('base64url');

if (existsSync(TARGET) && !FORCE) {
  console.error('server/.env already exists. Re-run with --force to overwrite it.');
  console.error('Overwriting destroys the current secrets and invalidates every session and');
  console.error('stored password (SECRETS_PEPPER is mixed into every hash).');
  process.exit(1);
}

const GENERATED = new Map([
  ['JWT_ACCESS_SECRET', secret()],
  ['JWT_REFRESH_SECRET', secret()],
  ['SECRETS_PEPPER', secret()],
  ['STORAGE_SIGNING_SECRET', secret()],
]);

let out = readFileSync(EXAMPLE, 'utf8');
for (const [key, value] of GENERATED) {
  // Replace `KEY=...` whether it is empty, a placeholder, or already filled.
  const re = new RegExp(`^${key}=.*$`, 'm');
  out = re.test(out) ? out.replace(re, `${key}=${value}`) : `${out}\n${key}=${value}\n`;
}

writeFileSync(TARGET, out, { mode: 0o600 });
console.log('Wrote server/.env (mode 0600).\n');
console.log('Generated, not printed:');
for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'SECRETS_PEPPER', 'STORAGE_SIGNING_SECRET']) {
  console.log(`  ${key.padEnd(26)} <generated, ${48} random bytes>`);
}
console.log('\nStill yours to fill in:');
console.log('  DATABASE_URL                            (or leave PGLITE_DATA_DIR for embedded Postgres)');
console.log('  DATABASE_SSL / DATABASE_SSL_CA_FILE     TLS posture to the database');
console.log('  EMAIL_FROM                              sender address');
console.log('  APP_ORIGINS                             comma-separated allowed origins');
console.log('\nThen:');
console.log('  npm run migrate');
console.log('  npm test');