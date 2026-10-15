/**
 * Configuration fail-closed tests.
 *
 * `config/env.ts` is the boundary where a misconfiguration must stop the process
 * rather than degrade the service. These tests boot the module in a child
 * process with a controlled environment, because the module reads `process.env`
 * at import time and caches the result -- testing it in-process would only ever
 * exercise whichever environment happened to be loaded first.
 *
 * Each case asserts on the *outcome* (refused to boot, with a message naming the
 * problem) rather than on internal structure.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l} -> ${String(x ?? '').slice(0, 170)}`); }
};

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A complete, valid production environment. Individual tests break one field. */
const VALID_PROD: Record<string, string> = {
 NODE_ENV: 'production',
 DATABASE_URL: 'postgres://bigcrm:secret@db.internal:5432/bigcrm',
 APP_ORIGINS: 'https://crm.example.com',
 JWT_ISSUER: 'bigcrm.prod',
 JWT_AUDIENCE: 'bigcrm.prod.api',
 JWT_ACCESS_SECRET: 'a'.repeat(64),
 JWT_REFRESH_SECRET: 'b'.repeat(64),
 SECRETS_PEPPER: 'c'.repeat(64),
 STORAGE_SIGNING_SECRET: 'd'.repeat(64),
 LOG_LEVEL: 'silent',
 PGLITE_DATA_DIR: '',
};

/** Boots the config module in a child process; resolves to the outcome. */
function boot(overrides: Record<string, string>, del: string[] = []): Promise<{ booted: boolean; message: string; ssl?: string }> {
 const env: Record<string, string> = { ...VALID_PROD, ...overrides };
 for (const k of del) delete env[k];

 const script = "import('./src/config/env.ts').then(m => console.log('__BOOTED__' + m.env.db.ssl))"
 + ".catch(e => console.log('__REFUSED__' + e.message))";

 return new Promise((resolve) => {
 const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', script], {
 cwd: SERVER,
 // Only the controlled variables plus what node needs; no inherited
 // DATABASE_URL or JWT_* from the developer's shell.
 env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
 stdio: ['ignore', 'pipe', 'pipe'],
 });
 let out = '';
 child.stdout.on('data', (d) => { out += String(d); });
 child.stderr.on('data', () => undefined);
 child.on('close', () => {
 // Capture the value after the marker. Matching the bare marker made
 // `ssl` always empty, so three assertions failed for a reason that had
 // nothing to do with the code under test.
 const ok = /__BOOTED__(.*)/.exec(out);
 const no = /__REFUSED__(.*)/.exec(out);
 resolve({
 booted: Boolean(ok),
 message: (no?.[1] ?? '').trim(),
 ssl: ok?.[1]?.trim(),
 });
 });
 });
}

console.log('\n=== a complete production environment boots ===');
{
 const r = await boot({});
 T('production boots with a full, valid configuration', r.booted, r.message);
 T('production defaults to verify-full TLS', r.ssl === 'verify-full', r.ssl);
}

console.log('\n=== TLS posture is fail-closed (RULE 52) ===');
{
 const disable = await boot({ DATABASE_SSL: 'disable' });
 T('DATABASE_SSL=disable is refused in production', !disable.booted && /DATABASE_SSL/.test(disable.message), disable.message);
 T('and the message says why, not just "invalid"', /not permitted in production/i.test(disable.message), disable.message);

 const bogus = await boot({ DATABASE_SSL: 'totally-bogus' });
 T('an unrecognised DATABASE_SSL value is refused', !bogus.booted && /disable, require, verify-full/.test(bogus.message), bogus.message);

 const req = await boot({ DATABASE_SSL: 'require' });
 T('require is permitted for a private link', req.booted && req.ssl === 'require', `${req.ssl} ${req.message}`);

 const full = await boot({ DATABASE_SSL: 'verify-full' });
 T('verify-full is permitted', full.booted && full.ssl === 'verify-full', `${full.ssl} ${full.message}`);
}

console.log('\n=== a CA file that cannot be read stops startup ===');
{
 const missing = await boot({ DATABASE_SSL_CA_FILE: '/nonexistent/rds-global-bundle.pem' });
 T('an unreadable DATABASE_SSL_CA_FILE is refused', !missing.booted, missing.message);
 T('the message names the file', /rds-global-bundle\.pem/.test(missing.message), missing.message);
}

console.log('\n=== an inline CA is accepted ===');
{
 const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
 const ok = await boot({ DATABASE_SSL_CA: pem });
 T('an inline PEM CA is accepted', ok.booted, ok.message);
}

console.log('\n=== other production invariants still hold ===');
{
 const noDb = await boot({}, ['DATABASE_URL']);
 T('missing DATABASE_URL is refused', !noDb.booted && /DATABASE_URL/.test(noDb.message), noDb.message);

 const pgliteProd = await boot({ PGLITE_DATA_DIR: 'memory' }, ['DATABASE_URL']);
 T('production cannot fall back to embedded Postgres', !pgliteProd.booted, pgliteProd.message);

 const noOrigins = await boot({}, ['APP_ORIGINS']);
 T('missing APP_ORIGINS is refused (an empty CORS allowlist never means allow-all)',
 !noOrigins.booted && /APP_ORIGINS/.test(noOrigins.message), noOrigins.message);

 const httpOrigin = await boot({ APP_ORIGINS: 'http://crm.example.com' });
 T('a plaintext APP_ORIGINS is refused in production', !httpOrigin.booted && /https/.test(httpOrigin.message), httpOrigin.message);

 const shortSecret = await boot({ JWT_ACCESS_SECRET: 'short' });
 T('a short JWT secret is refused', !shortSecret.booted && /JWT_ACCESS_SECRET/.test(shortSecret.message), shortSecret.message);

 const sameSecrets = await boot({ STORAGE_SIGNING_SECRET: 'c'.repeat(64) });
 T('STORAGE_SIGNING_SECRET must differ from SECRETS_PEPPER', !sameSecrets.booted, sameSecrets.message);

 const placeholder = await boot({ SECRETS_PEPPER: 'change-me-in-production-please-now' });
 T('an obvious placeholder pepper is refused', !placeholder.booted, placeholder.message);
}

console.log('\n=== development defaults are permissive but explicit ===');
{
 const dev: Record<string, string> = {
 ...VALID_PROD,
 NODE_ENV: 'development',
 APP_ORIGINS: 'http://localhost:3000',
 PGLITE_DATA_DIR: 'memory',
 LOG_LEVEL: 'silent',
 };
 delete (dev as Record<string, string | undefined>).DATABASE_URL;

 const env2: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...dev };
 const script = "import('./src/config/env.ts').then(m => console.log('__BOOTED__' + m.env.db.ssl)).catch(e => console.log('__REFUSED__' + e.message))";
 const out = await new Promise<string>((resolve) => {
 const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', script],
 { cwd: SERVER, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
 let s = '';
 c.stdout.on('data', (d) => { s += String(d); });
 c.on('close', () => resolve(s));
 });
 T('development boots without a DATABASE_URL using embedded Postgres',
 out.includes('__BOOTED__'), out.split('\n')[0]?.slice(0, 120));
 T('and development TLS defaults to disabled, not silently verified',
 out.includes('__BOOTED__disable'), out.split('\n')[0]?.slice(0, 120));
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
