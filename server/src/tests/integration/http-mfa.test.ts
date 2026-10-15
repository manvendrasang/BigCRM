/**
 * MFA over HTTP -- a separate suite on purpose.
 *
 * The credential rate limiter is a per-process budget. `http.test.ts` had
 * already spent the auth IP allowance by the time MFA was reached, so the first
 * login returned `429 RATE_LIMITED` -- the control working correctly, but making
 * the section untestable. Splitting it into its own suite gives it a fresh
 * process and therefore a fresh budget, rather than weakening the limit for
 * tests, which would be testing something other than what ships.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { createApp } from '../../app.ts';
import { closeDb } from '../../db/driver.ts';
import { getDb } from '../../db/driver.ts';
import { totpCode } from '../../lib/totp.ts';
import { mintToken } from '../../lib/tokens.ts';
import type { AddressInfo } from 'node:net';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l} -> ${typeof x === 'string' ? x.slice(0, 130) : JSON.stringify(x ?? null).slice(0, 130)}`); }
};

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
 fetch(`${BASE}${path}`, {
 ...init,
 headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...(init.headers as Record<string, string> | undefined) },
 });
const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

const uniq = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@corp.io`;
const EMAIL = `user-${uniq}`;
const PW = 'Second-Factor-Strong!42';

console.log('\n=== MFA over HTTP ===');
{
 const db = await getDb();

 const mfaEmail = EMAIL;
 await call('/api/v1/auth/register', json({
 name: 'Mfa User', email: mfaEmail, password: PW, organizationName: 'Mfa Org Ltd',
 }));
 const mfaLogin = await call('/api/v1/auth/login', json({ email: mfaEmail, password: PW }));
 const mfaBody = await mfaLogin.json() as any;
 const mfaToken = mfaBody.data?.accessToken ?? '';
 const mfaCookies = mfaLogin.headers.getSetCookie();
 const mfaCsrf = mfaCookies.find((c) => c.startsWith('bigcrm_csrf='))?.split('=')[1]?.split(';')[0] ?? '';
 const auth = { authorization: `Bearer ${mfaToken}`, cookie: `bigcrm_csrf=${mfaCsrf}` };
 T('enrolled user signed in before MFA exists', mfaToken.split('.').length === 3);

 const noAuth = await call('/api/v1/auth/mfa/status');
 T('MFA status requires a session', noAuth.status === 401, noAuth.status);

 const status0 = await call('/api/v1/auth/mfa/status', { headers: { authorization: `Bearer ${mfaToken}` } });
 const s0 = await status0.json() as any;
 T('MFA status reports disabled before enrollment', s0.data?.enabled === false, s0);
 T('and reports zero recovery codes', s0.data?.recoveryCodesRemaining === 0, s0);

 // CSRF first, while the account is still un-enrolled -- otherwise the "already
 // enabled" guard would answer 400 and mask whether CSRF fired at all. Raw
 // fetch, because the `call` helper always attaches an allowed Origin.
 const noOrigin = await fetch(`${BASE}/api/v1/auth/mfa/enroll`, {
 method: 'POST',
 headers: { 'content-type': 'application/json', authorization: `Bearer ${mfaToken}` },
 });
 T('MFA enrollment with no Origin is CSRF-blocked', noOrigin.status === 403, noOrigin.status);
 const badOrigin = await fetch(`${BASE}/api/v1/auth/mfa/enroll`, {
 method: 'POST',
 headers: { 'content-type': 'application/json', origin: 'https://evil.example', authorization: `Bearer ${mfaToken}` },
 });
 T('MFA enrollment from a foreign Origin is CSRF-blocked', badOrigin.status === 403, badOrigin.status);

 const enroll = await call('/api/v1/auth/mfa/enroll', { method: 'POST', headers: auth });
 T('enrollment starts over the authenticated session', enroll.status === 201, enroll.status);
 const eb = await enroll.json() as any;
 const secret = eb.data?.secret ?? '';
 T('a secret is returned exactly once, over the session', /^[A-Z2-7]{16,}$/.test(secret), secret.slice(0, 8));
 T('an otpauth:// provisioning URI is returned', String(eb.data?.otpauthUri).startsWith('otpauth://totp/'));
 const cookieChallenge = (enroll.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('bigcrm_mfa='));
 T('no MFA challenge cookie is issued during enrollment', cookieChallenge === undefined);

 const userId = (await db.query<{ id: string }>(
 `SELECT u.id FROM users u WHERE u.email_normalized = $1`, [mfaEmail])).rows[0]!.id;
 const stored = (await db.query<{ totp_secret_encrypted: string; mfa_enabled: boolean }>(
 'SELECT totp_secret_encrypted, mfa_enabled FROM users WHERE id = $1', [userId])).rows[0]!;
 T('the secret is ciphertext in the database', !stored.totp_secret_encrypted.includes(secret));
 T('mfa_enabled is still false before confirmation', stored.mfa_enabled === false);

 const minted = mintToken(600);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'enroll',$4)`,
 [crypto.randomUUID(), userId, minted.tokenHash, minted.expiresAt]);

 const badConfirm = await call('/api/v1/auth/mfa/enroll/confirm', {
 method: 'POST', headers: auth, body: JSON.stringify({ challengeToken: minted.token, code: '000000' }),
 });
 T('a wrong enrollment code is refused over HTTP', badConfirm.status === 401, badConfirm.status);

 const goodConfirm = await call('/api/v1/auth/mfa/enroll/confirm', {
 method: 'POST', headers: auth, body: JSON.stringify({ challengeToken: minted.token, code: totpCode(secret) }),
 });
 T('a correct code completes enrollment', goodConfirm.status === 200, goodConfirm.status);
 const gc = await goodConfirm.json() as any;
 T('recovery codes are returned exactly once', Array.isArray(gc.data?.recoveryCodes) && gc.data.recoveryCodes.length === 10);
 void gc.data.recoveryCodes[0];

 const reissue = await call('/api/v1/auth/mfa/enroll/confirm', {
 method: 'POST', headers: auth, body: JSON.stringify({ challengeToken: minted.token, code: totpCode(secret) }),
 });
 // Re-confirming hits the "already enabled" precondition before the challenge is
 // looked up, so the status is 400 rather than 401. The property under test is
 // "a spent enrollment cannot be reused to re-issue recovery codes", so that is
 // what is asserted.
 T('a spent enrollment challenge cannot be reused', reissue.status !== 200, reissue.status);
 T('and it issues no new recovery codes', reissue.status !== 200
 && !(JSON.stringify(await reissue.clone().json()).includes('recoveryCodes')));

 // ── login now requires the second factor ──
 const secondLogin = await call('/api/v1/auth/login', json({ email: mfaEmail, password: PW }));
 T('login returns mfa_required, not a session', secondLogin.status === 200, secondLogin.status);
 const sl = await secondLogin.json() as any;
 T('the body says mfaRequired', sl.data?.mfaRequired === true, sl.data);
 T('no access token is issued before the second factor', sl.data?.accessToken === undefined);
 const challengeCookie = (secondLogin.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('bigcrm_mfa='));
 T('the challenge is delivered as an HttpOnly cookie', Boolean(challengeCookie) && /HttpOnly/i.test(challengeCookie!));

 const challengeToken = challengeCookie?.split('=')[1]?.split(';')[0] ?? '';
 T('a challenge token is present to complete', challengeToken.length > 20);

 const wrongMfa = await call('/api/v1/auth/mfa/challenge', {
 method: 'POST', body: JSON.stringify({ challengeToken, code: '000000' }),
 });
 T('a wrong MFA code is refused', wrongMfa.status === 401, wrongMfa.status);

 // A fresh login for a clean challenge.
 const third = await call('/api/v1/auth/login', json({ email: mfaEmail, password: PW }));
 const tok3 = (third.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('bigcrm_mfa='))?.split('=')[1]?.split(';')[0] ?? '';
 const okMfa = await call('/api/v1/auth/mfa/challenge', {
 method: 'POST', body: JSON.stringify({ challengeToken: tok3, code: totpCode(secret) }),
 });
 T('a correct MFA code completes the login', okMfa.status === 200, okMfa.status);
 const om = await okMfa.json() as any;
 T('the session is issued only after both factors', Boolean(om.data?.accessToken) && om.data.accessToken.split('.').length === 3);
 T('the organization is carried through', typeof om.data?.organizationId === 'string', om.data);

 const replayMfa = await call('/api/v1/auth/mfa/challenge', {
 method: 'POST', body: JSON.stringify({ challengeToken: tok3, code: totpCode(secret) }),
 });
 T('the MFA challenge cannot be replayed', replayMfa.status === 401, replayMfa.status);

 const bogus = await call('/api/v1/auth/mfa/challenge', {
 method: 'POST', body: JSON.stringify({ challengeToken: 'x'.repeat(60), code: '123456' }),
 });
 T('a fabricated challenge token is refused', bogus.status === 401, bogus.status);
}


await new Promise<void>((resolve) => server.close(() => resolve()));
await closeDb();
console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
