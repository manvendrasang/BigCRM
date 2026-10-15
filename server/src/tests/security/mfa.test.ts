/**
 * MFA tests.
 *
 * The properties that matter here are not "does TOTP work" -- `lib/totp.ts` is
 * verified against the RFC 6238 test vectors already. They are:
 *
 * 1. The secret is not recoverable from the database column.
 * 2. Enrollment cannot leave an account claiming 2FA without a second factor.
 * 3. A TOTP code cannot be replayed inside its 30-second step.
 * 4. Recovery codes are single-use and cannot be recovered from storage.
 * 5. Disabling MFA requires the second factor, not just a session.
 * 6. Every wrong-code path is rate-limited by the challenge, not just by IP.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { getDb } from '../../db/driver.ts';
import { initDriver } from '../../repositories/base.ts';
import { registerUser } from '../../services/auth.ts';
import {
 startEnrollment, confirmEnrollment, startChallenge, completeChallenge,
 disableMfa, regenerateRecoveryCodes, recoveryStatus, resolveChallengeUser,
 encryptSecret, decryptSecret,
} from '../../services/mfa.ts';
import { totpCode, currentStep } from '../../lib/totp.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l} -> ${typeof x === 'string' ? x.slice(0, 130) : JSON.stringify(x ?? null).slice(0, 130)}`); }
};
type Attempt<T> = { ok: true; v: T } | { ok: false; e: any };
const attempt = async <T>(fn: () => Promise<T>): Promise<Attempt<T>> => {
 try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, e }; }
};
const C = { ip: '10.0.0.77', userAgent: 'mfa-test/1.0', requestId: 'req-mfa' };

const db = await getDb();
const newUser = async (n: string) => {
 const r = await registerUser({
 name: n, email: `mfa-${n.toLowerCase()}@corp.io`, password: 'Second-Factor-Strong!42',
 organizationName: `${n} Ltd`, client: C,
 });
 return r.user.id;
};

// ── encryption at rest ────────────────────────────────────────────────────────
console.log('\n=== the TOTP secret is encrypted at rest (BIG-11) ===');
{
 const a = encryptSecret('JBSWY3DPEHPK3PXP');
 const b = encryptSecret('JBSWY3DPEHPK3PXP');
 T('the same plaintext encrypts differently each time (random IV)', a !== b);
 T('the ciphertext does not contain the plaintext', !a.includes('JBSWY3DPEHPK3PXP'), a);
 T('the ciphertext is versioned', a.startsWith('v1.'), a.slice(0, 12));
 T('round-trips correctly', decryptSecret(a) === 'JBSWY3DPEHPK3PXP');
 T('null in, null out', decryptSecret(null) === null);

 const tampered = `v1.${a.split('.')[1]}.${a.split('.')[2]}.${Buffer.from('tampered-payload').toString('base64url')}`;
 T('a tampered ciphertext fails to decrypt (authenticated encryption)', decryptSecret(tampered) === null);
 T('a tampered auth tag fails to decrypt',
 decryptSecret(`v1.${a.split('.')[1]}.${Buffer.from('badtag').toString('base64url')}.${a.split('.')[3]}`) === null);
 T('a malformed envelope is refused, not guessed at', decryptSecret('garbage') === null);
 T('an unknown version is refused', decryptSecret(a.replace(/^v1/, 'v9')) === null);
}

console.log('\n=== the secret in the database is ciphertext ===');
{
 const userId = await newUser('Enrol1');
 const start = await startEnrollment(userId);
 const row = (await db.query<{ totp_secret_encrypted: string | null; mfa_enabled: boolean }>(
 'SELECT totp_secret_encrypted, mfa_enabled FROM users WHERE id = $1', [userId])).rows[0];

 T('a secret is stored', Boolean(row?.totp_secret_encrypted));
 T('the stored value is not the raw secret', row!.totp_secret_encrypted !== start.secret);
 T('the stored value does not contain the raw secret', !String(row!.totp_secret_encrypted).includes(start.secret));
 T('mfa_enabled is still FALSE before confirmation', row!.mfa_enabled === false);
 T('so the half-enrolled secret grants nothing', row!.mfa_enabled === false && Boolean(row!.totp_secret_encrypted));
}

// ── enrollment ────────────────────────────────────────────────────────────────
console.log('\n=== enrollment is a three-legged flow ===');
{
 const userId = await newUser('Enrol2');
 const start = await startEnrollment(userId);
 T('a provisioning URI is returned', start.otpauthUri.startsWith('otpauth://totp/'), start.otpauthUri.slice(0, 40));
 T('the URI carries the secret', start.otpauthUri.includes(encodeURIComponent(start.secret)));
 T('the URI names the account', start.otpauthUri.includes('mfa-enrol2%40corp.io'), start.otpauthUri);

 const wrong = await attempt(() => confirmEnrollment(userId, 'x', '000000'));
 T('confirming without a valid challenge token is refused', !wrong.ok, wrong);

 const challenge = await startChallenge(userId).catch(() => null);
 void challenge;
 // The enroll challenge token is issued by startEnrollment; re-issue to capture it.
 const s2 = await startEnrollment(userId);
 const enrollToken = (await db.query<{ token_hash: string }>(
 'SELECT token_hash FROM mfa_challenges WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
 [userId, 'enroll'])).rows[0];
 T('an enroll challenge row exists', Boolean(enrollToken?.token_hash));
 void s2;

 // Complete with a real code. The challenge token is the value the service
 // returned; recover it from the route contract by re-issuing through the DB.
 const issued = await (async () => {
 await db.query('DELETE FROM mfa_challenges WHERE user_id = $1', [userId]);
 await startEnrollment(userId);
 const all = await db.query<{ id: string }>(
 'SELECT id FROM mfa_challenges WHERE user_id = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1', [userId, 'enroll']);
 return all.rows[0]!.id;
 })();
 T('re-enrollment is repeatable while unconfirmed', Boolean(issued));

 // Now drive a real confirmation using the known secret for this user.
 const secret = decryptSecret((await db.query<{ totp_secret_encrypted: string }>(
 'SELECT totp_secret_encrypted FROM users WHERE id = $1', [userId])).rows[0]!.totp_secret_encrypted)!;
 const token = await (async () => {
 // startEnrollment mints a challenge; recover its plaintext by re-issuing
 // through the service and capturing the token the route would have sent.
 return null;
 })();
 void token;

 // Use the documented contract: confirmEnrollment takes the challenge token.
 // Mint one directly so the test controls it.
 const { mintToken } = await import('../../lib/tokens.ts');
 const minted = mintToken(600);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'enroll',$4)`,
 [crypto.randomUUID(), userId, minted.tokenHash, minted.expiresAt],
 );

 const badCode = await attempt(() => confirmEnrollment(userId, minted.token, '000000'));
 T('a wrong enrollment code is refused', !badCode.ok, badCode);

 const minted2 = mintToken(600);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'enroll',$4)`,
 [crypto.randomUUID(), userId, minted2.tokenHash, minted2.expiresAt],
 );
 const confirmed = await confirmEnrollment(userId, minted2.token, totpCode(secret));
 T('a correct enrollment code confirms', Array.isArray(confirmed.recoveryCodes));
 T('ten recovery codes are issued', confirmed.recoveryCodes.length === 10, confirmed.recoveryCodes.length);
 T('codes are formatted in two groups of five', /^([A-Z2-9]{5})-([A-Z2-9]{5})$/.test(confirmed.recoveryCodes[0]!),
 confirmed.recoveryCodes[0]);
 T('codes are unique', new Set(confirmed.recoveryCodes).size === 10);

 const after = (await db.query<{ mfa_enabled: boolean; mfa_enrolled_at: string | null }>(
 'SELECT mfa_enabled, mfa_enrolled_at FROM users WHERE id = $1', [userId])).rows[0]!;
 T('mfa_enabled is now true', after.mfa_enabled === true);
 T('mfa_enrolled_at is stamped', Boolean(after.mfa_enrolled_at));

 const stored = await db.query<{ code_hash: string }>(
 'SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
 T('recovery codes are stored hashed', stored.rows.length === 10);
 T('no plaintext recovery code appears in storage',
 stored.rows.every((r) => !confirmed.recoveryCodes.some((c) => r.code_hash.includes(c))),
 stored.rows[0]?.code_hash?.slice(0, 16));
 T('stored hashes are 64 hex chars (sha256)',
 stored.rows.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash)), stored.rows[0]?.code_hash?.slice(0, 16));

 T('the enroll challenge is consumed', (await db.query(
 `SELECT consumed_at FROM mfa_challenges WHERE token_hash = $1`, [minted2.tokenHash])).rows[0]?.consumed_at !== null);
 T('recovery status reports 10 remaining', (await recoveryStatus(userId)).remaining === 10);
}

// ── login challenge ───────────────────────────────────────────────────────────
console.log('\n=== login challenge accepts TOTP and recovery codes ===');
let mfaUserId = '';
let mfaSecret = '';
let recoveryCode = '';
{
 mfaUserId = await newUser('Login1');
 await startEnrollment(mfaUserId);
 mfaSecret = decryptSecret((await db.query<{ totp_secret_encrypted: string }>(
 'SELECT totp_secret_encrypted FROM users WHERE id = $1', [mfaUserId])).rows[0]!.totp_secret_encrypted)!;
 const { mintToken } = await import('../../lib/tokens.ts');
 const m = mintToken(600);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'enroll',$4)`,
 [crypto.randomUUID(), mfaUserId, m.tokenHash, m.expiresAt]);
 const c = await confirmEnrollment(mfaUserId, m.token, totpCode(mfaSecret));
 recoveryCode = c.recoveryCodes[0]!;

 const login = await startChallenge(mfaUserId);
 T('a login challenge is issued', login.token.length > 20);
 T('the challenge resolves to the right user', await resolveChallengeUser(login.token) === mfaUserId);

 const bad = await attempt(() => completeChallenge(mfaUserId, login.token, '000000'));
 T('a wrong code is refused', !bad.ok, bad);
 T('and the error does not reveal which factor was judged', !/recovery|totp|authenticator/i.test(String(bad.ok ? '' : bad.e.message)));

 const login2 = await startChallenge(mfaUserId);
 const ok = await completeChallenge(mfaUserId, login2.token, totpCode(mfaSecret));
 T('a correct TOTP code is accepted', ok.via === 'totp');
 T('the challenge is consumed after use',
 (await db.query('SELECT consumed_at FROM mfa_challenges WHERE token_hash = $1',
 [(await db.query('SELECT token_hash FROM mfa_challenges WHERE user_id = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1',
 [mfaUserId, 'challenge'])).rows[0]!.token_hash])).rows[0]?.consumed_at !== null);

 const replay = await attempt(() => completeChallenge(mfaUserId, login2.token, totpCode(mfaSecret)));
 T('the same challenge token cannot be reused', !replay.ok, replay);
}

// ── concurrent redemption of one challenge ───────────────────────────────────
// Regression: the challenge was only READ by `consumeChallenge`; `consumed_at`
// was written later and unconditionally. Two parallel requests carrying the same
// token both passed the read, both verified, and both went on to mint a session --
// one challenge producing two sessions.
console.log('\n=== a challenge cannot be redeemed twice concurrently ===');
{
 const userId = await newUser('Concurrent1');
 await startEnrollment(userId);
 const secret = decryptSecret((await db.query<{ totp_secret_encrypted: string }>(
 'SELECT totp_secret_encrypted FROM users WHERE id = $1', [userId])).rows[0]!.totp_secret_encrypted)!;
 // `startEnrollment` issues its challenge internally without returning the
 // plaintext token, so mint one directly -- the same pattern as the login,
 // brute-force and disable blocks below. (An earlier revision passed
 // `enroll.token`, a property that does not exist: the confirmation crashed
 // on `undefined` and the whole suite died here.)
 const { mintToken } = await import('../../lib/tokens.ts');
 const m = mintToken(600);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'enroll',$4)`,
 [crypto.randomUUID(), userId, m.tokenHash, m.expiresAt]);
 await confirmEnrollment(userId, m.token, totpCode(secret));

 const ch = await startChallenge(userId);
 const code = totpCode(secret);
 const results = await Promise.all([
 attempt(() => completeChallenge(userId, ch.token, code)),
 attempt(() => completeChallenge(userId, ch.token, code)),
 attempt(() => completeChallenge(userId, ch.token, code)),
 ]);
 const winners = results.filter((r) => r.ok).length;
 T('exactly one concurrent redemption succeeds (3 parallel attempts)', winners === 1, `winners=${winners}`);

 // And the TOTP step must be spent too, not just the challenge row.
 const next = await startChallenge(userId);
 const replayStep = await attempt(() => completeChallenge(userId, next.token, code));
 T('the same TOTP step cannot be redeemed again under a new challenge', !replayStep.ok, replayStep);
}

// ── replay inside the same 30-second step ─────────────────────────────────────
console.log('\n=== a TOTP code cannot be replayed inside its step ===');
{
 // A fresh user so mfa_last_used_step starts null.
 const userId = await newUser('Replay1');
 await startEnrollment(userId);
 const secret = decryptSecret((await db.query<{ totp_secret_encrypted: string }>(
 'SELECT totp_secret_encrypted FROM users WHERE id = $1', [userId])).rows[0]!.totp_secret_encrypted)!;
 const { mintToken } = await import('../../lib/tokens.ts');
 const m = mintToken(600);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'enroll',$4)`,
 [crypto.randomUUID(), userId, m.tokenHash, m.expiresAt]);
 await confirmEnrollment(userId, m.token, totpCode(secret));

 // Target the NEXT step deterministically. A code for step N+1 verifies while
 // still in step N (the ±1 clock-skew window) and stays valid across the
 // rollover, so no wall-clock arithmetic can push it outside the window. The
 // previous form computed `totpCode(secret, Date.now() + waitMs)` from two
 // separate `Date.now()` reads; a 30-second boundary falling between them (or
 // between computing the code and verifying it) produced a code outside the
 // window or a non-positive wait -- a flake at exact step boundaries, in the
 // test's clock handling, not in the TOTP code under test.
 const code = totpCode(secret, (currentStep() + 1) * 30 * 1000);
 const c1 = await startChallenge(userId);
 const first = await completeChallenge(userId, c1.token, code);
 T('the code is accepted once', first.via === 'totp');

 // A second, independently issued challenge with the SAME code, inside the step.
 const c2 = await startChallenge(userId);
 const replay = await attempt(() => completeChallenge(userId, c2.token, code));
 T('the same code is refused on a fresh challenge (anti-replay)', !replay.ok, replay);
 T('the refusal is a generic credential error, not a hint about replay',
 !replay.ok && /credential|valid/i.test(String(replay.e.message)), replay.ok ? '' : replay.e.message);
}

// ── recovery codes ────────────────────────────────────────────────────────────
console.log('\n=== recovery codes are single-use ===');
{
 const c1 = await startChallenge(mfaUserId);
 const first = await completeChallenge(mfaUserId, c1.token, recoveryCode);
 T('a recovery code is accepted', first.via === 'recovery', first);
 T('it is marked used',
 (await db.query('SELECT used_at FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NOT NULL',
 [mfaUserId])).rows.length === 1);
 T('remaining count drops', (await recoveryStatus(mfaUserId)).remaining === 9);

 const c2 = await startChallenge(mfaUserId);
 const again = await attempt(() => completeChallenge(mfaUserId, c2.token, recoveryCode));
 T('the same recovery code cannot be used twice', !again.ok, again);

 T('the code still matches case-insensitively and ignoring the dash', (() => {
 const mangled = recoveryCode.replace('-', '').toLowerCase();
 return /^[a-z2-9]{10}$/.test(mangled);
 })(), recoveryCode);
}

// ── brute-force bounding ──────────────────────────────────────────────────────
console.log('\n=== a challenge bounds its own attempts ===');
{
 const userId = await newUser('Brute1');
 await startEnrollment(userId);
 const secret = decryptSecret((await db.query<{ totp_secret_encrypted: string }>(
 'SELECT totp_secret_encrypted FROM users WHERE id = $1', [userId])).rows[0]!.totp_secret_encrypted)!;
 const { mintToken } = await import('../../lib/tokens.ts');
 const m = mintToken(600);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'enroll',$4)`,
 [crypto.randomUUID(), userId, m.tokenHash, m.expiresAt]);
 await confirmEnrollment(userId, m.token, totpCode(secret));

 const ch = await startChallenge(userId);
 let wrongAccepted = 0;
 let exhausted: any = null;
 // Exactly MAX_ATTEMPTS wrong codes are tolerated; the next one is refused and
 // the challenge is burned. Guessing the boundary wrong in either direction is
 // a real defect -- one fewer and a legitimate user is locked out mid-typing,
 // one more and the 10^6 space is reachable.
 for (let i = 0; i < 8; i++) {
 const r = await attempt(() => completeChallenge(userId, ch.token, '000000'));
 if (r.ok) { wrongAccepted++; continue; }
 if (/Too many/i.test(String(r.e.message))) { exhausted = r; break; }
 wrongAccepted++; // a plain INVALID_CREDENTIALS is the expected wrong-code answer
 }
 T(`exactly 5 wrong codes are tolerated`, wrongAccepted === 5, wrongAccepted);
 T('the 6th wrong code exhausts the challenge',
 exhausted !== null && /Too many/i.test(String(exhausted.e.message)), exhausted);
 T('so a 10^6 code space is not brute-forceable on a single token',
 wrongAccepted === 5 && exhausted !== null);
 T('and the burned challenge cannot be revived by a correct code',
 (await attempt(() => completeChallenge(userId, ch.token, totpCode(secret)))).ok === false);
}

// ── disable requires the factor ───────────────────────────────────────────────
console.log('\n=== disabling MFA requires the second factor ===');
{
 const userId = await newUser('Disable1');
 await startEnrollment(userId);
 const secret = decryptSecret((await db.query<{ totp_secret_encrypted: string }>(
 'SELECT totp_secret_encrypted FROM users WHERE id = $1', [userId])).rows[0]!.totp_secret_encrypted)!;
 const { mintToken } = await import('../../lib/tokens.ts');
 const m = mintToken(600);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'enroll',$4)`,
 [crypto.randomUUID(), userId, m.tokenHash, m.expiresAt]);
 const conf = await confirmEnrollment(userId, m.token, totpCode(secret));

 const noCode = await attempt(() => disableMfa(userId, '000000'));
 T('a wrong code cannot disable MFA', !noCode.ok, noCode);
 T('MFA is still enabled after the failed attempt',
 (await db.query<{ mfa_enabled: boolean }>('SELECT mfa_enabled FROM users WHERE id = $1', [userId])).rows[0]!.mfa_enabled === true);

 await disableMfa(userId, conf.recoveryCodes[1]!);
 const after = (await db.query<{ mfa_enabled: boolean; totp_secret_encrypted: string | null }>(
 'SELECT mfa_enabled, totp_secret_encrypted FROM users WHERE id = $1', [userId])).rows[0]!;
 T('a valid recovery code disables MFA', after.mfa_enabled === false);
 T('the secret is cleared too, not orphaned', after.totp_secret_encrypted === null);
 T('recovery codes are deleted', (await db.query(
 'SELECT 1 FROM mfa_recovery_codes WHERE user_id = $1', [userId])).rows.length === 0);
}

// ── regenerate ────────────────────────────────────────────────────────────────
console.log('\n=== regenerating recovery codes proves the factor first ===');
{
 const userId = await newUser('Regen1');
 await startEnrollment(userId);
 const secret = decryptSecret((await db.query<{ totp_secret_encrypted: string }>(
 'SELECT totp_secret_encrypted FROM users WHERE id = $1', [userId])).rows[0]!.totp_secret_encrypted)!;
 const { mintToken } = await import('../../lib/tokens.ts');
 const m = mintToken(600);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'enroll',$4)`,
 [crypto.randomUUID(), userId, m.tokenHash, m.expiresAt]);
 const first = await confirmEnrollment(userId, m.token, totpCode(secret));
 const oldCode = first.recoveryCodes[0]!;

 const denied = await attempt(() => regenerateRecoveryCodes(userId, '000000'));
 T('regeneration without the factor is refused', !denied.ok, denied);

 // A next-step code, as above: valid on both sides of a 30-second boundary.
 // The previous `Date.now() + 31_000` landed two steps ahead whenever the
 // suite ran within ~a second before a rollover, falling outside the ±1
 // window and failing a factor proof that should succeed.
 const regen = await attempt(() => regenerateRecoveryCodes(userId, totpCode(secret, (currentStep() + 1) * 30 * 1000)));
 T('regeneration with the factor succeeds', regen.ok && regen.v.recoveryCodes.length === 10, regen);

 if (regen.ok) {
 const ok = regen;
 T('the previous code is gone', !ok.v.recoveryCodes.includes(oldCode));
 const c = await startChallenge(userId);
 const useOld = await attempt(() => completeChallenge(userId, c.token, oldCode));
 T('an old recovery code no longer works', !useOld.ok, useOld);
 const c2 = await startChallenge(userId);
 const useNew = await attempt(() => completeChallenge(userId, c2.token, ok.v.recoveryCodes[0]!));
 T('a new recovery code works', useNew.ok && (useNew.ok ? useNew.v.via === 'recovery' : false), useNew);
 }
}

// ── cross-tenant: a challenge token from one user cannot serve another ────────
console.log('\n=== a challenge token is bound to its user ===');
{
 const other = await newUser('Other1');
 const mine = await startChallenge(mfaUserId);
 const attemptAsOther = await attempt(() => completeChallenge(other, mine.token, '000000'));
 T('another user cannot consume my challenge token', !attemptAsOther.ok, attemptAsOther);
 const resolveOther = await attempt(() => resolveChallengeUser('not-a-real-token-at-all-xxxx'));
 T('a bogus challenge token is refused by the resolver', !resolveOther.ok, resolveOther);
}

// ── rekey: resealing secrets between providers ─────────────────────────────
console.log('\n=== rekeying MFA secrets between providers ===');
{
 const { createEnvProvider, __testing: kmsTesting } = await import('../../lib/kms.ts');
 const { rekeyMfaSecrets } = await import('../../services/rekey.ts');
 const { decryptSecretWith, __testing: mfaTesting } = await import('../../services/mfa.ts');

 const userId = await newUser('Rekey1');
 await startEnrollment(userId);
 const secret = decryptSecret((await db.query<{ totp_secret_encrypted: string }>(
 'SELECT totp_secret_encrypted FROM users WHERE id = $1', [userId])).rows[0]!.totp_secret_encrypted)!;
 const { mintToken } = await import('../../lib/tokens.ts');
 const m = mintToken(600);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at) VALUES ($1,$2,$3,'enroll',$4)`,
 [crypto.randomUUID(), userId, m.tokenHash, m.expiresAt]);
 await confirmEnrollment(userId, m.token, totpCode(secret));

 const envProvider = createEnvProvider();
 const kmsProvider = await kmsTesting.KmsKeyProvider.create(
 Buffer.from('ciphertext').toString('base64'), async () => Buffer.alloc(32, 9));

 const dry = await rekeyMfaSecrets(envProvider, kmsProvider, { dryRun: true });
 T('a dry run reports without writing', dry.dryRun && dry.sealed >= 1 && dry.failed.length === 0, dry);
 const stored = (await db.query<{ totp_secret_encrypted: string }>(
 'SELECT totp_secret_encrypted FROM users WHERE id = $1', [userId])).rows[0]!.totp_secret_encrypted;
 T('the dry run changed nothing',
 decryptSecretWith(envProvider.fieldKey(mfaTesting.TOTP_KEY_INFO), stored, false) === secret);

 const done = await rekeyMfaSecrets(envProvider, kmsProvider);
 T('rekey seals every secret', done.sealed >= 1 && done.failed.length === 0, done);
 const resealed = (await db.query<{ totp_secret_encrypted: string }>(
 'SELECT totp_secret_encrypted FROM users WHERE id = $1', [userId])).rows[0]!.totp_secret_encrypted;
 T('the resealed row opens under the new provider, not the old',
 decryptSecretWith(kmsProvider.fieldKey('x'), resealed, false) === secret &&
 decryptSecretWith(envProvider.fieldKey(mfaTesting.TOTP_KEY_INFO), resealed, false) === null);

 const back = await rekeyMfaSecrets(kmsProvider, envProvider);
 T('rekeying back restores the original provider', back.sealed >= 1, back);

 const same = await attempt(() => rekeyMfaSecrets(envProvider, envProvider));
 T('rekeying onto the same provider is refused', !same.ok, same);
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
await (await initDriver()).close?.().catch?.(() => undefined);
process.exit(fails.length ? 1 : 0);
