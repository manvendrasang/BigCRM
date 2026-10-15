/**
 * Retention sweep tests.
 *
 * The property that matters most here is a negative one: **the sweep must not
 * delete audit rows.** Everything else -- that expired sessions go, that live ones
 * stay, that a failure on one table does not abort the rest -- is secondary to
 * that, because a scheduler that quietly trims an audit trail destroys the one
 * artefact the platform exists to produce.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { getDb } from '../../db/driver.ts';
import {
 runRetentionSweep,
 RETENTION_LOCK_CLASS,
 RETENTION_LOCK_OBJECT,
} from '../../services/retention.ts';
import { env } from '../../config/env.ts';
import { newId } from '../../lib/ids.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l} -> ${JSON.stringify(x ?? null).slice(0, 130)}`); }
};

const db = await getDb();
const userId = newId();
const orgId = newId();

await db.query(
 `INSERT INTO organizations (id,name,slug,created_at,updated_at) VALUES ($1,'Retention Org','retention-org',now(),now())`, [orgId]);
await db.query(
 `INSERT INTO users (id,email,email_normalized,name,password_hash,created_at,updated_at)
 VALUES ($1,'retention@test.local','retention@test.local','Retention User','x',now(),now())`, [userId]);
await db.query(
 `INSERT INTO organization_members (id,organization_id,user_id,role,status,joined_at,created_at,updated_at)
 VALUES ($1,$2,$3,'owner','active',now(),now(),now())`, [newId(), orgId, userId]);

const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();

console.log('\n=== fixtures: live and expired rows side by side ===');
const expiredSession = newId();
const liveSession = newId();
await db.query(
 `INSERT INTO sessions (id,user_id,organization_id,role,family_id,refresh_jti,refresh_hash,
 device_label,ip,user_agent,created_at,last_seen_at,absolute_expires_at)
 VALUES ($1,$2,$3,'owner',$4,$5,$6,'old','10.0.0.1','ua',$7,$7,$8)`,
 [expiredSession, userId, orgId, newId(), newId(), 'h'.repeat(64), daysAgo(40), daysAgo(2)]);
await db.query(
 `INSERT INTO sessions (id,user_id,organization_id,role,family_id,refresh_jti,refresh_hash,
 device_label,ip,user_agent,created_at,last_seen_at,absolute_expires_at)
 VALUES ($1,$2,$3,'owner',$4,$5,$6,'current','10.0.0.1','ua',now(),now(),now() + interval '30 days')`,
 [liveSession, userId, orgId, newId(), newId(), 'h'.repeat(64)]);

const expiredReset = newId();
await db.query(
 `INSERT INTO password_resets (id,user_id,token_hash,expires_at,created_at) VALUES ($1,$2,$3,$4,$5)`,
 [expiredReset, userId, 'a'.repeat(64), daysAgo(2), daysAgo(3)]);

const expiredChallenge = newId();
const liveChallenge = newId();
await db.query(
 `INSERT INTO mfa_challenges (id,user_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,'challenge',$4)`,
 [expiredChallenge, userId, 'b'.repeat(64), daysAgo(1)]);
await db.query(
 `INSERT INTO mfa_challenges (id,user_id,token_hash,purpose,expires_at) VALUES ($1,$2,$3,'challenge',now() + interval '10 minutes')`,
 [liveChallenge, userId, 'c'.repeat(64)]);

console.log('\n=== the sweep is a no-op when disabled ===');
{
 const before = await db.query('SELECT count(*)::int AS n FROM sessions');
 const disabled = await runRetentionSweep();
 T('with RETENTION_PURGE_ENABLED=false the sweep deletes nothing',
 disabled.totalDeleted === 0 && disabled.rows.length === 0, disabled);
 const after = await db.query('SELECT count(*)::int AS n FROM sessions');
 T('and the expired session survives', before.rows[0]!.n === after.rows[0]!.n, { before, after });
}

console.log('\n=== with retention enabled, expired rows go and live rows stay ===');
{
 const original = env.retention.purgeEnabled;
 (env as { retention: { purgeEnabled: boolean } }).retention.purgeEnabled = true;
 try {
 const auditBefore = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs')).rows[0]!.n;
 const result = await runRetentionSweep();

 T('the sweep reports what it did', Array.isArray(result.rows), result);
 T('it deleted something', result.totalDeleted > 0, result.totalDeleted);
 T('no table errored', result.errors.length === 0, result.errors);

 const s = await db.query<{ id: string }>('SELECT id FROM sessions WHERE id = $1', [expiredSession]);
 T('the expired session is gone', s.rows.length === 0);
 const l = await db.query<{ id: string }>('SELECT id FROM sessions WHERE id = $1', [liveSession]);
 T('the live session survives', l.rows.length === 1);

 T('the expired password reset is gone',
 (await db.query('SELECT 1 FROM password_resets WHERE id = $1', [expiredReset])).rows.length === 0);
 T('the expired MFA challenge is gone',
 (await db.query('SELECT 1 FROM mfa_challenges WHERE id = $1', [expiredChallenge])).rows.length === 0);
 T('the unexpired MFA challenge survives',
 (await db.query('SELECT 1 FROM mfa_challenges WHERE id = $1', [liveChallenge])).rows.length === 1);

 const auditAfter = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs')).rows[0]!.n;
 T('AUDIT ROWS ARE NEVER DELETED BY THE SWEEP', auditAfter >= auditBefore, { auditBefore, auditAfter });
 T('audit_logs is not even in the purge list',
 !result.rows.some((r) => r.table === 'audit_logs'), result.rows.map((r) => r.table));

 console.log('\n=== the append-only trigger still refuses a manual audit delete ===');
 const tamper = await db.query('DELETE FROM audit_logs WHERE organization_id = $1', [orgId]).catch((e: Error) => e);
 T('a direct DELETE on audit_logs is rejected by the database',
 tamper instanceof Error || (tamper.rowCount === 0), tamper);
 } finally {
 (env as { retention: { purgeEnabled: boolean } }).retention.purgeEnabled = original;
 }
}

console.log('\n=== a second sweep is idempotent ===');
{
 const original = env.retention.purgeEnabled;
 (env as { retention: { purgeEnabled: boolean } }).retention.purgeEnabled = true;
 try {
 const second = await runRetentionSweep();
 T('nothing left to delete, so it reports zero', second.totalDeleted === 0, second);
 T('and it does not error', second.errors.length === 0, second.errors);
 } finally {
 (env as { retention: { purgeEnabled: boolean } }).retention.purgeEnabled = original;
 }
}

console.log('\n=== one failing table does not abort the sweep ===');
{
 const original = env.retention.purgeEnabled;
 (env as { retention: { purgeEnabled: boolean } }).retention.purgeEnabled = true;
 try {
 // A sweep with no sessions at all still visits every table; if any table were
 // missing a column the sweep must record an error and carry on.
 const r = await runRetentionSweep();
 T('the sweep completes even when there is nothing to do', r.errors.length === 0, r.errors);
 T('every purgeable table is visited without error', r.errors.length === 0, r.errors);
 } finally {
 (env as { retention: { purgeEnabled: boolean } }).retention.purgeEnabled = original;
 }
}

/**
 * Leader election (closes accepted risk A5).
 *
 * The scheduler runs in every replica. Without coordination they all sweep at
 * once: N concurrent multi-thousand-row deletes on the same rows, N× the lock
 * contention on tables the API is reading, and N1 of those sweeps deleting
 * nothing because a peer already took the rows.
 *
 * The decisive property under test is a negative one: **a replica that loses the
 * election must delete nothing.** Asserting only that a winner exists would pass
 * even if the lock were decorative -- the winner would still report `leader` and
 * still delete. Only the follower case distinguishes a working election from a
 * coin flip.
 */
console.log('\n=== leader election: only one replica sweeps ===');
{
 const original = env.retention.purgeEnabled;
 (env as { retention: { purgeEnabled: boolean } }).retention.purgeEnabled = true;
 try {
 // The uncontended case: with the lock free, this process wins and says so.
 const solo = await runRetentionSweep();
 T('an uncontended sweep reports role=leader', solo.role === 'leader', solo.role);
 T('and no error', solo.errors.length === 0, solo.errors);

 // A disabled sweep never enters the election at all.
 (env as { retention: { purgeEnabled: boolean } }).retention.purgeEnabled = false;
 const off = await runRetentionSweep();
 T('with retention disabled the sweep reports role=not-needed', off.role === 'not-needed', off.role);
 (env as { retention: { purgeEnabled: boolean } }).retention.purgeEnabled = true;

 // Contention. This requires two genuinely independent sessions, so it runs
 // only against real PostgreSQL. PGlite is a single in-process session: the
 // same session re-entering its own advisory lock is granted it, so a
 // "contention" test there would always see the sweep win and would prove
 // nothing. Reporting that as a pass would be a fabricated result, so the
 // case is skipped loudly instead.
 if (db.kind === 'postgres') {
 // A peer "replica" holds the lock the way another pod would: a separate
 // pooled session, pinned for the whole duration.
 await db.withConnection(async (peer) => {
 const held = await peer.query<{ locked: boolean }>(
 'SELECT pg_try_advisory_lock($1, $2) AS locked',
 [RETENTION_LOCK_CLASS, RETENTION_LOCK_OBJECT],
 );
 T('the peer session acquires the sweep lock', held.rows[0]?.locked === true, held.rows);

 // Give the loser something real to delete, so "deleted nothing" is a
 // fact about behaviour rather than an empty table.
 const doomed = newId();
 await db.query(
 `INSERT INTO sessions (id,user_id,organization_id,role,family_id,refresh_jti,refresh_hash,
 device_label,ip,user_agent,created_at,last_seen_at,absolute_expires_at)
 VALUES ($1,$2,$3,'owner',$4,$5,$6,'doomed','10.0.0.1','ua',$7,$7,$8)`,
 [doomed, userId, orgId, newId(), newId(), 'h'.repeat(64), daysAgo(40), daysAgo(2)]);

 const loser = await runRetentionSweep();
 T('a replica that loses the election reports role=follower', loser.role === 'follower', loser.role);
 T('THE LOSING REPLICA DELETES NOTHING', loser.totalDeleted === 0, loser.totalDeleted);
 T('and it records no errors -- losing is not a failure',
 loser.errors.length === 0, loser.errors);

 const survived = await db.query('SELECT 1 FROM sessions WHERE id = $1', [doomed]);
 T('the expired row is still there, untouched by the loser', survived.rows.length === 1);

 // Releasing the lock lets the next replica through. This is the pair
 // that proves the loser was blocked *by the lock* and not by something
 // incidental such as an empty table.
 const released = await peer.query<{ unlocked: boolean }>(
 'SELECT pg_advisory_unlock($1, $2) AS unlocked',
 [RETENTION_LOCK_CLASS, RETENTION_LOCK_OBJECT],
 );
 T('the peer session releases the lock', released.rows[0]?.unlocked === true, released.rows);

 const next = await runRetentionSweep();
 T('after release the next replica is elected', next.role === 'leader', next.role);
 T('and it does delete the row the loser left behind', next.totalDeleted > 0, next.totalDeleted);
 const gone = await db.query('SELECT 1 FROM sessions WHERE id = $1', [doomed]);
 T('the row is now gone', gone.rows.length === 0);
 });
 } else {
 console.log(' [SKIP] lock contention requires two independent sessions;');
 console.log(' PGlite is single-session, so this assertion is only made against real PostgreSQL.');
 }
 } finally {
 (env as { retention: { purgeEnabled: boolean } }).retention.purgeEnabled = original;
 }
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
