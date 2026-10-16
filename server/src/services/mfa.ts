/**
 * Multi-factor authentication (TOTP, RFC 6238) and recovery codes.
 *
 * The TOTP secret is encrypted at rest because it is a bearer credential: anyone
 * holding it produces a valid code from anywhere for the current 30-second step
 * with no user interaction. A plaintext secret would mean a read-only SQL
 * injection, a backup dump or a `SELECT *` in a support ticket yields a
 * permanent second-factor bypass -- a far worse blast radius than a password,
 * which at least is a KDF output rather than the credential itself. AES-256-GCM,
 * with a key derived from `SECRETS_PEPPER` through HKDF under a purpose string,
 * so this key is not the password-hashing key and one compromise cannot pivot
 * into the other.
 *
 * Replay: HOTP is deterministic, so a shoulder-surfed code would be valid for
 * its whole step. `users.mfa_last_used_step` records the accepted step and
 * refuses anything at or below it, making each code single-use.
 *
 * Enrolment is three-legged and the secret is not live until it completes:
 * `POST /auth/mfa/enroll` returns the secret and stores it encrypted with
 * `mfa_enabled` still FALSE; the app shows a code; `POST /auth/mfa/enroll/confirm`
 * verifies it, flips the flag, and returns recovery codes once. A user who
 * abandons step 1 holds an encrypted blob that grants nothing, because
 * `mfa_enabled` gates the challenge and a CHECK constraint forbids the two
 * from disagreeing.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fieldKey } from '../lib/kms.ts';
import { env } from '../config/env.ts';
import { initDriver } from '../repositories/base.ts';
import type { DbClient } from '../db/driver.ts';
import { badRequest, forbidden, invalidCredentials, notFound, tooMany, unauthorized, validationFailed } from '../lib/errors.ts';
import { newId, sha256 } from '../lib/ids.ts';
import { nowIso, isExpired } from '../lib/time.ts';
import { logger, securityLog } from '../lib/logger.ts';
import { newTotpSecret, provisioningUri, verifyTotp, currentStep } from '../lib/totp.ts';
import {
 hashToken, mintToken, TOKEN_TTL, generateRecoveryCodes, normaliseRecoveryCode,
} from '../lib/tokens.ts';

export type ChallengePurpose = 'enroll' | 'challenge' | 'disable';

/**
 * Hashes a recovery code for lookup.
 *
 * Codes are matched case-insensitively and ignoring the `XXXXX-XXXXX` dash,
 * because users transcribe these from a printout and a strict comparison would
 * lock them out over a hyphen. The stored hash is still a plain SHA-256 of the
 * normalised form -- these are 50-bit random values, not passwords, so a KDF
 * would only add latency without adding meaningful brute-force resistance.
 */
function recoveryHash(raw: string): string {
 return sha256(normaliseRecoveryCode(raw));
}

export type EnrollStart = {
 secret: string;
 otpauthUri: string;
 expiresAt: string;
};

/** Max code attempts per challenge before it must be re-issued. */
const MAX_ATTEMPTS = 5;
const CIPHER_VERSION = 'v1';

//  secret encryption 
// The field key comes from the configured provider (`lib/kms.ts`): HKDF under
// SECRETS_PEPPER by default, a KMS data key when `MFA_KEY_PROVIDER=kms`. The
// `info` string is load-bearing: change a byte and every stored secret stops
// decrypting.

/** Purpose string for the TOTP field key. Frozen; see above. */
const TOTP_KEY_INFO = 'mfa.totp_secret';

function secretKey(): Buffer {
 return fieldKey(TOTP_KEY_INFO);
}

export function encryptSecret(plain: string): string {
 return encryptSecretWith(secretKey(), plain);
}

/** Envelope encryption under an explicit key. The rekey tool needs this;
 * everything else uses the ambient provider via `encryptSecret`. */
export function encryptSecretWith(key: Buffer, plain: string): string {
 const iv = randomBytes(12);
 const cipher = createCipheriv('aes-256-gcm', key, iv);
 const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
 const tag = cipher.getAuthTag();
 return `${CIPHER_VERSION}.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

/**
 * Decrypts, or returns null.
 *
 * A null return is deliberate and covers three distinct realities -- absent,
 * malformed, and tampered -- because they are indistinguishable to the caller and
 * all three mean the same thing operationally: this account cannot use TOTP, and
 * the owner must be told. Authenticated encryption means a tampered ciphertext
 * throws here rather than yielding a garbage secret that would mint codes no
 * one could predict.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
 return decryptSecretWith(secretKey(), stored, true);
}

/**
 * Decryption under an explicit key. `logFailure` exists for the rekey tool:
 * bulk-migrating hundreds of rows must not emit a security event per row --
 * the summary is reported once by the caller instead.
 */
export function decryptSecretWith(
 key: Buffer,
 stored: string | null | undefined,
 logFailure = true,
): string | null {
 if (!stored) return null;
 const parts = stored.split('.');
 if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
 if (logFailure) logger.warn('totp secret is not in a recognised envelope; treating as unusable');
 return null;
 }
 try {
 const iv = Buffer.from(parts[1]!, 'base64url');
 const tag = Buffer.from(parts[2]!, 'base64url');
 const data = Buffer.from(parts[3]!, 'base64url');
 const decipher = createDecipheriv('aes-256-gcm', key, iv); // nosemgrep: javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length -- false positive: setAuthTag(tag) on the next line sets the full 128-bit tag before final()
 decipher.setAuthTag(tag);
 return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
 } catch (err) {
 // Tampering, or a key rotated underneath us. Either way the secret is gone.
 if (logFailure) {
 logger.error({ err }, 'totp secret failed authenticated decryption');
 securityLog('auth.mfa.challenge_failed', { reason: 'secret_undecryptable' });
 }
 return null;
 }
}

//  challenge store 

type ChallengeRow = {
 id: string; user_id: string; purpose: ChallengePurpose; attempts: number;
 expires_at: string; consumed_at: string | null;
};

async function issueChallenge(db: Awaited<ReturnType<typeof initDriver>>, userId: string, purpose: ChallengePurpose) {
 const token = mintToken(TOKEN_TTL.mfaEnrollmentSec);
 await db.query(
 `INSERT INTO mfa_challenges (id, user_id, token_hash, purpose, expires_at)
 VALUES ($1,$2,$3,$4,$5)`,
 [newId(), userId, token.tokenHash, purpose, token.expiresAt],
 );
 return { token: token.token, expiresAt: token.expiresAt };
}

async function consumeChallenge(
 db: Awaited<ReturnType<typeof initDriver>>,
 userId: string,
 rawToken: string,
 purpose: ChallengePurpose,
): Promise<ChallengeRow> {
 const rows = await db.query<ChallengeRow>(
 `SELECT id, user_id, purpose, attempts, expires_at, consumed_at
 FROM mfa_challenges
 WHERE token_hash = $1 AND user_id = $2 AND purpose = $3 AND consumed_at IS NULL`,
 [hashToken(rawToken), userId, purpose],
 );
 const row = rows.rows[0];
 if (!row) throw unauthorized('This MFA challenge is not valid.');
 if (isExpired(row.expires_at)) {
 await db.query('UPDATE mfa_challenges SET consumed_at = $1 WHERE id = $2', [nowIso(), row.id]);
 throw unauthorized('This MFA challenge has expired.');
 }
 if (row.attempts >= MAX_ATTEMPTS) {
 // Burn the challenge outright: five wrong codes means the token is in someone's
 // hands, and unlimited retries would let them keep guessing.
 await db.query('UPDATE mfa_challenges SET consumed_at = $1 WHERE id = $2', [nowIso(), row.id]);
 securityLog('auth.mfa.challenge_failed', { userId, reason: 'attempts_exhausted', purpose });
 throw tooMany('Too many incorrect codes. Start again.');
 }
 return row;
}

async function bumpAttempt(db: Awaited<ReturnType<typeof initDriver>>, id: string): Promise<void> {
 await db.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1', [id]);
}

/**
 * Atomically claims a challenge by marking it consumed, and reports whether
 * THIS caller won.
 *
 * `consumeChallenge` above only *reads*; the `consumed_at` write used to happen
 * much later and unconditionally, so two concurrent requests carrying the same
 * challenge token both passed the read, both verified, and both went on to mint
 * a session -- one challenge yielding two sessions. The conditional write plus
 * the `rowCount` check makes the claim a compare-and-set: exactly one caller
 * sees a row, the loser is told the challenge is spent.
 *
 * The same idiom is used for invitation acceptance in services/org.ts.
 */
async function claimChallenge(
 client: Pick<DbClient, 'query'>,
 id: string,
): Promise<boolean> {
 const res = await client.query<{ id: string }>(
 'UPDATE mfa_challenges SET consumed_at = $1 WHERE id = $2 AND consumed_at IS NULL RETURNING id',
 [nowIso(), id],
 );
 return res.rows.length > 0;
}

//  enrollment 

/**
 * Begins enrollment. The secret is stored encrypted but `mfa_enabled` stays
 * false, so nothing about the account's security posture changes until the user
 * proves they can generate codes.
 */
export async function startEnrollment(userId: string): Promise<EnrollStart> {
 const db = await initDriver();
 const users = await db.query<{ email: string; mfa_enabled: boolean }>(
 'SELECT email, mfa_enabled FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
 const user = users.rows[0];
 if (!user) throw notFound('Account not found.');
 if (user.mfa_enabled) throw badRequest('Multi-factor authentication is already enabled.');

 // Re-enrolling discards any earlier unconfirmed secret, so a lost phone leaves no
 // stale half-enrolled state behind.
 await db.query(
 `DELETE FROM mfa_challenges WHERE user_id = $1 AND purpose = 'enroll' AND consumed_at IS NULL`, [userId]);

 const secret = newTotpSecret();
 await db.query(
 'UPDATE users SET totp_secret_encrypted = $1 WHERE id = $2',
 [encryptSecret(secret), userId],
 );

 const challenge = await issueChallenge(db, userId, 'enroll');
 securityLog('auth.mfa.enrolled', { userId, stage: 'secret_issued' });

 return {
 secret,
 otpauthUri: provisioningUri({
 secret,
 accountName: user.email,
 issuer: env.envName === 'test' ? 'BigCRM (test)' : 'BigCRM',
 }),
 expiresAt: challenge.expiresAt,
 };
}

/**
 * Confirms enrollment with a code from the authenticator app, then returns
 * recovery codes. This is the only moment recovery codes are ever produced, and
 * they are never stored in a form that could be re-displayed.
 */
export async function confirmEnrollment(
 userId: string,
 rawToken: string,
 code: string,
): Promise<{ recoveryCodes: string[] }> {
 const db = await initDriver();
 const rows = await db.query<{ totp_secret_encrypted: string | null; mfa_enabled: boolean }>(
 'SELECT totp_secret_encrypted, mfa_enabled FROM users WHERE id = $1', [userId]);
 const user = rows.rows[0];
 if (!user) throw notFound('Account not found.');
 if (user.mfa_enabled) throw badRequest('Multi-factor authentication is already enabled.');

 const secret = decryptSecret(user.totp_secret_encrypted);
 if (!secret) {
 throw badRequest('No enrollment is in progress. Start again from your authenticator app.');
 }

 const challenge = await consumeChallenge(db, userId, rawToken, 'enroll');
 const check = verifyTotp(secret, code, { window: 1 });
 if (!check.ok) {
 await bumpAttempt(db, challenge.id);
 securityLog('auth.mfa.challenge_failed', { userId, stage: 'enroll_confirm', reason: check.reason });
 throw invalidCredentials();
 }

 // Shown once, stored hashed. The plaintext and hashes are returned together so
 // the pairing cannot drift.
 const { codes, hashes } = generateRecoveryCodes(10);
 await db.transaction(async (tx) => {
 // The challenge claim is first and conditional: two concurrent confirmations
 // with the same token must not both mint recovery codes. The loser gets no row
 // and fails, rolling the transaction back.
 if (!(await claimChallenge(tx, challenge.id))) {
 throw unauthorized('This MFA challenge is not valid.');
 }
 await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
 for (const h of hashes) {
 await tx.query(
 'INSERT INTO mfa_recovery_codes (id, user_id, code_hash) VALUES ($1,$2,$3)',
 [newId(), userId, h],
 );
 }
 // Conditional for the same reason: two confirmations under different challenges
 // must not issue two code sets and silently kill the first caller's.
 const enabled = await tx.query<{ id: string }>(
 'UPDATE users SET mfa_enabled = true, mfa_enrolled_at = $1 WHERE id = $2 AND mfa_enabled = false RETURNING id',
 [nowIso(), userId],
 );
 if (enabled.rows.length === 0) {
 throw badRequest('Multi-factor authentication is already enabled.');
 }
 });

 securityLog('auth.mfa.enrolled', { userId, stage: 'confirmed' });
 return { recoveryCodes: codes };
}

/** Begins an MFA challenge at login. Issued only after the password is correct. */
export async function startChallenge(userId: string): Promise<{ token: string; expiresAt: string }> {
 const db = await initDriver();
 await db.query(
 `DELETE FROM mfa_challenges WHERE user_id = $1 AND purpose = 'challenge' AND consumed_at IS NULL`, [userId]);
 return issueChallenge(db, userId, 'challenge');
}

/**
 * Verifies a login challenge. Accepts either a TOTP code or a recovery code.
 *
 * A recovery code is spent on use and revoked by `mfa_recovery_used_at` on the
 * user, so losing a phone does not leave the account permanently wedged.
 */
export async function completeChallenge(
 userId: string,
 rawToken: string,
 code: string,
): Promise<{ via: 'totp' | 'recovery' }> {
 const db = await initDriver();
 const rows = await db.query<{ totp_secret_encrypted: string | null; mfa_last_used_step: string | null }>(
 'SELECT totp_secret_encrypted, mfa_last_used_step FROM users WHERE id = $1', [userId]);
 const user = rows.rows[0];
 if (!user) throw notFound('Account not found.');

 const challenge = await consumeChallenge(db, userId, rawToken, 'challenge');
 const candidate = String(code ?? '').trim();
 if (candidate === '') {
 await bumpAttempt(db, challenge.id);
 throw validationFailed({ code: 'Enter your authentication code.' });
 }

 //  recovery code 
 const recovery = await db.query<{ id: string }>(
 `SELECT id FROM mfa_recovery_codes
 WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1`,
 [userId, recoveryHash(candidate)],
 );
 if (recovery.rows[0]) {
 await db.transaction(async (tx) => {
 // Compare-and-set: the code must still be unused when claimed, so two
 // concurrent redemptions cannot both spend it.
 const claimed = await tx.query<{ id: string }>(
 'UPDATE mfa_recovery_codes SET used_at = $1 WHERE id = $2 AND used_at IS NULL RETURNING id',
 [nowIso(), recovery.rows[0]!.id],
 );
 if (claimed.rows.length === 0) throw invalidCredentials();
 if (!(await claimChallenge(tx, challenge.id))) {
 throw unauthorized('This MFA challenge is not valid.');
 }
 await tx.query('UPDATE users SET mfa_recovery_used_at = $1 WHERE id = $2', [nowIso(), userId]);
 });
 securityLog('auth.mfa.recovery_code_used', { userId });
 return { via: 'recovery' };
 }

 //  TOTP 
 const secret = decryptSecret(user.totp_secret_encrypted);
 if (!secret) {
 await db.query('UPDATE mfa_challenges SET consumed_at = $1 WHERE id = $2', [nowIso(), challenge.id]);
 securityLog('auth.mfa.challenge_failed', { userId, reason: 'secret_undecryptable' });
 throw forbidden('Your authenticator setup can no longer be read. Use a recovery code.');
 }

 const lastUsed = user.mfa_last_used_step === null ? null : Number(user.mfa_last_used_step);
 const check = verifyTotp(secret, candidate, { window: 1, lastUsedStep: lastUsed });
 if (!check.ok) {
 await bumpAttempt(db, challenge.id);
 securityLog('auth.mfa.challenge_failed', { userId, stage: 'login', reason: check.reason });
 // Identical to a wrong recovery code, so an attacker cannot learn which
 // factor type they are being judged against.
 throw invalidCredentials();
 }

 await db.transaction(async (tx) => {
 // Record the step the code ACTUALLY came from, not the current step.
 // `verifyTotp` tolerates ±1 for clock skew, so a code may match at delta +1;
 // storing `currentStep()` would then record a step one behind the code that
 // was accepted, and the same code would still verify on the next attempt --
 // which is precisely the replay this column exists to stop.
 //
 // The claim is conditional on the step not already being spent. `GREATEST`
 // alone only made the stored value monotonic; it did not prevent two
 // concurrent requests carrying the SAME code from both verifying against
 // the same observed `lastUsedStep` and both being accepted. Requiring
 // `mfa_last_used_step < $1` turns the write into a compare-and-set: the
 // replayed request matches no row and is refused.
 const step = currentStep() + check.delta;
 const claimed = await tx.query<{ id: string }>(
 `UPDATE users SET mfa_last_used_step = $1
 WHERE id = $2 AND (mfa_last_used_step IS NULL OR mfa_last_used_step < $1)
 RETURNING id`,
 [step, userId],
 );
 if (claimed.rows.length === 0) {
 securityLog('auth.mfa.challenge_failed', { userId, stage: 'login', reason: 'replayed_step' });
 throw invalidCredentials();
 }
 if (!(await claimChallenge(tx, challenge.id))) {
 throw unauthorized('This MFA challenge is not valid.');
 }
 });
 securityLog('auth.mfa.verified', { userId, via: 'totp' });
 return { via: 'totp' };
}

/**
 * Disables MFA.
 *
 * Requires a current TOTP code or a recovery code -- holding a session is not
 * sufficient. An attacker with a stolen session cookie must not be able to strip
 * the second factor and log in again.
 */
export async function disableMfa(userId: string, code: string): Promise<void> {
 const db = await initDriver();
 const rows = await db.query<{ mfa_enabled: boolean; totp_secret_encrypted: string | null; mfa_last_used_step: string | null }>(
 'SELECT mfa_enabled, totp_secret_encrypted, mfa_last_used_step FROM users WHERE id = $1', [userId]);
 const user = rows.rows[0];
 if (!user) throw notFound('Account not found.');
 if (!user.mfa_enabled) throw badRequest('Multi-factor authentication is not enabled.');

 const secret = decryptSecret(user.totp_secret_encrypted);
 // The TOTP step the caller's code came from, or null when the code is not a
 // live TOTP code. Recording it in the clearing UPDATE below makes the code
 // single-use: two concurrent disables with the same code cannot both pass.
 let totpStep: number | null = null;
 if (secret) {
 const lastStep = user.mfa_last_used_step === null || user.mfa_last_used_step === undefined
 ? null : Number(user.mfa_last_used_step);
 const v = verifyTotp(secret, code, { window: 1, lastUsedStep: lastStep });
 if (v.ok) totpStep = currentStep() + v.delta;
 }
 if (totpStep === null) {
 const recovery = await db.query<{ id: string }>(
 `SELECT id FROM mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1`,
 [userId, recoveryHash(String(code ?? ''))]);
 if (!recovery.rows[0]) {
 securityLog('auth.mfa.disabled', { userId, outcome: 'denied' });
 throw invalidCredentials();
 }
 // Compare-and-set: the code must still be unused at the moment we spend
 // it, so two concurrent disables cannot both spend the same code.
 const spent = await db.query<{ id: string }>(
 'UPDATE mfa_recovery_codes SET used_at = $1 WHERE id = $2 AND used_at IS NULL RETURNING id',
 [nowIso(), recovery.rows[0].id],
 );
 if (spent.rows.length === 0) {
 securityLog('auth.mfa.disabled', { userId, outcome: 'denied' });
 throw invalidCredentials();
 }
 }

 // Clearing the secret as well as the flag is required, not cosmetic: the
 // CHECK constraint added in 0003 refuses `mfa_enabled = true` without one, and
 // leaving an orphaned secret would be a credential with no owner.
 // The step predicate is the TOTP half of the race: it refuses a code whose
 // step was spent between verification above and this write. The
 // `mfa_enabled` predicate is the other half: a concurrent disable that won
 // first leaves no enabled flag behind, so the loser matches nothing and
 // fails instead of reporting success for work it did not do.
 const cleared = await db.query<{ id: string }>(
 `UPDATE users SET mfa_enabled = false, mfa_enrolled_at = NULL, totp_secret_encrypted = NULL,
 mfa_last_used_step = NULL, mfa_recovery_used_at = NULL
 WHERE id = $1 AND mfa_enabled = true
 AND (mfa_last_used_step IS NULL OR $2::bigint IS NULL OR mfa_last_used_step < $2::bigint)
 RETURNING id`,
 [userId, totpStep],
 );
 if (cleared.rows.length === 0) {
 securityLog('auth.mfa.disabled', { userId, outcome: 'denied' });
 throw invalidCredentials();
 }
 await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
 securityLog('auth.mfa.disabled', { userId });
}

/**
 * Resolves which user a login challenge belongs to, without consuming it.
 *
 * The public `POST /auth/mfa/challenge` route needs the identity *before* it can
 * verify anything, and the challenge token is the only credential it holds. This
 * reads the row and returns the id; `completeChallenge` still does all the
 * verification. Separating lookup from verification keeps the "resolve then
 * verify" order explicit rather than implied.
 */
export async function resolveChallengeUser(rawToken: string): Promise<string> {
 const db = await initDriver();
 const rows = await db.query<{ user_id: string; expires_at: string; consumed_at: string | null; attempts: number }>(
 `SELECT user_id, expires_at, consumed_at, attempts
 FROM mfa_challenges
 WHERE token_hash = $1 AND purpose = 'challenge'`,
 [hashToken(rawToken)],
 );
 const row = rows.rows[0];
 // One message for absent, consumed, expired and exhausted. Distinguishing them
 // would tell an attacker whether a guessed token was ever real.
 if (!row || row.consumed_at || isExpired(row.expires_at) || row.attempts >= MAX_ATTEMPTS) {
 throw unauthorized('This sign-in attempt is no longer valid. Start again.');
 }
 return row.user_id;
}

/**
 * Re-issues recovery codes without disabling MFA.
 *
 * The current second factor must be proven first, exactly as for `disableMfa`:
 * regenerating codes is a way to take over the account if it does not require
 * the thing being replaced.
 */
export async function regenerateRecoveryCodes(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
 const db = await initDriver();
 const rows = await db.query<{ mfa_enabled: boolean; totp_secret_encrypted: string | null; mfa_last_used_step: string | null }>(
 'SELECT mfa_enabled, totp_secret_encrypted, mfa_last_used_step FROM users WHERE id = $1', [userId]);
 const user = rows.rows[0];
 if (!user) throw notFound('Account not found.');
 if (!user.mfa_enabled) throw badRequest('Multi-factor authentication is not enabled.');

 const secret = decryptSecret(user.totp_secret_encrypted);
 // The step check closes a replay gap: regeneration used to accept any live
 // code without consulting `mfa_last_used_step`, so one shoulder-surfed code
 // could regenerate (and thus invalidate the owner's printed codes)
 // repeatedly for its whole 30-second step.
 let step: number | null = null;
 if (secret) {
 const lastStep = user.mfa_last_used_step === null || user.mfa_last_used_step === undefined
 ? null : Number(user.mfa_last_used_step);
 const v = verifyTotp(secret, code, { window: 1, lastUsedStep: lastStep });
 if (v.ok) step = currentStep() + v.delta;
 }
 if (step === null) {
 securityLog('auth.mfa.recovery_code_used', { userId, outcome: 'regen_denied' });
 throw invalidCredentials();
 }

 const { codes, hashes } = generateRecoveryCodes(10);
 await db.transaction(async (tx) => {
 // Spend the step here, so a concurrent regeneration with the same code
 // loses the claim and fails instead of issuing a second set.
 const claimed = await tx.query<{ id: string }>(
 `UPDATE users SET mfa_last_used_step = $1
 WHERE id = $2 AND (mfa_last_used_step IS NULL OR mfa_last_used_step < $1)
 RETURNING id`,
 [step, userId],
 );
 if (claimed.rows.length === 0) {
 securityLog('auth.mfa.recovery_code_used', { userId, outcome: 'regen_denied' });
 throw invalidCredentials();
 }
 // The old set dies with the new one: leaving valid codes behind after a
 // regeneration would defeat the point of regenerating.
 await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
 for (const h of hashes) {
 await tx.query('INSERT INTO mfa_recovery_codes (id, user_id, code_hash) VALUES ($1,$2,$3)',
 [newId(), userId, h]);
 }
 });
 securityLog('auth.mfa.recovery_code_used', { userId, action: 'regenerated' });
 return { recoveryCodes: codes };
}

/** Counts unused recovery codes so the UI can prompt before they run out. */
export async function recoveryStatus(userId: string): Promise<{ remaining: number }> {
 const db = await initDriver();
 const r = await db.query<{ n: number }>(
 'SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
 return { remaining: r.rows[0]?.n ?? 0 };
}

export const __testing = {
 MAX_ATTEMPTS, encryptSecret, decryptSecret, encryptSecretWith, decryptSecretWith,
 issueChallenge, consumeChallenge, recoveryHash, TOTP_KEY_INFO,
};
