/**
 * Single-use, hashed, expiring secrets: password reset, email verification,
 * invitations, share links. Only the SHA-256 hash is persisted (RULE 19/29);
 * the raw token exists exactly once, in transit to the recipient.
 */
import { newSecret, sha256 } from './ids.ts';
import { isoPlus } from './time.ts';

export type MintedToken = { token: string; tokenHash: string; expiresAt: string };

export const mintToken = (ttlSec: number): MintedToken => {
 const token = newSecret(32);
 return { token, tokenHash: sha256(token), expiresAt: isoPlus(ttlSec) };
};

export const hashToken = (token: string): string => sha256(token);

export const TOKEN_TTL = {
 passwordResetSec: 900, // 15 minutes
 emailVerifySec: 86_400, // 24 hours
 inviteSec: 604_800, // 7 days
 mfaEnrollmentSec: 600, // 10 minutes
 shareLinkSec: 86_400,
} as const;

// ── MFA recovery codes (RULE 25) ─────────────────────────────────────────────
/** Crockford-ish alphabet: no I/O/0/1 to survive transcription. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type RecoveryCodes = { codes: string[]; hashes: string[] };

/**
 * Plaintext codes are returned to the user exactly once and only the SHA-256
 * hashes are stored, so a database read cannot be replayed as a second factor.
 */
/**
 * Canonical form of a recovery code: uppercase, punctuation removed.
 *
 * Declared before `generateRecoveryCodes` because that function hashes with it.
 * Both sides MUST use this exact function -- a generator that hashes `ABCDE-FGHJK`
 * against a verifier that hashes `ABCDEFGHJK` produces codes that never match,
 * which is exactly the bug this ordering now makes impossible to reintroduce by
 * accident.
 */
export const normaliseRecoveryCode = (raw: string): string =>
 String(raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

export const generateRecoveryCodes = (count = 10): RecoveryCodes => {
 const codes: string[] = [];
 for (let i = 0; i < count; i++) {
 let c = '';
 for (let j = 0; j < 10; j++) c += RECOVERY_ALPHABET[crypto.getRandomValues(new Uint8Array(1))[0]! % RECOVERY_ALPHABET.length];
 codes.push(`${c.slice(0, 5)}-${c.slice(5)}`);
 }
 // Hash the NORMALISED form. It previously hashed `c.toUpperCase()`, which keeps
 // the dash, while the lookup path normalises the dash away -- so a generated
 // code never matched its own stored hash and recovery codes were unusable.
 // Normalising once, here, is what makes generation and verification agree.
 return { codes, hashes: codes.map((c) => sha256(normaliseRecoveryCode(c))) };
};
