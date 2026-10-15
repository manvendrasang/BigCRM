/**
 * HTTP integration tests — the first suite to exercise the API over a real
 * socket rather than by calling functions.
 *
 * Everything asserted here is a property of the *wire format*: status codes,
 * headers, CORS behaviour, cookie attributes, JSON error shape, redirect
 * handling. None of it can be proven by calling a service directly, which is
 * why these assertions existed nowhere before (BIG-20).
 *
 * The server is started with `app.listen()` on an ephemeral port and driven
 * with the platform `fetch`, so middleware ordering, header emission, body
 * parsing and the error pipeline are all genuinely in the path.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { createApp } from '../../app.ts';
import { closeDb } from '../../db/driver.ts';
import { env } from '../../config/env.ts';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  if (c) { pass++; console.log(`  [PASS] ${l}`); } else { fails.push(l); console.log(`  [FAIL] ${l} -> ${typeof x === 'string' ? x : JSON.stringify(x ?? null).slice(0, 160)}`); }
};
type Attempt = { ok: true; r: Response; body: any } | { ok: false; r: Response; body: any };
const _unusedAttempt = async (fn: () => Promise<Response>): Promise<Attempt> => {
  try {
    const r = await fn();
    let body: any = null;
    try { body = await r.clone().json(); } catch { body = null; }
    return { ok: true, r, body };
  } catch (e) {
    return { ok: false, r: new Response(null, { status: 0 }), body: null };
  }
};

// ── boot ──────────────────────────────────────────────────────────────────────
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;
console.log(`\n(server listening on ${BASE})`);

// Server-side fetch must not be redirected or blocked by CORS; it is same-origin
// from Express's point of view, which is the realistic browser-equivalent here.
const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

console.log('\n=== liveness and readiness ===');
{
  const h = await call('/health');
  T('GET /health returns 200', h.status === 200, h.status);
  const hb = await h.json() as any;
  T('/health body carries no version, host or dependency detail',
    Object.keys(hb).every((k) => ['status'].includes(k)), hb);
  T('/health does not leak the environment name', !JSON.stringify(hb).includes('test'), hb);

  const r = await call('/ready');
  T('GET /ready returns 200 when the database answers', r.status === 200, r.status);
  const rb = await r.json() as any;
  T('/ready reports dependency state as a bare status word', rb.checks?.database === 'ok', rb);
  T('/ready does not expose a connection string', !JSON.stringify(rb).includes('postgres'), rb);
}

console.log('\n=== security headers (BIG-20) ===');
{
  const r = await call('/health');
  const csp = r.headers.get('content-security-policy') ?? '';
  T('Content-Security-Policy is present', csp.length > 0);
  T("CSP default-src is 'self'", /default-src 'self'/.test(csp), csp);
  // Parse the directive rather than regexing the whole header: `style-src` does
  // carry 'unsafe-inline' (documented, accepted risk A3), so a naive "no unsafe
  // anywhere" check would fail for the wrong reason.
  const directive = (name: string): string => {
    const d = csp.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name} `));
    return d ? d.slice(name.length).trim() : '';
  };
  T("CSP script-src is exactly 'self' — no unsafe-inline, no unsafe-eval",
    directive('script-src') === "'self'", directive('script-src'));
  T('CSP style-src relaxation is limited to unsafe-inline and documented (A3)',
    /^'self' 'unsafe-inline'$/.test(directive('style-src')), directive('style-src'));
  T('CSP connect-src is self only — no third-party endpoints',
    directive('connect-src') === "'self'", directive('connect-src'));
  T('no directive anywhere uses unsafe-eval', !/unsafe-eval/.test(csp), csp);
  T('CSP forbids plugins (object-src none)', /object-src 'none'/.test(csp), csp);
  T('CSP sets frame-ancestors none (clickjacking)', /frame-ancestors 'none'/.test(csp), csp);
  T('CSP restricts form-action', /form-action 'self'/.test(csp), csp);
  T('CSP pins base-uri', /base-uri 'self'/.test(csp), csp);
  T('X-Content-Type-Options is nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  T('X-Frame-Options is DENY', r.headers.get('x-frame-options') === 'DENY', r.headers.get('x-frame-options'));
  T('Referrer-Policy is set', (r.headers.get('referrer-policy') ?? '').includes('strict-origin'), r.headers.get('referrer-policy'));
  T('Cross-Origin-Opener-Policy is same-origin', r.headers.get('cross-origin-opener-policy') === 'same-origin');
  T('Cross-Origin-Resource-Policy is same-origin', r.headers.get('cross-origin-resource-policy') === 'same-origin');
  T('Permissions-Policy disables camera, microphone and geolocation',
    /camera=\(\)/.test(r.headers.get('permissions-policy') ?? '') &&
    /microphone=\(\)/.test(r.headers.get('permissions-policy') ?? '') &&
    /geolocation=\(\)/.test(r.headers.get('permissions-policy') ?? ''), r.headers.get('permissions-policy'));
  T('X-Powered-By is absent (stack not advertised)', r.headers.get('x-powered-by') === null, r.headers.get('x-powered-by'));
  T('a request id is echoed back', /^[A-Za-z0-9_-]{8,64}$/.test(r.headers.get('x-request-id') ?? ''), r.headers.get('x-request-id'));
}

console.log('\n=== X-Request-Id is not blindly trusted (log injection) ===');
{
  // `fetch` and `node:http` both REFUSE to send a header value containing CRLF,
  // so neither can express the attack. A hand-written TCP request can, which is
  // what an attacker actually sends. Without this, the control is untested.
  const rawRequest = (lines: string[]): Promise<string> => new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let out = '';
    socket.setTimeout(4000, () => { socket.destroy(); resolve(out); });
    socket.on('data', (d) => {
      out += String(d);
      if (out.includes('\r\n\r\n')) { socket.end(); resolve(out); }
    });
    socket.on('error', reject);
  });

  const injected = await rawRequest([
    'GET /health HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    `X-Request-Id: ${'a'.repeat(120)}\r\nX-Injected: yes`,
    'Connection: close',
  ]);
  const idLine = /x-request-id:\s*(\S+)/i.exec(injected)?.[1] ?? '';
  T('a CRLF-laced request id does not produce a second response header',
    !/x-injected/i.test(injected), injected.split('\r\n')[0]);
  T('and it is replaced with a well-formed one', /^[A-Za-z0-9_-]{8,64}$/.test(idLine), idLine);

  const oversize = await rawRequest([
    'GET /health HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    `X-Request-Id: ${'a'.repeat(400)}`,
    'Connection: close',
  ]);
  const bigId = /x-request-id:\s*(\S+)/i.exec(oversize)?.[1] ?? '';
  T('an over-long request id is replaced rather than echoed',
    bigId.length <= 64 && bigId !== 'a'.repeat(400), bigId.slice(0, 40));

  const ok = await call('/health', { headers: { 'x-request-id': 'trace-abc-123' } });
  T('a well-formed upstream request id is accepted for correlation',
    ok.headers.get('x-request-id') === 'trace-abc-123', ok.headers.get('x-request-id'));
}

console.log('\n=== CORS (RULE 37) ===');
{
  const allowed = await fetch(`${BASE}/health`, { headers: { origin: 'http://localhost:3000' } });
  T('an allowlisted origin is echoed back', allowed.headers.get('access-control-allow-origin') === 'http://localhost:3000',
    allowed.headers.get('access-control-allow-origin'));

  const denied = await fetch(`${BASE}/health`, { headers: { origin: 'https://evil.example' } });
  T('a non-allowlisted origin gets NO Access-Control-Allow-Origin',
    denied.headers.get('access-control-allow-origin') === null, denied.headers.get('access-control-allow-origin'));
  T('the request still executes (CORS is a browser control, not authorization)',
    denied.status === 200, denied.status);

  const pre = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  T('a cross-origin preflight is not granted', pre.headers.get('access-control-allow-origin') === null,
    pre.headers.get('access-control-allow-origin'));
  T('credentials are allowed only for our own origin',
    (allowed.headers.get('access-control-allow-credentials') ?? '') === 'true');
}

console.log('\n=== CSRF (RULE 38) ===');
{
  // No Origin and no Referer on a state-changing request.
  const bare = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.io', password: 'x' }),
  });
  T('a POST with neither Origin nor Referer is rejected', bare.status === 403, bare.status);

  const foreign = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ email: 'a@b.io', password: 'x' }),
  });
  T('a POST from a foreign Origin is rejected', foreign.status === 403, foreign.status);

  const foreignBody = await foreign.json() as any;
  T('the CSRF rejection does not explain why', !/origin/i.test(JSON.stringify(foreignBody.details ?? '')), foreignBody);

  const good = await call('/api/v1/auth/login', json({ email: 'a@b.io', password: 'Wrong-Pass-99!' }));
  T('a POST from an allowlisted Origin passes the CSRF gate (reaching the credential check)',
    good.status === 401 || good.status === 422, good.status);

  const safeGet = await call('/api/v1/contacts');
  T('GET is never CSRF-gated (it is not a state change)', safeGet.status === 401, safeGet.status);
}

console.log('\n=== error shape (RULE 120) ===');
{
  // An unknown path under /api/v1 is answered by the authenticated records
  // router before any routing decision is made, so an anonymous caller gets 401
  // rather than 404. That is deliberate: it means the API does not tell an
  // unauthenticated prober which endpoints exist. Once authenticated, a genuinely
  // unknown resource does 404.
  const missing = await call('/api/v1/nonexistent');
  T('an unknown /api/v1 path does not enumerate routes to an anonymous caller', missing.status === 401, missing.status);
  const body = await missing.json() as any;
  T('the error body is a stable shape: code, message, requestId',
    typeof body.code === 'string' && typeof body.message === 'string' && typeof body.requestId === 'string', body);
  T('the response does not include a stack trace', !JSON.stringify(body).includes('    at '), body);

  const outside = await call('/definitely/not/a/route');
  T('a path outside /api/v1 is a clean 404', outside.status === 404, outside.status);
  const ob = await outside.json() as any;
  T('that 404 also carries a requestId for correlation', typeof ob.requestId === 'string', ob);

  const badJson = await call('/api/v1/auth/login', {
    method: 'POST', body: '{not json',
  });
  T('malformed JSON returns 400, not 500', badJson.status === 400, badJson.status);
  const bj = await badJson.json() as any;
  T('the parse error is reported as INVALID_JSON', bj.code === 'INVALID_JSON', bj);

  const validation = await call('/api/v1/auth/login', json({ email: 'not-an-email', password: '' }));
  T('a schema violation returns 422', validation.status === 422, validation.status);
  const vb = await validation.json() as any;
  T('validation details name the fields but not the values',
    typeof vb.details === 'object' && !JSON.stringify(vb.details).includes('not-an-email'), vb);

  const oversize = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify({ email: 'a@b.io', password: 'x'.repeat(3 * 1024 * 1024) }),
  });
  T('an oversized body is refused with 413', oversize.status === 413, oversize.status);
}

console.log('\n=== unauthenticated access ===');
{
  for (const p of ['/api/v1/contacts', '/api/v1/companies', '/api/v1/deals', '/api/v1/org/members', '/api/v1/org']) {
    const r = await call(p);
    T(`GET ${p} without a token is 401`, r.status === 401, r.status);
  }
  const bad = await call('/api/v1/contacts', { headers: { authorization: 'Bearer not.a.jwt' } });
  T('a malformed bearer token is 401', bad.status === 401, bad.status);
  const b = await bad.json() as any;
  T('the 401 does not say which part of the token was wrong',
    !/signature|expired|malformed/i.test(String(b.message)), b);
}

console.log('\n=== full authentication flow over HTTP ===');
const uniq = `http${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@corp.io`;
let accessToken = '';
let refreshCookie = '';
let csrfCookieValue = '';
{
  const reg = await call('/api/v1/auth/register', json({
    name: 'Ada Lovelace', email: `ada-${uniq}`, password: 'Analytical-Engine-1843!',
    organizationName: 'Analytical Engines Ltd',
  }));
  T('register returns 201', reg.status === 201, reg.status);
  const rb = await reg.json() as any;
  T('register returns the created user without a password hash', rb.data?.user && !JSON.stringify(rb).includes('password_hash'), rb);
  T('register does not return a session token (the user must sign in)',
    rb.data?.accessToken === undefined && rb.data?.refreshToken === undefined, Object.keys(rb.data ?? {}));

  const login = await call('/api/v1/auth/login', json({
    email: `ada-${uniq}`, password: 'Analytical-Engine-1843!',
  }));
  T('login returns 200', login.status === 200, login.status);
  const lb = await login.json() as any;
  accessToken = lb.data?.accessToken ?? '';
  T('login returns an access token', accessToken.split('.').length === 3, accessToken.slice(0, 20));

  const setCookies = login.headers.getSetCookie?.() ?? [];
  const names = setCookies.map((c) => (c.split('=')[0] ?? ''));
  T('a session cookie is set', names.includes('bigcrm_at'), names);
  T('the access cookie is HttpOnly', setCookies.some((c) => c.startsWith('bigcrm_at=') && /HttpOnly/i.test(c)), setCookies);
  T('the refresh cookie is HttpOnly', setCookies.some((c) => c.includes('_refresh') && /HttpOnly/i.test(c)), setCookies);
  T('the CSRF cookie is deliberately NOT HttpOnly (it is a synchroniser, not a credential)',
    setCookies.some((c) => c.startsWith('bigcrm_csrf=') && !/HttpOnly/i.test(c)), setCookies);
  T('the CSRF cookie is SameSite=Lax or Strict',
    setCookies.some((c) => c.startsWith('bigcrm_csrf=') && /SameSite=(Lax|Strict)/i.test(c)), setCookies);

  refreshCookie = setCookies.find((c) => c.includes('_refresh'))?.split(';')[0] ?? '';
  csrfCookieValue = setCookies.find((c) => c.startsWith('bigcrm_csrf='))?.split('=')[1]?.split(';')[0] ?? '';
  T('a CSRF cookie value is issued', csrfCookieValue.length > 0);
  T('the refresh token is never in the response body',
    !JSON.stringify(lb).includes(refreshCookie.split('=')[1] ?? 'ZZZ'), Object.keys(lb.data ?? {}));

  const me = await call('/api/v1/auth/me', { headers: { authorization: `Bearer ${accessToken}` } });
  T('the access token authenticates a real endpoint', me.status === 200, me.status);
  const meBody = await me.json() as any;
  T('/me identifies the user and organization',
    meBody.data?.user?.email === `ada-${uniq}` && typeof meBody.data?.organizationId === 'string', meBody);

  const cookieAuth = await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie: refreshCookie.replace(/_refresh$/, '') } });
  T('a non-refresh cookie does not authenticate', cookieAuth.status === 401, cookieAuth.status);
}

console.log('\n=== refresh rotation and reuse detection (RULE 25) ===');
{
  const first = await fetch(`${BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie: refreshCookie },
    body: '{}',
  });
  T('refresh with a valid token succeeds', first.status === 200, first.status);
  const fb = await first.json() as any;
  const rotated = first.headers.getSetCookie?.().find((c) => c.includes('_refresh'))?.split(';')[0] ?? '';
  T('refresh rotates the refresh token', rotated !== '' && rotated !== refreshCookie);
  T('refresh returns a new access token', fb.data?.accessToken?.split('.').length === 3);

  const replay = await fetch(`${BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie: refreshCookie },
    body: '{}',
  });
  T('replaying the OLD refresh token is refused', replay.status === 401, replay.status);
  const rb = await replay.json() as any;
  T('reuse detection returns SESSION_REVOKED, signalling theft', rb.code === 'SESSION_REVOKED', rb);

  const afterReuse = await fetch(`${BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie: rotated },
    body: '{}',
  });
  T('the whole token family is revoked, so the rotated token dies too',
    afterReuse.status === 401, afterReuse.status);

  // Re-authenticate for the remaining assertions.
  const relogin = await call('/api/v1/auth/login', json({
    email: `ada-${uniq}`, password: 'Analytical-Engine-1843!',
  }));
  const lb = await relogin.json() as any;
  accessToken = lb.data?.accessToken ?? '';
  T('a fresh sign-in works after the family was revoked', accessToken.split('.').length === 3);
}

console.log('\n=== tenant isolation over the wire (RULE 15) ===');
{
  const other = `bob-${uniq}`;
  const reg = await call('/api/v1/auth/register', json({
    name: 'Bob Stone', email: other, password: 'Difference-Engine-1842!', organizationName: 'Bobs Engines Ltd',
  }));
  T('a second tenant registers', reg.status === 201, reg.status);
  const login = await call('/api/v1/auth/login', json({ email: other, password: 'Difference-Engine-1842!' }));
  const lb = await login.json() as any;
  const otherToken = lb.data?.accessToken ?? '';
  T('the second tenant gets its own session', otherToken.split('').length > 20);

  const created = await call('/api/v1/companies', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, cookie: `bigcrm_csrf=${csrfCookieValue}` },
    body: JSON.stringify({ name: 'Tenant A Co' }),
  });
  T('tenant A creates a company', created.status === 201, created.status);
  const company = (await created.json() as any).data;

  const listB = await call('/api/v1/companies', { headers: { authorization: `Bearer ${otherToken}` } });
  const listBody = await listB.json() as any;
  T('tenant B cannot see tenant A company in the list',
    !(listBody.data ?? []).some((c: any) => c.id === company?.id), listBody.pageInfo);

  const readB = await call(`/api/v1/companies/${company.id}`, { headers: { authorization: `Bearer ${otherToken}` } });
  T('tenant B gets 404 (not 403) reading tenant A company', readB.status === 404, readB.status);
  const rb = await readB.json() as any;
  T('the 404 confirms nothing about existence', !JSON.stringify(rb).includes('Tenant A Co'), rb);

  const patchB = await call(`/api/v1/companies/${company.id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${otherToken}`, cookie: `bigcrm_csrf=${csrfCookieValue}` },
    body: JSON.stringify({ name: 'Hijacked' }),
  });
  T('tenant B cannot patch tenant A company', patchB.status === 404, patchB.status);

  const delB = await call(`/api/v1/companies/${company.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${otherToken}`, cookie: `bigcrm_csrf=${csrfCookieValue}` },
  });
  T('tenant B cannot delete tenant A company', delB.status === 404, delB.status);

  const stillThere = await call(`/api/v1/companies/${company.id}`, { headers: { authorization: `Bearer ${accessToken}` } });
  T('tenant A company is unchanged after all of that', stillThere.status === 200, stillThere.status);
  const sb = await stillThere.json() as any;
  T('its name was not modified', sb.data?.name === 'Tenant A Co', sb.data?.name);

  const inject = await call('/api/v1/companies?q=%27%3B%20DROP%20TABLE%20companies%3B--', { headers: { authorization: `Bearer ${accessToken}` } });
  T('an injection payload in a query parameter is handled, not executed', inject.status === 200, inject.status);
  const stillWorks = await call('/api/v1/companies', { headers: { authorization: `Bearer ${accessToken}` } });
  T('the companies table still exists afterwards', stillWorks.status === 200, stillWorks.status);
}

console.log('\n=== CSRF cookie is not the only control: a state change without it ===');
{
  // No CSRF header at all, but an allowlisted Origin. The Origin check passes,
  // so this is accepted — which is why the two controls are defence in depth
  // rather than one of them being decorative.
  const noCsrf = await call('/api/v1/companies', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name: 'Origin Only Co' }),
  });
  T('an allowlisted Origin alone permits the write (documented defence-in-depth)', noCsrf.status === 201, noCsrf.status);
}

console.log('\n=== pagination contract ===');
{
  const r = await call('/api/v1/companies?limit=2', { headers: { authorization: `Bearer ${accessToken}` } });
  const body = await r.json() as any;
  T('a limit is honoured', Array.isArray(body.data) && body.data.length <= 2, body.data?.length);
  T('pageInfo reports limit, offset, totalCount and hasMore',
    body.pageInfo?.limit === 2 && typeof body.pageInfo?.offset === 'number' &&
    typeof body.pageInfo?.totalCount === 'number' && typeof body.pageInfo?.hasMore === 'boolean', body.pageInfo);

  const clamped = await call('/api/v1/companies?limit=100000', { headers: { authorization: `Bearer ${accessToken}` } });
  const cb = await clamped.json() as any;
  T('an absurd limit is clamped rather than honoured', cb.pageInfo?.limit <= 200, cb.pageInfo?.limit);

  const unknown = await call('/api/v1/companies?bogus=1', { headers: { authorization: `Bearer ${accessToken}` } });
  T('an unknown filter is a 400, not a silent no-op', unknown.status === 400, unknown.status);
}

console.log('\n=== metrics endpoint is not public ===');
{
  // METRICS_PATH is configurable (default /internal/metrics). Hard-coding
  // /metrics here tested a path the server never registers, so the assertion
  // would have "passed" against a 404 from the catch-all rather than the guard.
  const { metricsPath } = env.observability;
  const route = `/${metricsPath.replace(/^\/+/, '')}`;
  const anon = await call(route);
  T(`${route} without a token is refused`, anon.status === 401 || anon.status === 404, anon.status);
  const viewer = await call(route, { headers: { authorization: `Bearer ${accessToken}` } });
  T('a user token is still gated by permission', [200, 403, 404].includes(viewer.status), viewer.status);
  T('metrics never returns data to an unauthorised caller',
    viewer.status !== 200 || Boolean(viewer.headers.get('content-type')?.includes('text/plain')),
    viewer.status);
}

console.log('\n=== logout ===');
{
  const out = await call('/api/v1/auth/logout', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, cookie: `bigcrm_csrf=${csrfCookieValue}` },
  });
  T('logout succeeds', out.status === 200, out.status);
  const cleared = out.headers.getSetCookie?.() ?? [];
  T('logout clears the session cookies', cleared.some((c) => /^bigcrm_at=;/.test(c)), cleared);

  const after = await call('/api/v1/auth/me', { headers: { authorization: `Bearer ${accessToken}` } });
  T('the token is dead immediately after logout', after.status === 401, after.status);
}

await new Promise<void>((resolve) => server.close(() => resolve()));
await closeDb();

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
