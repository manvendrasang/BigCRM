import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
 ApiError,
 api,
 clearTokens,
 getAccessToken,
 redact,
 request,
 resetApiClient,
 setAccessToken,
 setUnauthenticatedHandler,
} from './api';

/**
 * Security regression tests for the API client.
 *
 * These lock in properties that are easy to regress and expensive to discover in
 * production: a token that quietly starts living in `localStorage`, a lost CSRF
 * header, a refresh loop, or a raw error body leaking to the UI.
 */

interface RecordedCall {
 url: string;
 init: RequestInit | undefined;
}

/** Every fetch the client made, in order. Module-scoped so the stub can see it. */
let calls: RecordedCall[] = [];

/**
 * Installs a `fetch` stub that records each call before delegating to `impl`.
 * The client resolves `globalThis.fetch` lazily, so `vi.stubGlobal` is enough.
 */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
 vi.stubGlobal(
 'fetch',
 vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
 const url = typeof input === 'string' ? input : String(input);
 calls.push({ url, init });
 return impl(url, init);
 }),
 );
}

/** A response whose body deliberately contains credential material. */
function jsonResponse(body: unknown, status = 200): Response {
 return new Response(JSON.stringify(body), {
 status,
 headers: { 'Content-Type': 'application/json' },
 });
}

function setCsrfCookie(value: string): void {
 // Must match the server's CSRF_COOKIE_NAME default (`bigcrm_csrf`). When these
 // drifted apart the header was silently never sent, so Origin/Referer was the
 // only CSRF control actually running -- and no test failed, because the test
 // used the same wrong name as the client.
 document.cookie = `bigcrm_csrf=${value}; path=/`;
}

const CSRF_VALUE = 'csrf-token-value-abc123';

describe('api client', () => {
 let redirectTo: string | null = null;

 /** Headers of the nth recorded call, as the browser would send them. */
 function headersOf(index: number): Headers {
 const call = calls[index];
 if (call === undefined) throw new Error(`no fetch call recorded at index ${index}`);
 return new Headers(call.init?.headers);
 }

 function urlsMatching(fragment: string): string[] {
 return calls.filter((c) => c.url.includes(fragment)).map((c) => c.url);
 }

 beforeEach(() => {
 calls = [];
 redirectTo = null;
 localStorage.clear();
 sessionStorage.clear();
 // jsdom keeps cookies between tests in a file; start from a known state.
 for (const part of document.cookie.split(';')) {
 const name = part.split('=')[0]?.trim();
 if (name) document.cookie = `${name}=; path=/; max-age=0`;
 }
 setCsrfCookie(CSRF_VALUE);
 setUnauthenticatedHandler((path) => {
 redirectTo = path;
 });
 });

 afterEach(() => {
 resetApiClient();
 vi.unstubAllGlobals();
 vi.useRealTimers();
 });

 // ── rule 1: tokens never touch persistent storage ───────────────────────────

 it('keeps the access token in memory only, never in web storage or a JS-readable cookie', async () => {
 const token = 'eyJhbGciOiJIUzI1NiJ9.access-part.signature-part';
 stubFetch(async () => jsonResponse({ data: { user: { id: 'u1', email: 'a@b.test' } } }));

 await api.post('/auth/login', { email: 'a@b.test', password: 'hunter2hunter2' });
 setAccessToken(token);

 // Held in memory so the request can carry it...
 expect(getAccessToken()).toBe(token);
 // ...and nowhere else: both web storages stay completely empty.
 expect(localStorage.length).toBe(0);
 expect(sessionStorage.length).toBe(0);
 // Not reflected in a cookie a script could read back.
 expect(document.cookie).not.toContain(token);
 expect(document.cookie).not.toMatch(/bigcrm_at=/);
 // The only cookie present is the double-submit CSRF token, which is not a credential.
 expect(document.cookie).toContain('bigcrm_csrf=');
 });

 it('sends the in-memory token as a bearer header without persisting it', async () => {
 const token = 'in-memory-only-token';
 setAccessToken(token);
 stubFetch(async () => jsonResponse({ data: {} }));

 await api.get('/auth/me');

 expect(headersOf(0).get('Authorization')).toBe(`Bearer ${token}`);
 expect(localStorage.length).toBe(0);
 expect(sessionStorage.length).toBe(0);
 });

 it('clears the in-memory token on demand without leaving a trace behind', () => {
 setAccessToken('some-token');
 expect(getAccessToken()).not.toBeNull();

 clearTokens();

 expect(getAccessToken()).toBeNull();
 expect(localStorage.length).toBe(0);
 expect(sessionStorage.length).toBe(0);
 });

 // ── rule 3: CSRF header ────────────────────────────────────────────────────

 it('attaches the CSRF header to state-changing requests but never to GET', async () => {
 stubFetch(async () => jsonResponse({ data: { ok: true } }));

 await api.get('/contacts');
 await api.post('/contacts', { name: 'Acme' });
 await api.patch('/contacts/c1', { name: 'Acme Inc' });
 await api.del('/contacts/c1');

 // GET carries no CSRF header -- it is not a state change.
 expect(headersOf(0).has('X-CSRF-Token')).toBe(false);
 expect(headersOf(1).get('X-CSRF-Token')).toBe(CSRF_VALUE);
 expect(headersOf(2).get('X-CSRF-Token')).toBe(CSRF_VALUE);
 expect(headersOf(3).get('X-CSRF-Token')).toBe(CSRF_VALUE);
 });

 it('omits the CSRF header when the cookie is absent rather than sending an empty one', async () => {
 document.cookie = 'bigcrm_csrf=; path=/; max-age=0';
 stubFetch(async () => jsonResponse({ data: {} }));

 await api.post('/contacts', { name: 'Acme' });

 expect(headersOf(0).has('X-CSRF-Token')).toBe(false);
 });

 // ── rule 2: credentials ───────────────────────────────────────────────────

 it('sends same-origin credentials and never the permissive include mode', async () => {
 stubFetch(async () => jsonResponse({ data: {} }));

 await api.get('/auth/me');

 expect(calls.length).toBeGreaterThan(0);
 for (const call of calls) {
 expect(call.init?.credentials).toBe('same-origin');
 expect(call.init?.credentials).not.toBe('include');
 }
 });

 // ── rule 4: exactly one refresh, exactly one retry ─────────────────────────

 it('refreshes once and retries the original request exactly once after a 401', async () => {
 setAccessToken('stale-access-token');
 stubFetch(async (url) => {
 if (url.includes('/auth/refresh')) return jsonResponse({ data: { ok: true } });
 // First attempt 401s, the retry succeeds.
 if (urlsMatching('/contacts').length === 1) {
 return jsonResponse({ code: 'UNAUTHENTICATED', message: 'nope' }, 401);
 }
 return jsonResponse({ data: { id: 'c1', name: 'Acme' } });
 });

 await expect(api.get<{ id: string }>('/contacts')).resolves.toEqual({ id: 'c1', name: 'Acme' });

 // Exactly one refresh, exactly one retry -- no storm, no loop.
 expect(urlsMatching('/auth/refresh')).toHaveLength(1);
 expect(urlsMatching('/contacts')).toHaveLength(2);
 expect(redirectTo).toBeNull();
 });

 it('does not retry a second time if the request still 401s after a successful refresh', async () => {
 stubFetch(async (url) => {
 if (url.includes('/auth/refresh')) return jsonResponse({ data: { ok: true } });
 return jsonResponse({ code: 'UNAUTHENTICATED', message: 'still no' }, 401);
 });

 await expect(api.get('/contacts')).rejects.toBeInstanceOf(ApiError);

 expect(urlsMatching('/auth/refresh')).toHaveLength(1);
 expect(urlsMatching('/contacts')).toHaveLength(2);
 });

 it('adopts the rotated access token from the refresh response body', async () => {
 // Regression: the refresh body was discarded, so the client kept sending a
 // stale `Authorization` header. `authenticate` prefers the bearer over the
 // cookie, so the retry 401'd and the user was logged out every access-token
 // TTL despite a valid refresh cookie sitting in the jar.
 setAccessToken('stale-access-token');
 const rotated = 'rotated-access-token';
 stubFetch(async (url) => {
 if (url.includes('/auth/refresh')) {
 return jsonResponse({ data: { user: { id: 'u1', email: 'a@b.test' }, accessToken: rotated } });
 }
 if (urlsMatching('/contacts').length === 1) {
 return jsonResponse({ code: 'UNAUTHENTICATED', message: 'expired' }, 401);
 }
 return jsonResponse({ data: { id: 'c1' } });
 });

 await api.get('/contacts');

 expect(getAccessToken()).toBe(rotated);
 });

 it('still refreshes when the response body is unreadable -- the cookie is authoritative', async () => {
 setAccessToken('stale-access-token');
 stubFetch(async (url) => {
 if (url.includes('/auth/refresh')) {
 // No JSON body at all.
 return new Response('', { status: 200 });
 }
 if (urlsMatching('/contacts').length === 1) {
 return jsonResponse({ code: 'UNAUTHENTICATED', message: 'expired' }, 401);
 }
 return jsonResponse({ data: { id: 'c1' } });
 });

 await expect(api.get('/contacts')).resolves.toEqual({ id: 'c1' });
 expect(urlsMatching('/auth/refresh')).toHaveLength(1);
 });

 it('escalates to the unauthenticated handler once, without retrying forever', async () => {
 // The bootstrap probe on a cold /login visit legitimately 401s and cannot be
 // refreshed. It must hand off exactly once and stop: a handler that reloads
 // the document would remount the provider and probe again, forever.
 stubFetch(async (url) => {
 if (url.includes('/auth/refresh')) {
 return jsonResponse({ code: 'INVALID_REFRESH_TOKEN', message: 'no session' }, 401);
 }
 return jsonResponse({ code: 'UNAUTHENTICATED', message: 'no session' }, 401);
 });

 await expect(api.get('/auth/me')).rejects.toBeInstanceOf(ApiError);

 expect(redirectTo).toBe('/login');
 expect(urlsMatching('/auth/me')).toHaveLength(1);
 expect(urlsMatching('/auth/refresh')).toHaveLength(1);
 });

 it('shares a single refresh across concurrent 401s', async () => {
 // Every endpoint 401s on its first attempt and succeeds on the retry, so
 // all three calls genuinely contend for the refresh.
 const attempts = new Map<string, number>();
 stubFetch(async (url) => {
 if (url.includes('/auth/refresh')) return jsonResponse({ data: { ok: true } });
 const attempt = (attempts.get(url) ?? 0) + 1;
 attempts.set(url, attempt);
 return attempt === 1
 ? jsonResponse({ code: 'UNAUTHENTICATED' }, 401)
 : jsonResponse({ data: { ok: true } });
 });

 await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);

 // Single-flight: rotating single-use refresh tokens would otherwise trip
 // the server's reuse detection and revoke the whole session family.
 expect(urlsMatching('/auth/refresh')).toHaveLength(1);
 });

 it('clears tokens and redirects to /login when the refresh fails', async () => {
 setAccessToken('access-token-that-must-die');
 stubFetch(async (url) => {
 if (url.includes('/auth/refresh')) return jsonResponse({ code: 'UNAUTHENTICATED' }, 401);
 return jsonResponse({ code: 'UNAUTHENTICATED', message: 'expired' }, 401);
 });

 await expect(api.get('/contacts')).rejects.toBeInstanceOf(ApiError);

 expect(getAccessToken()).toBeNull();
 expect(redirectTo).toBe('/login');
 // One original attempt, one refresh, and no retry after the failure.
 expect(urlsMatching('/auth/refresh')).toHaveLength(1);
 expect(urlsMatching('/contacts')).toHaveLength(1);
 });

 it('surfaces a timeout as a typed error when the request never settles', async () => {
 stubFetch(
 (_url, init) =>
 new Promise<Response>((_resolve, reject) => {
 init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
 }),
 );

 vi.useFakeTimers();
 // Attach the handler before advancing the clock, otherwise the rejection
 // lands with no listener and Vitest reports an unhandled rejection.
 const settled = api.get('/slow').then(
 () => null,
 (e: unknown) => e,
 );
 await vi.advanceTimersByTimeAsync(15_000);
 const error = (await settled) as ApiError;

 expect(error).toBeInstanceOf(ApiError);
 expect(error).toMatchObject({ code: 'TIMEOUT', status: 0 });
 });

 it('honours skipRefresh so a rejected login is not mistaken for an expired session', async () => {
 stubFetch(async () => jsonResponse({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' }, 401));

 await expect(
 request('/auth/login', { method: 'POST', body: {}, skipRefresh: true }),
 ).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });

 expect(calls).toHaveLength(1);
 expect(redirectTo).toBeNull();
 });

 // ── rule 5: errors never leak the response body or a token ────────────────

 it('never exposes the raw response body or any token through a thrown error', async () => {
 const leakedToken = 'super-secret-bearer-token-abcdefghijklmnop';
 setAccessToken(leakedToken);
 stubFetch(async () =>
 jsonResponse(
 {
 code: 'INTERNAL_ERROR',
 message: `boom for ${leakedToken}`,
 sql: 'SELECT * FROM users WHERE password_hash = $1',
 stack: 'Error: at /app/server/src/db/driver.ts:42:1',
 refreshToken: leakedToken,
 },
 500,
 ),
 );

 const error = (await api.get('/reports').catch((e: unknown) => e)) as ApiError;

 expect(error).toBeInstanceOf(ApiError);
 // 5xx detail is replaced wholesale -- never reflected back to the browser.
 expect(error.status).toBe(500);
 expect(error.code).toBe('SERVER_ERROR');
 expect(error.message).not.toContain(leakedToken);
 expect(error.message).not.toContain('password_hash');
 expect(error.message).not.toContain('driver.ts');

 // The error object itself holds nothing sensitive -- not as an enumerable
 // property, and not in its serialised form.
 expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(leakedToken);
 expect(Object.keys(error).sort()).toEqual(['code', 'name', 'status']);
 });

 it('scrubs a reflected token out of a 4xx message', async () => {
 const token = 'eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXBhcnQ.sig-part-here';
 setAccessToken(token);
 stubFetch(async () =>
 jsonResponse({ code: 'BAD_REQUEST', message: `invalid token ${token}` }, 400),
 );

 const error = (await api.get('/contacts').catch((e: unknown) => e)) as ApiError;

 expect(error.message).not.toContain(token);
 expect(error.message).toContain('[REDACTED]');
 });

 it('ignores a hostile or non-conforming error body', async () => {
 stubFetch(async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }));

 const error = (await api.get('/contacts').catch((e: unknown) => e)) as ApiError;

 expect(error).toBeInstanceOf(ApiError);
 expect(error.message).toBe('Something went wrong. Please try again.');
 expect(error.message).not.toContain('<html>');
 });

 it('reports a network failure without leaking the underlying error', async () => {
 stubFetch(async () => {
 throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
 });

 const error = (await api.get('/contacts').catch((e: unknown) => e)) as ApiError;

 expect(error).toBeInstanceOf(ApiError);
 expect(error.code).toBe('NETWORK_ERROR');
 expect(error.message).not.toContain('127.0.0.1');
 expect(error.message).not.toContain('ECONNREFUSED');
 });

 // ── redact() helper ───────────────────────────────────────────────────────

 it('redacts credential-bearing keys recursively', () => {
 const result = redact({
 email: 'person@example.com',
 password: 'hunter2hunter2',
 nested: { accessToken: 'abc', refreshToken: 'def', authorization: 'Bearer x' },
 list: [{ apiKey: 'k1' }],
 }) as Record<string, unknown>;

 const serialised = JSON.stringify(result);
 expect(serialised).not.toContain('hunter2hunter2');
 expect(serialised).not.toContain('"abc"');
 expect(serialised).not.toContain('Bearer x');

 const nested = result['nested'] as Record<string, unknown>;
 expect(nested['accessToken']).toBe('[REDACTED]');
 expect(nested['refreshToken']).toBe('[REDACTED]');
 expect(nested['authorization']).toBe('[REDACTED]');
 // Non-secret fields survive so redaction does not hide bugs.
 expect(result['email']).toBe('person@example.com');
 });

 it('redact() terminates on circular structures', () => {
 const circular: Record<string, unknown> = { name: 'root' };
 circular['self'] = circular;

 expect(() => redact(circular)).not.toThrow();
 expect(JSON.stringify(redact(circular))).toContain('[CIRCULAR]');
 });

 // ── envelope ──────────────────────────────────────────────────────────────

 it('unwraps the documented { data } envelope', async () => {
 stubFetch(async () => jsonResponse({ data: { totalCount: 3 }, requestId: 'r1' }));

 await expect(api.get<{ totalCount: number }>('/contacts')).resolves.toEqual({ totalCount: 3 });
 });
});