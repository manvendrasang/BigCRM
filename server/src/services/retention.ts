/**
 * Retention scheduler (BIG-12).
 *
 * The retention windows were configured but nothing ever ran them, so every
 * deployment would have accumulated sessions, audit rows, notifications and
 * export artefacts indefinitely. That is not a disk problem -- it is a data
 * minimisation problem (GDPR Art. 5(1)(e): storage limitation), and an audit
 * table nobody prunes is also an audit table nobody can afford to keep.
 *
 * ── What is deleted, and what is never deleted ───────────────────────────────
 *
 * Deleted: expired sessions, consumed/expired one-time tokens, read or expired
 * notifications, finished export artefacts, unconsumed MFA challenges.
 * Kept: `audit_logs` up to `RETENTION_AUDIT_DAYS` (default 730 = 2 years),
 * and NEVER deleted on any code path. The append-only trigger blocks
 * UPDATE and DELETE, so audit truncation is a privileged maintenance
 * operation, not something a scheduler does.
 *
 * ── Deliberate properties ────────────────────────────────────────────────────
 *
 * - **Batched.** Each purge deletes at most `batchSize` rows per table per run.
 * An unbounded `DELETE` on a large table takes a lock that stalls the API,
 * which is a self-inflicted outage in the name of housekeeping.
 * - **Tenant-agnostic on purpose.** These are system tables keyed by expiry,
 * not tenant data; no tenant predicate applies and none should.
 * - **Counts, then deletes.** The result reports how many rows went, so the
 * job is observable. A purge that silently deletes nothing looks identical to
 * a purge that never ran.
 * - **Never throws into the timer.** A failed sweep is logged and the schedule
 * continues; one bad night must not stop retention for the next month.
 */
import { env } from '../config/env.ts';
import { initDriver } from '../repositories/base.ts';
import type { DbClient } from '../db/driver.ts';
import { logger, securityLog } from '../lib/logger.ts';

type PurgeRow = { table: string; deleted: number };

/**
 * Who ran this sweep.
 *
 * `leader` this process held the lock and did the work.
 * `follower` another replica held the lock, so nothing was deleted.
 * `not-needed` `RETENTION_PURGE_ENABLED` is false.
 * `unavailable` leader election could not be attempted (see below).
 */
export type SweepRole = 'leader' | 'follower' | 'not-needed' | 'unavailable';

export type PurgeResult = {
 ranAt: string;
 rows: PurgeRow[];
 totalDeleted: number;
 errors: string[];
 role: SweepRole;
};

/**
 * Advisory-lock key for the retention sweep: two int4s reading "bi"/"gc" in
 * ASCII, i.e. bigcrm. Fixed and documented because every replica in every
 * deployment must derive the identical key -- a key derived from anything that
 * varies per process, host or release would leave each replica holding a
 * different lock, and all of them would sweep at once.
 */
export const RETENTION_LOCK_CLASS = 0x6269; // 25193 -- 'bi'
export const RETENTION_LOCK_OBJECT = 0x6763; // 26467 -- 'gc'

/** Deletes at most `limit` rows older than `sql` cutoff. Returns the count. */
async function purgeBatched(
 db: DbClient,
 table: string,
 where: string,
 cutoff: string,
 limit: number,
): Promise<number> {
 // `ctid` gives a stable, indexed-enough handle for a bounded delete without
 // needing a surrogate key on every purgeable table.
 // `$1` is the batch limit, `$2` the cutoff -- every `where` clause above is
 // written against `$2`. Binding only the limit produced "supplies 1
 // parameters, but prepared statement requires 2" on every table.
 const r = await db.query(
 `WITH doomed AS (
 SELECT ctid FROM ${table} WHERE ${where} LIMIT $1
 )
 DELETE FROM ${table} t USING doomed WHERE t.ctid = doomed.ctid
 RETURNING 1`,
 [limit, cutoff],
 );
 return r.rowCount;
}

/**
 * One sweep. Safe to call at any time; a no-op when `RETENTION_PURGE_ENABLED`
 * is false, which is the default so a developer machine never deletes anything.
 *
 * ── Leader election ──────────────────────────────────────────────────────────
 *
 * The scheduler runs in every replica. Without coordination, N replicas sweep
 * simultaneously: N× the lock contention on tables the API is reading, N× the
 * I/O, and N concurrent multi-thousand-row deletes on the same rows -- all for a
 * result where the loser of each race simply deletes nothing. It was recorded
 * as accepted risk A5 for exactly that reason, and this closes it.
 *
 * The mechanism is a PostgreSQL advisory lock, chosen over a lease table for
 * one decisive property: **the lock dies with the connection.** A replica that
 * is SIGKILLed mid-sweep holds nothing, so the next tick on any replica proceeds
 * within seconds. A lease row needs a separate reaper, and a reaper that guesses
 * wrong either blocks retention indefinitely or lets two replicas sweep at once.
 *
 * `pg_try_advisory_lock` rather than `pg_advisory_lock`: blocking would park a
 * replica on a timer callback while another sweeps. Losing the election is a
 * normal, expected outcome, not something to wait on.
 *
 * ── Why the whole sweep holds one connection ─────────────────────────────────
 *
 * Advisory locks are held per *session*, not per statement. If the lock were
 * taken via `db.query()` on the pool, each subsequent statement would land on an
 * arbitrary different connection, and the lock would be guarding nothing while
 * its unlock released some other session's lock. `withConnection` pins one
 * session for the entire sweep, which is what makes the lock mean anything.
 *
 * Each delete still autocommits individually -- this is deliberately *not* one
 * transaction. The property that a failure on one table must not abort the rest
 * depends on that, and a single large transaction spanning ten tables would
 * hold row locks across the whole sweep.
 */
export async function runRetentionSweep(now: Date = new Date()): Promise<PurgeResult> {
 const result: PurgeResult = { ranAt: now.toISOString(), rows: [], totalDeleted: 0, errors: [], role: 'not-needed' };

 if (!env.retention.purgeEnabled) {
 logger.debug('retention sweep skipped: RETENTION_PURGE_ENABLED is false');
 return result;
 }

 const db = await initDriver();

 // One pinned session for lock + sweep + unlock.
 return db.withConnection(async (session) => {
 const elected = await tryAcquireSweepLock(session);
 if (!elected) {
 // Not an error and not worth a security event: a replica declining to
 // sweep because a peer is already sweeping is the mechanism working.
 result.role = 'follower';
 logger.info('retention sweep skipped: another replica holds the sweep lock');
 return result;
 }
 result.role = 'leader';

 try {
 await performSweep(session, result, now);
 } finally {
 // Released in `finally` so a thrown sweep does not leave the lock held
 // until the connection is closed. If the process dies before this runs,
 // PostgreSQL drops the session and the lock with it -- the case advisory
 // locks are chosen for.
 await session.query('SELECT pg_advisory_unlock($1, $2)', [RETENTION_LOCK_CLASS, RETENTION_LOCK_OBJECT])
 .catch((err: unknown) => logger.error({ err }, 'could not release the retention sweep lock'));
 }
 return result;
 });
}

/**
 * Attempts to become the sweeping replica. Returns false when a peer holds the
 * lock, which is the normal case for every replica that loses the race.
 */
async function tryAcquireSweepLock(session: DbClient): Promise<boolean> {
 try {
 const r = await session.query<{ locked: boolean }>(
 'SELECT pg_try_advisory_lock($1, $2) AS locked',
 [RETENTION_LOCK_CLASS, RETENTION_LOCK_OBJECT],
 );
 return r.rows[0]?.locked === true;
 } catch (err) {
 // Fail *open* here, deliberately, and it is worth being explicit that this
 // is a considered choice rather than an oversight. Leader election is an
 // efficiency and load property; retention is a compliance obligation
 // (GDPR Art. 5(1)(e), storage limitation). If the lock cannot be taken,
 // every replica sweeping is redundant work, whereas no replica sweeping is
 // data accumulating past its lawful retention window. Redundancy is the
 // cheaper failure, so a lock error logs and proceeds.
 logger.error({ err }, 'advisory lock unavailable; sweeping without leader election');
 return true;
 }
}

/** The work itself, assuming this process already holds the sweep lock. */
async function performSweep(
 db: DbClient,
 result: PurgeResult,
 now: Date,
): Promise<void> {
 const day = 86_400_000;
 const ago = (d: number): string => new Date(now.getTime() - d * day).toISOString();
 // One pass deletes at most this many rows per table. Sized so a sweep stays
 // well under a second even on a large table.
 const batch = 5_000;

 const jobs: { table: string; where: string; cutoff: string }[] = [
 // Sessions: expired and long-idle rows are dead weight and a liability if
 // left behind (a valid-looking session row is an attack surface).
 { table: 'sessions', where: 'absolute_expires_at < $2 OR (revoked_at IS NOT NULL AND last_seen_at < $2)', cutoff: ago(1) },
 // One-time tokens: consumed or expired rows authenticate nothing.
 { table: 'password_resets', where: 'expires_at < $2 OR used_at IS NOT NULL', cutoff: ago(0) },
 { table: 'email_verifications', where: 'expires_at < $2 OR used_at IS NOT NULL', cutoff: ago(0) },
 { table: 'invitations', where: 'expires_at < $2 OR (accepted_at IS NOT NULL AND accepted_at < $2)', cutoff: ago(7) },
 // MFA challenges: short-lived by design; anything past expiry is noise.
 { table: 'mfa_challenges', where: 'expires_at < $2', cutoff: ago(0) },
 // Notifications.
 { table: 'notifications', where: 'created_at < $2 OR read_at IS NOT NULL', cutoff: ago(env.retention.notificationDays) },
 // Export artefacts: the generated file is the product, and it is the most
 // likely thing to contain bulk personal data.
 { table: 'export_jobs', where: 'created_at < $2', cutoff: ago(env.retention.exportDays) },
 { table: 'import_jobs', where: 'created_at < $2', cutoff: ago(env.retention.exportDays) },
 // Security events (distinct from the audit trail, and shorter-lived).
 { table: 'security_events', where: 'created_at < $2', cutoff: ago(env.retention.auditDays) },
 ];

 for (const job of jobs) {
 try {
 const deleted = await purgeBatched(db, job.table, job.where, job.cutoff, batch);
 if (deleted > 0) {
 result.rows.push({ table: job.table, deleted });
 result.totalDeleted += deleted;
 }
 } catch (err) {
 // A missing table (an older schema) or a lock timeout must not abort the
 // whole sweep: the remaining tables still need purging.
 const message = err instanceof Error ? err.message.split('\\n')[0]! : String(err);
 result.errors.push(`${job.table}: ${message}`);
 logger.error({ err, table: job.table }, 'retention purge failed for this table');
 }
 }

 // `audit_logs` is deliberately absent. The append-only trigger in 0001 rejects
 // DELETE outright, and truncating an audit trail is a deliberate, authorised
 // decision -- never a side effect of a timer. Documented in
 // docs/OPERATIONS.md §Retention.

 if (result.totalDeleted > 0 || result.errors.length > 0) {
 securityLog('retention.swept', {
 deleted: result.totalDeleted,
 tables: result.rows.length,
 errors: result.errors.length,
 });
 logger.info({ ...result }, 'retention sweep complete');
 }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Starts the periodic sweep. Idempotent.
 *
 * The first run is delayed by a full interval rather than firing immediately at
 * boot: a deploy must not trigger a bulk delete on top of its own startup, and
 * an immediate sweep would compete with migrations for the same connections.
 */
export function startRetentionScheduler(intervalMs = 6 * 60 * 60 * 1000): void {
 if (timer) return;
 if (!env.retention.purgeEnabled) {
 logger.warn('retention scheduler not started: RETENTION_PURGE_ENABLED is false');
 return;
 }
 timer = setInterval(() => {
 void runRetentionSweep().catch((err) => {
 // The interval must outlive any single failure.
 logger.error({ err }, 'retention sweep threw');
 });
 }, intervalMs);
 // Do not hold the event loop open on shutdown.
 timer.unref?.();
 logger.info({ intervalMs, auditDays: env.retention.auditDays }, 'retention scheduler started');
}

export function stopRetentionScheduler(): void {
 if (timer) {
 clearInterval(timer);
 timer = null;
 logger.info('retention scheduler stopped');
 }
}

export const __testing = { purgeBatched };
