/**
 * MFA secret rekeying: reseal every stored TOTP secret from one key provider
 * to another (typically `env` -> `kms` when adopting KMS, or back).
 *
 * Two phases, no partial migration: first every secret is decrypted with the
 * source provider (failures collected, nothing written), and only when all
 * of them open does the single transaction reseal them under the target.
 * A row that will not decrypt is reported with its user id and left alone --
 * silently dropping someone's second factor is worse than refusing to run.
 */
import { getDb } from '../db/driver.ts';
import type { KeyProvider } from '../lib/kms.ts';
import { decryptSecretWith, encryptSecretWith, __testing } from './mfa.ts';

export interface RekeyResult {
 sealed: number;
 failed: { userId: string; error: string }[];
 dryRun: boolean;
}

export async function rekeyMfaSecrets(
 from: KeyProvider,
 to: KeyProvider,
 opts: { dryRun?: boolean } = {},
): Promise<RekeyResult> {
 if (from.id === to.id) throw new Error('Source and target providers are the same -- nothing to do.');
 const db = await getDb();
 const rows = await db.query<{ user_id: string; secret: string }>(
 `SELECT id AS user_id, totp_secret_encrypted AS secret FROM users
 WHERE totp_secret_encrypted IS NOT NULL`,
 );

 const fromKey = from.fieldKey(__testing.TOTP_KEY_INFO);
 const toKey = to.fieldKey(__testing.TOTP_KEY_INFO);
 const resealed: { userId: string; sealed: string }[] = [];
 const failed: RekeyResult['failed'] = [];
 for (const row of rows.rows) {
 const plain = decryptSecretWith(fromKey, row.secret, false);
 if (plain === null) {
 failed.push({ userId: row.user_id, error: 'does not decrypt under the source provider' });
 continue;
 }
 resealed.push({ userId: row.user_id, sealed: encryptSecretWith(toKey, plain) });
 }
 if (failed.length > 0 || resealed.length === 0) {
 return { sealed: 0, failed, dryRun: Boolean(opts.dryRun) };
 }
 if (opts.dryRun) {
 return { sealed: resealed.length, failed, dryRun: true };
 }

 await db.transaction(async (tx) => {
 for (const r of resealed) {
 await tx.query('UPDATE users SET totp_secret_encrypted = $1 WHERE id = $2', [r.sealed, r.userId]);
 }
 });
 return { sealed: resealed.length, failed, dryRun: false };
}
