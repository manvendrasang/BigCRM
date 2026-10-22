/**
 * Due-reminder tests.
 *
 * The properties that matter:
 * 1. Every calendar item earns exactly two notices, one hour out and one
 *    fifteen minutes out -- armed when the item is written, re-armed when it
 *    moves, retired when it is finished or deleted.
 * 2. Delivery is exactly-once per notice. The ledger is the guard, so a second
 *    sweep, a retried job and a duplicated job all find it spent.
 * 3. The audience is everybody. These are due reminders rather than
 *    permissions: every role in the workspace gets them, creator included --
 *    which is the opposite of the create-time fan-out and deliberately so.
 * 4. A notice about an item that is gone, finished or abandoned delivers
 *    nothing. The ledger is a promise to look, not a promise to shout.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { getDb } from '../../db/driver.ts';
import { newId } from '../../lib/ids.ts';
import type { ActorRef } from '../../services/records.ts';
import {
 createRecord, updateRecord, softDeleteRecord, restoreRecord,
} from '../../services/records.ts';
import { createMember } from '../../services/org.ts';
import { registerUser } from '../../services/auth.ts';
import { scheduleMeeting } from '../../services/calendar.ts';
import {
 REMINDER_JOB_TYPE, REMINDER_LEAD_MINUTES, deliverDueReminder,
 eventRemindersFor, sweepDueReminders,
} from '../../services/reminders.ts';
import { clearHandlers, registerHandler, runWorkerOnce } from '../../services/queue.ts';

const trim = (e: unknown): string => {
 const msg = e instanceof Error ? e.message : String(e);
 return msg.split('\n')[0]!.slice(0, 120);
};
let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l} -> ${trim(x)}`); }
};
const C = { ip: '10.0.0.9', userAgent: 'reminders-test/1.0', requestId: 'req-reminders' };
const db = await getDb();

const mkOrg = async (name: string, email: string): Promise<ActorRef> => {
 const r = await registerUser({
  name, email, password: 'Reminders-Test-Pass!42',
  organizationName: `${name} Ltd`, client: C,
 });
 return { userId: r.user.id, organizationId: r.organizationId, role: 'owner', email: r.user.email };
};

/** A due time `hours` from now -- always in the future, never a fixed date. */
const inHours = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

const dueCount = async (organizationId: string, userId: string, type: string): Promise<number> => {
 const r = await db.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM notifications
  WHERE organization_id = $1 AND user_id = $2 AND type = $3`,
  [organizationId, userId, type],
 );
 return r.rows[0]!.n;
};

const DUE_TYPES = ['calendar_due_1h', 'calendar_due_15m'];

const dueTotal = async (organizationId: string): Promise<number> => {
 const r = await db.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM notifications
  WHERE organization_id = $1 AND type = ANY($2::text[])`,
  [organizationId, DUE_TYPES],
 );
 return r.rows[0]!.n;
};

/** Pulls the ledger's fire times into the past, the way the clock would. */
const makeDue = async (organizationId: string): Promise<void> => {
 await db.query(
  `UPDATE event_reminders SET fire_at = now() - interval '1 minute', enqueued_at = NULL
  WHERE organization_id = $1 AND sent_at IS NULL`,
  [organizationId],
 );
};

/** Runs the queue until it has nothing left to claim. */
const drainQueue = async (max = 40): Promise<void> => {
 for (let i = 0; i < max; i += 1) {
  const job = await runWorkerOnce('reminders-test');
  if (!job) return;
 }
};

const jobFor = (organizationId: string, reminderId: string, kind: string, entityId: string) => ({
 id: newId(),
 organizationId,
 type: REMINDER_JOB_TYPE,
 payload: { reminderId, kind, entityId, leadMinutes: 60 },
 status: 'claimed',
 attempts: 1,
 maxAttempts: 5,
 runAt: new Date().toISOString(),
});

console.log('\n=== every calendar item earns two advance notices ===');
{
 const org = await mkOrg('RemArm', 'rem-arm@corp.io');
 const contact = await createRecord(org, 'contacts', {
  first_name: 'Arm', last_name: 'Target', email: 'arm.target@corp.io',
 });

 const meeting = await scheduleMeeting(org, {
  entityType: 'contact', entityId: String(contact.record.id),
  occurredAt: inHours(2), subject: 'Arm me',
 });
 const meetingRows = await eventRemindersFor(org.organizationId, 'meeting', meeting.id);
 T('a meeting earns two notices', meetingRows.length === 2, meetingRows.length);
 T('the lead times are an hour and a quarter-hour',
  meetingRows.map((r) => r.leadMinutes).join(',') === REMINDER_LEAD_MINUTES.join(','),
  meetingRows.map((r) => r.leadMinutes));
 const startedAt = new Date(meeting.occurredAt).getTime();
 T('the first notice falls an hour before the meeting',
  Math.abs(new Date(meetingRows[0]!.fireAt).getTime() - (startedAt - 3_600_000)) < 2_000,
  meetingRows[0]!.fireAt);
 T('the second notice falls fifteen minutes before the meeting',
  Math.abs(new Date(meetingRows[1]!.fireAt).getTime() - (startedAt - 900_000)) < 2_000,
  meetingRows[1]!.fireAt);

 const dated = await createRecord(org, 'tasks', { title: 'Dated task', due_date: inHours(3) });
 const datedId = String(dated.record.id);
 T('a dated task earns two notices',
  (await eventRemindersFor(org.organizationId, 'task', datedId)).length === 2);

 const undated = await createRecord(org, 'tasks', { title: 'Undated task' });
 T('an undated task earns none',
  (await eventRemindersFor(org.organizationId, 'task', String(undated.record.id))).length === 0);

 console.log('\n=== the notices follow the item: moved, retired, brought back ===');
 {
  const before = await eventRemindersFor(org.organizationId, 'task', datedId);
  await updateRecord(org, 'tasks', datedId, { due_date: inHours(6) });
  const moved = await eventRemindersFor(org.organizationId, 'task', datedId);
  T('moving the date moves the notices',
   new Date(moved[0]!.fireAt).getTime() - new Date(before[0]!.fireAt).getTime() > 2 * 3_600_000,
   `${before[0]!.fireAt} -> ${moved[0]!.fireAt}`);
  T('both notices stay at their own lead times',
   moved.map((r) => r.leadMinutes).join(',') === REMINDER_LEAD_MINUTES.join(','),
   moved.map((r) => r.leadMinutes));

  await updateRecord(org, 'tasks', datedId, { status: 'completed' });
  T('completing a task retires its notices',
   (await eventRemindersFor(org.organizationId, 'task', datedId)).length === 0);

  await updateRecord(org, 'tasks', datedId, { status: 'in_progress' });
  T('reopening it brings the notices back',
   (await eventRemindersFor(org.organizationId, 'task', datedId)).length === 2);

  // Moving it again re-arms at the new time rather than piling up a second set.
  const reArmed = await eventRemindersFor(org.organizationId, 'task', datedId);
  await updateRecord(org, 'tasks', datedId, { due_date: inHours(8) });
  const again = await eventRemindersFor(org.organizationId, 'task', datedId);
  T('a second move re-arms in place, never doubling up',
   again.length === 2 && again.every((r) => r.sentAt === null)
   && !again.some((r) => reArmed.some((o) => o.id === r.id && o.fireAt === r.fireAt)),
   again.map((r) => `${r.leadMinutes}:${r.fireAt}`));
 }
}

console.log('\n=== a due notice reaches every role, the creator included ===');
{
 const org = await mkOrg('RemFire', 'rem-fire@corp.io');
 const roles = ['admin', 'manager', 'sales', 'viewer'] as const;
 const byRole = new Map<string, string>([['owner', org.userId]]);
 for (const role of roles) {
  const m = await createMember(org, {
   email: `rem-fire-${role}@corp.io`, role, name: `Rem ${role}`,
  });
  byRole.set(role, m.user.id);
 }

 const task = await createRecord(org, 'tasks', { title: 'Fires soon', due_date: inHours(2) });
 const taskId = String(task.record.id);
 const ledger = await eventRemindersFor(org.organizationId, 'task', taskId);
 T('the task is armed', ledger.length === 2, ledger.length);

 await makeDue(org.organizationId);
 // Other suites leave queued rows behind; clear them rather than claiming and
 // mutating history that belongs to somebody else's test.
 await db.query(`DELETE FROM job_queue WHERE status = 'queued' AND type <> $1`, [REMINDER_JOB_TYPE]);
 T('the sweep hands due notices to the queue', (await sweepDueReminders()) >= 2);

 clearHandlers();
 registerHandler(REMINDER_JOB_TYPE, deliverDueReminder);
 await drainQueue();
 clearHandlers();

 for (const [role, userId] of byRole) {
  T(`the ${role} is told an hour out`,
   await dueCount(org.organizationId, userId, 'calendar_due_1h') === 1,
   await dueCount(org.organizationId, userId, 'calendar_due_1h'));
  T(`the ${role} is told fifteen minutes out`,
   await dueCount(org.organizationId, userId, 'calendar_due_15m') === 1,
   await dueCount(org.organizationId, userId, 'calendar_due_15m'));
 }

 const note = await db.query<{
  title: string; body: string; link: string | null;
  entity_type: string | null; entity_id: string | null;
 }>(
  `SELECT title, body, link, entity_type, entity_id FROM notifications
  WHERE organization_id = $1 AND type = 'calendar_due_1h' LIMIT 1`,
  [org.organizationId],
 );
 T('the notice names the task', note.rows[0]?.title.includes('Fires soon') === true, note.rows[0]?.title);
 T('the notice reads like a countdown',
  note.rows[0]?.title.startsWith('Due in 1 hour:') === true, note.rows[0]?.title);
 T('the notice points back at the task so the shared window opens',
  note.rows[0]?.entity_type === 'task' && note.rows[0]?.entity_id === taskId, note.rows[0]);
 T('the notice links to the calendar', note.rows[0]?.link === '/calendar', note.rows[0]?.link);
 T('every ledger row is marked spent',
  (await eventRemindersFor(org.organizationId, 'task', taskId)).every((r) => r.sentAt !== null));

 const spent = await dueTotal(org.organizationId);
 await drainQueue();
 T('running the worker again sends nothing more',
  await dueTotal(org.organizationId) === spent, spent);
 T('a second sweep finds nothing to hand over', (await sweepDueReminders()) === 0);

 const duplicate = jobFor(
  org.organizationId,
  (await eventRemindersFor(org.organizationId, 'task', taskId))[0]!.id,
  'task', taskId,
 );
 await deliverDueReminder(duplicate);
 T('a duplicated job is a no-op, not a second copy',
  await dueTotal(org.organizationId) === spent, spent);
}

console.log('\n=== a notice about nothing says nothing ===');
{
 const org = await mkOrg('RemGhost', 'rem-ghost@corp.io');

 const vanishing = await createRecord(org, 'tasks', { title: 'Vanishes', due_date: inHours(2) });
 const goneId = String(vanishing.record.id);
 await softDeleteRecord(org, 'tasks', goneId);
 // The delete retires the ledger rows; put one back by hand to prove the
 // handler checks the task rather than trusting the row that points at it.
 const staleGone = newId();
 await db.query(
  `INSERT INTO event_reminders
  (id, organization_id, entity_kind, entity_id, lead_minutes, due_at, fire_at, enqueued_at)
  VALUES ($1,$2,'task',$3,60,$4,now(),now())`,
  [staleGone, org.organizationId, goneId, inHours(2)],
 );

 const closing = await createRecord(org, 'tasks', { title: 'Already finished', due_date: inHours(3) });
 const closingId = String(closing.record.id);
 await updateRecord(org, 'tasks', closingId, { status: 'completed' });
 const staleDone = newId();
 await db.query(
  `INSERT INTO event_reminders
  (id, organization_id, entity_kind, entity_id, lead_minutes, due_at, fire_at, enqueued_at)
  VALUES ($1,$2,'task',$3,60,$4,now(),now())`,
  [staleDone, org.organizationId, closingId, inHours(3)],
 );

 clearHandlers();
 registerHandler(REMINDER_JOB_TYPE, deliverDueReminder);
 await deliverDueReminder(jobFor(org.organizationId, staleGone, 'task', goneId));
 await deliverDueReminder(jobFor(org.organizationId, staleDone, 'task', closingId));
 clearHandlers();

 T('nothing is said about a deleted task', await dueTotal(org.organizationId) === 0,
  await dueTotal(org.organizationId));
 T('nothing is said about a finished task', await dueTotal(org.organizationId) === 0);

 // And an unknown reminder id is simply not a thing to send.
 await deliverDueReminder(jobFor(org.organizationId, newId(), 'task', newId()));
 T('an unknown reminder id sends nothing', await dueTotal(org.organizationId) === 0);

 const restorable = await createRecord(org, 'tasks', { title: 'Comes back', due_date: inHours(4) });
 const backId = String(restorable.record.id);
 await softDeleteRecord(org, 'tasks', backId);
 T('deleting retires the notices', (await eventRemindersFor(org.organizationId, 'task', backId)).length === 0);
 await restoreRecord(org, 'tasks', backId);
 T('restoring a dated task brings them back',
  (await eventRemindersFor(org.organizationId, 'task', backId)).length === 2);
}

console.log('\n=== the sweep is safe to run from more than one place ===');
{
 const org = await mkOrg('RemRace', 'rem-race@corp.io');
 await createRecord(org, 'tasks', { title: 'Contended', due_date: inHours(2) });
 await makeDue(org.organizationId);
 await db.query(`DELETE FROM job_queue WHERE status = 'queued' AND type <> $1`, [REMINDER_JOB_TYPE]);

 const [a, b] = await Promise.all([sweepDueReminders(), sweepDueReminders()]);
 const r = await db.query<{ type: string }>(
  `SELECT type FROM job_queue WHERE organization_id = $1 AND type = $2`,
  [org.organizationId, REMINDER_JOB_TYPE],
 );
 T('two sweeps racing hand out between them, not twice',
  a + b === r.rows.length && r.rows.length === 2, `a=${a} b=${b} queued=${r.rows.length}`);
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
