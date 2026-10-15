/**
 * Read-only degraded mode tests.
 *
 * The guard rejects non-read methods with 503 while GET/HEAD/OPTIONS pass
 * through. Tested over a real socket like the http suite, because the guard
 * is middleware and must be exercised as one.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { registerUser, loginUser } from '../../services/auth.ts';
import { createApp } from '../../app.ts';
import { env } from '../../config/env.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 130)}`;
  if (c) { pass++; console.log(`  [PASS] ${l}`); } else { fails.push(l); console.log(`  [FAIL] ${l}${detail}`); }
};

const C = { ip: '10.0.0.9', userAgent: 'readonly-test/1.0', requestId: 'req-ro' };

await registerUser({
  name: 'RO User', email: 'ro@corp.io', password: 'ReadOnly-Test!42',
  organizationName: 'RO Ltd', client: C,
});

// Force read-only mode on.
const original = env.security.readOnlyMode;
(env as { security: { readOnlyMode: boolean } }).security.readOnlyMode = true;

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;

const login = await loginUser({ email: 'ro@corp.io', password: 'ReadOnly-Test!42', client: C });
if (login.kind !== 'ok') throw new Error('login failed');
const token = login.accessToken;

async function call(method: string, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  return { status: res.status, body: await res.text().catch(() => '') };
}

console.log('\n=== reads pass, writes are refused ===');
{
  const get = await call('GET', '/api/v1/org/');
  T('GET passes in read-only mode', get.status === 200, get.status);

  const post = await call('POST', '/api/v1/contacts');
  T('POST refused with 503', post.status === 503, post.status);
  T('and names read-only mode', post.body.includes('read-only'), post.body);

  const patch = await call('PATCH', '/api/v1/org/');
  T('PATCH refused with 503', patch.status === 503, patch.status);

  const del = await call('DELETE', '/api/v1/org/');
  T('DELETE refused with 503', del.status === 503, del.status);

  const head = await call('HEAD', '/health');
  T('HEAD passes (read)', head.status === 200, head.status);
}

console.log('\n=== writes still work when the mode is off ===');
{
  (env as { security: { readOnlyMode: boolean } }).security.readOnlyMode = false;
  const post = await call('POST', '/api/v1/contacts');
  // 400 (validation) not 503 — the request reached the handler.
  T('with the mode off, POST reaches the handler', post.status !== 503, post.status);
}

(env as { security: { readOnlyMode: boolean } }).security.readOnlyMode = original;
server.close();
await new Promise<void>((r) => server.once('close', r));

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
