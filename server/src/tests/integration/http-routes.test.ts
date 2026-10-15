/**
 * HTTP-level coverage for the second-wave routes.
 *
 * The service-level suites (activity, savedViews, calendar) call the services
 * directly and therefore prove nothing about how those routers are *mounted*.
 * That gap let BIG-35 through: `auditRouter` is mounted at `/`, so its
 * router-level `authenticate` ran on every request in the application,
 * including `/contacts` and `/deals`, doubling their latency. Every existing
 * test passed throughout, because none of them made an HTTP request to any of
 * these endpoints.
 *
 * Two properties are asserted here:
 *
 * 1. **Every new route is closed to anonymous callers.** `authenticate` has to
 * be attached per-route or per-router correctly; moving it (as BIG-35's fix
 * does) can silently leave a route public. A 401 is the assertion.
 * 2. **The routes answer 200 with a valid session**, so a route cannot be
 * "protected" simply by not existing -- a 404 would pass check 1 too.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { registerUser, loginUser } from '../../services/auth.ts';
import { createApp } from '../../app.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 const detail = x === undefined ? '' : ` -> ${(typeof x === 'object' ? JSON.stringify(x) : String(x)).slice(0, 160)}`;
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l}${detail}`); }
};

const C = { ip: '10.0.0.12', userAgent: 'http-routes-test/1.0', requestId: 'req-routes' };

await registerUser({
 name: 'Route Owner', email: 'routes-owner@corp.io', password: 'Xx-7742-Quorum-ra',
 organizationName: 'Routes Ltd', client: C,
});

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;

const login = await loginUser({ email: 'routes-owner@corp.io', password: 'Xx-7742-Quorum-ra', client: C });
if (login.kind !== 'ok') throw new Error('login failed');
const token = login.accessToken;

const call = async (path: string, auth?: string): Promise<number> => {
 const res = await fetch(`${base}${path}`, {
 headers: auth ? { authorization: `Bearer ${auth}` } : {},
 });
 await res.arrayBuffer();
 return res.status;
};

const UUID = '00000000-0000-0000-0000-0000000000aa';

// Reads added in the second wave. Every one must be closed to anonymous callers.
const PROTECTED: Array<[string, string]> = [
 ['GET', '/api/v1/org/audit-logs'],
 ['GET', '/api/v1/notifications'],
 ['GET', '/api/v1/activities/contact/' + UUID],
 ['GET', '/api/v1/views'],
 ['GET', '/api/v1/reports/overview'],
 ['GET', '/api/v1/custom-fields/contact'],
 ['GET', '/api/v1/attachments/contact/' + UUID],
 ['GET', '/api/v1/calendar'],
 ['GET', '/api/v1/calendar/invitees'],
 ['GET', '/api/v1/calendar/invites'],
 // The record listers, included because BIG-35's cost landed on them.
 ['GET', '/api/v1/contacts'],
 ['GET', '/api/v1/deals'],
];

console.log('\n=== anonymous callers are refused (401) ===');
{
 for (const [method, path] of PROTECTED) {
 const status = await call(path);
 T(`${method} ${path} -> 401 without a session`, status === 401, status);
 }
}

console.log('\n=== the same routes answer with a valid session ===');
{
 for (const [method, path] of PROTECTED) {
 const status = await call(path, token);
 T(`${method} ${path} -> 200 with a session`, status === 200, status);
 }
}

console.log('\n=== audit-logs returns the camelCase contract the page reads ===');
{
 const res = await fetch(`${base}/api/v1/org/audit-logs`, {
 headers: { authorization: `Bearer ${token}` },
 });
 const body = (await res.json()) as { data?: { items?: Record<string, unknown>[] } };
 const first = body.data?.items?.[0];
 // BIG-33: these arrived snake_case and the viewer rendered blanks.
 T('audit items expose entityType', first === undefined || 'entityType' in first, Object.keys(first ?? {}));
 T('audit items expose createdAt', first === undefined || 'createdAt' in first);
 T('audit items never expose the raw column names',
 first === undefined || (!('entity_type' in first) && !('created_at' in first)));
}

console.log('\n=== a forged token is rejected on the new routes ===');
{
 const status = await call('/api/v1/org/audit-logs', 'not-a-real-token');
 T('forged token on audit-logs -> 401', status === 401, status);
 const status2 = await call('/api/v1/views', 'not-a-real-token');
 T('forged token on views -> 401', status2 === 401, status2);
}

console.log('\n=== calendar meeting creation is closed to anonymous callers ===');
{
 const res = await fetch(`${base}/api/v1/calendar/meetings`, {
 method: 'POST',
 headers: { 'content-type': 'application/json' },
 body: JSON.stringify({ entityType: 'contact', entityId: UUID, occurredAt: '2026-11-15T10:00:00Z', subject: 'x' }),
 });
 await res.arrayBuffer();
 // Router-level `authenticate` runs before any body parsing: no session, no
 // further processing, and no oracle about which fields were valid.
 T('POST /api/v1/calendar/meetings -> 401 without a session', res.status === 401, res.status);

 const res2 = await fetch(`${base}/api/v1/calendar/meetings/${UUID}/invite`, {
 method: 'POST',
 headers: { 'content-type': 'application/json' },
 body: JSON.stringify({ userIds: [UUID] }),
 });
 await res2.arrayBuffer();
 T('POST /api/v1/calendar/meetings/:id/invite -> 401 without a session', res2.status === 401, res2.status);
}

server.close();
await new Promise<void>((r) => server.once('close', r));

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);