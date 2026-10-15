/**
 * In-house member creation (Settings > Members).
 *
 * There is no public signup on this deployment: accounts are minted by an
 * owner or admin, who is shown a generated password once and delivers it by
 * hand. These assertions cover the properties that make that safe:
 *
 * 1. The password is returned exactly once and never appears as a hash in any
 *    listing.
 * 2. It actually works: the new member can sign in, lands in the creator's
 *    organization, and holds the role they were given.
 * 3. Authority, not rank alone, is the gate: `users.create` is checked on the
 *    route, and a sales user can neither list nor create.
 * 4. Ownership is never minted through this path.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { registerUser, loginUser } from '../../services/auth.ts';
import { createMember, listMembers, requestPasswordReset, resetMemberPassword } from '../../services/org.ts';
import type { ActorRef } from '../../services/org.ts';
import { createApp } from '../../app.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 const detail = x === undefined ? '' : ` -> ${(typeof x === 'object' ? JSON.stringify(x) : String(x)).slice(0, 160)}`;
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l}${detail}`); }
};

const C = { ip: '10.0.0.21', userAgent: 'members-test/1.0', requestId: 'req-members' };

const ownerReg = await registerUser({
 name: 'Members Owner', email: 'members-owner@corp.io', password: 'Xx-7742-Quorum-ra',
 organizationName: 'Members Ltd', client: C,
});
const owner: ActorRef = {
 userId: ownerReg.user.id, organizationId: ownerReg.organizationId,
 role: 'owner', email: ownerReg.user.email,
};

// A second registered user, moved into the owner's organization as `admin`.
// registerUser can only create owners, so the membership row is edited here --
// the same approach savedViews.test.ts uses.
const adminReg = await registerUser({
 name: 'Members Admin', email: 'members-admin@corp.io', password: 'Yy-9913-Trellis-bt',
 organizationName: 'Members Admin Ltd', client: C,
});
const { getDb } = await import('../../db/driver.ts');
const db = await getDb();
await db.query('DELETE FROM organization_members WHERE user_id = $1', [adminReg.user.id]);
await db.query(
 `INSERT INTO organization_members (id,organization_id,user_id,role,status,joined_at,created_at,updated_at)
  VALUES ($1,$2,$3,'admin','active',now(),now(),now())`,
 [adminReg.user.id, owner.organizationId, adminReg.user.id],
);
await db.query('UPDATE users SET default_org_id = $1 WHERE id = $2', [owner.organizationId, adminReg.user.id]);
const admin: ActorRef = {
 userId: adminReg.user.id, organizationId: owner.organizationId,
 role: 'admin', email: adminReg.user.email,
};

let newHirePassword = '';

console.log('\n=== service: create and list ===');
{
 const created = await createMember(owner, { email: 'New-Hire@Corp.io', role: 'sales', name: 'New Hire' });
 newHirePassword = created.generatedPassword;
 T('email is normalised', created.user.email === 'new-hire@corp.io', created.user.email);
 T('the requested role is honoured', created.membershipRole === 'sales', created.membershipRole);
 T('a generated password is returned', typeof created.generatedPassword === 'string' && created.generatedPassword.length >= 16, created.generatedPassword.length);

 const list = await listMembers(owner);
 const row = list.find((m) => m.email === 'new-hire@corp.io');
 T('the new member appears on the roster', row !== undefined);
 T('with the assigned role and active status', row?.role === 'sales' && row?.status === 'active', row && { role: row.role, status: row.status });
 T('the roster response carries no password material',
 !JSON.stringify(list).toLowerCase().includes('password_hash')
 && !JSON.stringify(list).toLowerCase().includes('generatedpassword')
 && !JSON.stringify(list).toLowerCase().includes('"password"'),
 JSON.stringify(list).slice(0, 90));
 T('the roster says who this actor may reset',
 list.every((m) => typeof m.canResetPassword === 'boolean'), list[0] && { role: list[0].role, canResetPassword: list[0].canResetPassword });
 T('the owner may reset everyone', list.every((m) => m.canResetPassword));
}

console.log('\n=== the generated password works end to end ===');
{
 const login = await loginUser({ email: 'new-hire@corp.io', password: newHirePassword, client: C });
 T('the member can sign in with the generated password', login.kind === 'ok', login.kind);
 if (login.kind === 'ok') {
  T('they land in the creator\'s organization', login.actor.organizationId === owner.organizationId);
  T('and hold the role they were given', login.actor.role === 'sales', login.actor.role);
 }

 let wrong = false;
 try { await loginUser({ email: 'new-hire@corp.io', password: 'not-the-password', client: C }); }
 catch { wrong = true; }
 T('a wrong password is still refused', wrong);
}

console.log('\n=== duplicates and role bounds ===');
{
 let dup = false;
 try { await createMember(owner, { email: 'new-hire@corp.io', role: 'sales' }); } catch { dup = true; }
 T('a duplicate email is refused', dup);

 let mintedOwner = false;
 try { await createMember(owner, { email: 'owner-two@corp.io', role: 'owner' }); } catch { mintedOwner = true; }
 T('an owner cannot mint another owner', mintedOwner);

 let mintedPeer = false;
 try { await createMember(admin, { email: 'admin-two@corp.io', role: 'admin' }); } catch { mintedPeer = true; }
 T('an admin cannot mint a peer admin', mintedPeer);

 const ok = await createMember(admin, { email: 'admin-made@corp.io', role: 'sales' });
 T('an admin can mint a lower-ranked member', ok.membershipRole === 'sales', ok.membershipRole);
}

console.log('\n=== password reset: a member requests, the office completes ===');
{
 const roster = await listMembers(owner);
 const newHire = roster.find((m) => m.email === 'new-hire@corp.io');
 if (!newHire) throw new Error('fixture missing: new-hire');
 const salesActorRef: ActorRef = {
  userId: newHire.user_id, organizationId: owner.organizationId, role: 'sales', email: newHire.email,
 };

 const req = await requestPasswordReset(salesActorRef);
 T('a member can open a reset request', typeof req.requestId === 'string' && req.requestId.length > 0);
 T('owners and admins are notified', req.notified >= 2, req.notified);

 const again = await requestPasswordReset(salesActorRef);
 T('a repeated request is idempotent', again.requestId === req.requestId && again.notified === 0, again);

 const adminRoster = await listMembers(admin);
 const pending = adminRoster.find((m) => m.user_id === newHire.user_id);
 T('the roster flags the pending request', pending?.passwordResetRequested === true);
 T('the admin is told they may reset a sales member', pending?.canResetPassword === true);
 T('the admin is NOT offered a reset for the owner',
  adminRoster.find((m) => m.role === 'owner')?.canResetPassword === false);

 let weak = false;
 try { await resetMemberPassword(owner, newHire.user_id, 'password'); } catch { weak = true; }
 T('a weak password is refused', weak);

 let adminOnOwner = false;
 try { await resetMemberPassword(admin, owner.userId, 'Qq-8830-Marble-vt'); } catch { adminOnOwner = true; }
 T('an admin cannot reset an owner', adminOnOwner);

 const done = await resetMemberPassword(owner, newHire.user_id, 'Zz-5521-Lantern-kq');
 T('the owner resets the member and their sessions are revoked',
  typeof done.sessionsRevoked === 'number', done.sessionsRevoked);

 let oldFails = false;
 try { await loginUser({ email: 'new-hire@corp.io', password: newHirePassword, client: C }); } catch { oldFails = true; }
 T('the old password no longer works', oldFails);
 const relog = await loginUser({ email: 'new-hire@corp.io', password: 'Zz-5521-Lantern-kq', client: C });
 T('the new password works', relog.kind === 'ok', relog.kind);
 newHirePassword = 'Zz-5521-Lantern-kq';

 const cleared = (await listMembers(admin)).find((m) => m.user_id === newHire.user_id);
 T('the pending request clears after the reset', cleared?.passwordResetRequested === false);

 let ownerReq = false;
 try { await requestPasswordReset(owner); } catch { ownerReq = true; }
 T('an owner cannot open a reset request', ownerReq);

 const { canResetPassword } = await import('../../services/rbac.ts');
 T('only an owner may reset an owner',
  canResetPassword('owner', 'owner') && !canResetPassword('admin', 'owner'));
 T('an admin may reset a peer admin', canResetPassword('admin', 'admin'));
 T('nobody below admin may reset anyone',
  !canResetPassword('manager', 'sales') && !canResetPassword('sales', 'viewer') && !canResetPassword('viewer', 'viewer'));
}

//  HTTP layer 
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
 fetch(`${base}${path}`, {
  ...init,
  headers: {
   'content-type': 'application/json',
   // csrfGuard rejects a state-changing request with neither Origin nor
   // Referer; this origin is in APP_ORIGINS for the test environment.
   origin: 'http://localhost:3000',
   ...(init.headers as Record<string, string> | undefined),
  },
 });

const ownerLogin = await loginUser({ email: 'members-owner@corp.io', password: 'Xx-7742-Quorum-ra', client: C });
const ownerToken = ownerLogin.kind === 'ok' ? ownerLogin.accessToken : '';
const salesLogin = await loginUser({ email: 'new-hire@corp.io', password: newHirePassword, client: C });
const salesToken = salesLogin.kind === 'ok' ? salesLogin.accessToken : '';

console.log('\n=== HTTP: closed to anonymous callers ===');
{
 const res = await call('/api/v1/org/members', {
  method: 'POST', body: JSON.stringify({ email: 'anon@corp.io', role: 'sales' }),
 });
 await res.arrayBuffer();
 T('POST /api/v1/org/members -> 401 without a session', res.status === 401, res.status);
}

console.log('\n=== HTTP: an owner may create, but not an owner role ===');
{
 const res = await call('/api/v1/org/members', {
  method: 'POST',
  headers: { authorization: `Bearer ${ownerToken}` },
  body: JSON.stringify({ email: 'http-created@corp.io', role: 'manager', name: 'Http Created' }),
 });
 const body = await res.json() as { data?: Record<string, unknown> };
 T('owner POST /api/v1/org/members -> 201', res.status === 201, res.status);
 T('the response carries the one-time password',
  typeof body.data?.generatedPassword === 'string' && body.data.generatedPassword.length >= 16);
 T('the response carries no password hash', !JSON.stringify(body).includes('password_hash'), Object.keys(body.data ?? {}));

 const badRole = await call('/api/v1/org/members', {
  method: 'POST', headers: { authorization: `Bearer ${ownerToken}` },
  body: JSON.stringify({ email: 'owner-http@corp.io', role: 'owner' }),
 });
 await badRole.arrayBuffer();
 T('role owner is refused by the schema -> 422', badRole.status === 422, badRole.status);

 const badEmail = await call('/api/v1/org/members', {
  method: 'POST', headers: { authorization: `Bearer ${ownerToken}` },
  body: JSON.stringify({ email: 'not-an-email', role: 'sales' }),
 });
 await badEmail.arrayBuffer();
 T('a malformed email is refused -> 422', badEmail.status === 422, badEmail.status);
}

console.log('\n=== HTTP: a sales member has no user-management authority ===');
{
 const post = await call('/api/v1/org/members', {
  method: 'POST', headers: { authorization: `Bearer ${salesToken}` },
  body: JSON.stringify({ email: 'insider@corp.io', role: 'viewer' }),
 });
 await post.arrayBuffer();
 T('a sales user cannot create members -> 403', post.status === 403, post.status);

 const list = await call('/api/v1/org/members', { headers: { authorization: `Bearer ${salesToken}` } });
 await list.arrayBuffer();
 T('a sales user cannot list members -> 403', list.status === 403, list.status);

 const roles = await call('/api/v1/org/roles', { headers: { authorization: `Bearer ${salesToken}` } });
 await roles.arrayBuffer();
 T('a sales user cannot read the role matrix -> 403', roles.status === 403, roles.status);
}

console.log('\n=== HTTP: the role matrix drives the create form ===');
{
 const res = await call('/api/v1/org/roles', { headers: { authorization: `Bearer ${ownerToken}` } });
 const body = await res.json() as { data?: { assignable?: string[]; note?: string } };
 const assignable = body.data?.assignable ?? [];
 T('the owner is offered a non-empty set', assignable.length > 0, assignable);
 T('the set never includes owner', !assignable.includes('owner'), assignable);
 T('the payload names the ownership route', typeof body.data?.note === 'string' && body.data.note.includes('transfer-ownership'), body.data?.note);
}

//  HTTP: password reset endpoints 
console.log('\n=== HTTP: password reset endpoints ===');
{
 const req = await call('/api/v1/org/members/password-reset-request', {
  method: 'POST', headers: { authorization: `Bearer ${salesToken}` },
 });
 await req.arrayBuffer();
 T('a member can POST a reset request -> 201', req.status === 201, req.status);

 const anon = await call('/api/v1/org/members/password-reset-request', { method: 'POST' });
 await anon.arrayBuffer();
 T('an anonymous reset request -> 401', anon.status === 401, anon.status);

 const forbidden = await call(`/api/v1/org/members/${owner.userId}/password`, {
  method: 'POST', headers: { authorization: `Bearer ${salesToken}` },
  body: JSON.stringify({ password: 'Rr-3390-Pebble-nx' }),
 });
 await forbidden.arrayBuffer();
 T('a sales member cannot reset a password -> 403', forbidden.status === 403, forbidden.status);

 const created = await (await call('/api/v1/org/members', {
  method: 'POST', headers: { authorization: `Bearer ${ownerToken}` },
  body: JSON.stringify({ email: 'resettable@corp.io', role: 'manager' }),
 })).json() as { data?: { user?: { id?: string } } };
 const targetId = created.data?.user?.id ?? '';

 const ok = await call(`/api/v1/org/members/${targetId}/password`, {
  method: 'POST', headers: { authorization: `Bearer ${ownerToken}` },
  body: JSON.stringify({ password: 'Tt-6612-Cobalt-yz' }),
 });
 await ok.arrayBuffer();
 T('the owner resets a member -> 200', ok.status === 200, ok.status);

 const bad = await call(`/api/v1/org/members/${targetId}/password`, {
  method: 'POST', headers: { authorization: `Bearer ${ownerToken}` },
  body: JSON.stringify({ password: 'short' }),
 });
 await bad.arrayBuffer();
 T('a weak password is refused -> 422', bad.status === 422, bad.status);

 const unknown = await call('/api/v1/org/members/00000000-0000-0000-0000-000000000000/password', {
  method: 'POST', headers: { authorization: `Bearer ${ownerToken}` },
  body: JSON.stringify({ password: 'Tt-6612-Cobalt-yz' }),
 });
 await unknown.arrayBuffer();
 T('an unknown member -> 404', unknown.status === 404, unknown.status);
}

server.close();
await new Promise<void>((r) => server.once('close', r));

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
