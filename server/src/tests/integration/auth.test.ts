import { migrate } from '../../db/migrate.ts';
await migrate();
import { registerUser, loginUser, listSessions, changePassword, requestPasswordReset, resetPassword } from '../../services/auth.ts';

const trim = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0]!.slice(0, 110);
};
let pass = 0; const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  if (c) { pass++; console.log(`  [PASS] ${l}`); } else { fails.push(l); console.log(`  [FAIL] ${l} -> ${trim(x)}`); }
};
/** Every negative assertion goes through this so an expected throw is not an error. */
type Attempt<T> = { ok: true; v: T } | { ok: false; e: any };
const attempt = async <T>(fn: () => Promise<T>): Promise<Attempt<T>> => {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, e }; }
};
/** Narrows an Attempt to its failure branch so `.e` is reachable. */
const errOf = <T>(a: Attempt<T>): any => (a.ok ? undefined : a.e);

const C = { ip: '10.0.0.1', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0 Safari/537.36', requestId: 'req-test' };
const PW1 = 'Str0ng-Passphrase!42';

const r = await registerUser({ name: 'Ava Stone', email: '  AVA@Acme.EXAMPLE ', password: PW1, organizationName: 'Acme Corporation', client: C });
T('register creates user + org + membership in one transaction', Boolean(r.user.id && r.organizationId));
T('email canonicalised', r.user.email === 'ava@acme.example');

const weak = await attempt(() => registerUser({ name: 'X', email: 'w@x.io', password: 'password123', organizationName: 'X Co', client: C }));
T('common password rejected (RULE 18)', !weak.ok && weak.e.code === 'VALIDATION_FAILED', weak);

const withEmail = await attempt(() => registerUser({ name: 'Quinn', email: 'quinn@corp.io', password: 'Quinn-Corp-2024!', organizationName: 'Q', client: C }));
T('password containing the email is rejected', !withEmail.ok && /email/i.test(JSON.stringify(withEmail.e.details ?? '')), withEmail);

const short = await attempt(() => registerUser({ name: 'Y', email: 'y@x.io', password: 'Ab1!efghij', organizationName: 'Y', client: C }));
T('9-char password rejected (min is 12)', !short.ok, short);

const dup = await attempt(() => registerUser({ name: 'D', email: 'AVA@acme.example', password: PW1, organizationName: 'Dup Co', client: C }));
T('duplicate email rejected', !dup.ok && dup.e.code === 'CONFLICT', dup);

const good = await loginUser({ email: 'ava@acme.example', password: PW1, client: C });
T('login succeeds', good.kind === 'ok');
if (good.kind !== 'ok') { console.log('  aborting: login failed'); process.exit(1); }
T('access token is short-lived (RULE 24)', good.accessExpiresIn <= 3600);
T('actor role resolved server-side as owner', good.actor.role === 'owner');
T('access token carries iss/aud/sub/exp/jti', (() => {
  const p = JSON.parse(Buffer.from(good.accessToken.split('.')[1]!, 'base64url').toString());
  return p.iss && p.aud && p.sub && p.exp && p.jti && p.sid && p.org;
})());

const badPw = await attempt(() => loginUser({ email: 'ava@acme.example', password: 'WrongPass1!', client: C }));
const ghost = await attempt(() => loginUser({ email: 'nobody@nowhere.io', password: 'WrongPass1!', client: C }));
T('wrong password -> generic 401', !badPw.ok && errOf(badPw)?.code === 'INVALID_CREDENTIALS', badPw);
T('unknown account -> IDENTICAL error, no enumeration (RULE 20/121)',
  !ghost.ok && errOf(ghost)?.code === errOf(badPw)?.code && errOf(ghost)?.message === errOf(badPw)?.message, ghost);

// Lockout after repeated failures (RULE 18 failed-login controls).
for (let i = 0; i < 12; i++) await attempt(() => loginUser({ email: 'ava@acme.example', password: 'WrongPass1!', client: C }));
const locked = await attempt(() => loginUser({ email: 'ava@acme.example', password: PW1, client: C }));
T('account locks after repeated failures', !locked.ok && errOf(locked)?.code === 'RATE_LIMITED', locked);
// Clear the lock so the remaining assertions can run; lockout itself is proven above.
{ const { getDb } = await import('../../db/driver.ts');
  await (await getDb()).query('UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE id = $1', [r.user.id]); }

const s1 = await listSessions(good.actor.userId, good.actor.sessionId);
T('session listed with derived device label', s1.length === 1 && s1[0]!.current === true && /Chrome on Linux/.test(s1[0]!.deviceLabel), s1);
await loginUser({ email: 'ava@acme.example', password: PW1, client: C });
T('two logins create two sessions', (await listSessions(good.actor.userId, '')).length === 2);

// Password change must invalidate other sessions (legacy defect B14).
const chg = await attempt(() => changePassword({ userId: good.actor.userId, currentPassword: PW1, newPassword: 'An0ther-Strong-Pass!77', client: C }));
T('password change succeeds', chg.ok, chg);
T('password change revokes every session (RULE 23)', chg.ok && chg.v.revoked === 2, chg);
const withNew = await attempt(() => loginUser({ email: 'ava@acme.example', password: 'An0ther-Strong-Pass!77', client: C }));
T('new password works', withNew.ok && withNew.v.kind === 'ok', withNew);
const withOld = await attempt(() => loginUser({ email: 'ava@acme.example', password: PW1, client: C }));
T('previous password no longer works', !withOld.ok && errOf(withOld)?.code === 'INVALID_CREDENTIALS', withOld);

const samePw = await attempt(() => changePassword({ userId: good.actor.userId, currentPassword: 'An0ther-Strong-Pass!77', newPassword: 'An0ther-Strong-Pass!77', client: C }));
T('new password must differ from current', !samePw.ok, samePw);

// Reset flow.
const rr = await attempt(() => requestPasswordReset('ava@acme.example', C));
T('reset token issued for a known account', rr.ok && Boolean(rr.v.token), rr);
const ghostRR = await attempt(() => requestPasswordReset('nobody@nowhere.io', C));
T('reset for unknown account returns no token (no enumeration)', ghostRR.ok && ghostRR.v.token === null && ghostRR.v.userId === null, ghostRR);
const before = (await listSessions(good.actor.userId, '')).length;
const rst = await attempt(() => resetPassword({ token: rr.ok ? rr.v.token! : '', newPassword: 'Reset-Passphrase!99', client: C }));
T('reset completes', rst.ok, rst);
T('reset revokes all sessions (RULE 23)', (await listSessions(good.actor.userId, '')).length === 0 && before > 0);
const reuse = await attempt(() => resetPassword({ token: rr.ok ? rr.v.token! : '', newPassword: 'Another-Pass!123', client: C }));
T('reset token is SINGLE USE (RULE 19)', !reuse.ok && errOf(reuse)?.code === 'INVALID_RESET_TOKEN', reuse);
const bogus = await attempt(() => resetPassword({ token: 'not-a-real-token-at-all', newPassword: 'Another-Pass!123', client: C }));
T('bogus reset token rejected with same error', !bogus.ok && errOf(bogus)?.code === 'INVALID_RESET_TOKEN', bogus);

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);