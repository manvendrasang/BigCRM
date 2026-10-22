/**
 * The `due_date` contract for tasks.
 *
 * Two behaviours were missing and are easy to regress:
 *
 * 1. Omitted means untouched, but an explicit `null` (or `''`) clears the date.
 *    Before this suite, `prepare()` dropped nulls for `tasks`, so
 *    `PATCH { due_date: null }` reached the service as an empty patch and was
 *    answered with "No updatable fields were supplied." -- a task could be
 *    scheduled but never sent back to the backlog by any client.
 * 2. Clearing a date must retire its two advance notices. The ledger is derived
 *    from the row (`refreshTaskReminders`), so the assertions read the ledger
 *    rather than trusting the response body.
 *
 * The distinction that must stay sharp: absent = unchanged, `null`/`''` = clear,
 * present-but-unparsable = 400. A silent coercion of an invalid date to `null`
 * would delete a reminder because somebody typed "next tuesday".
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { getDb } from '../../db/driver.ts';
import type { ActorRef } from '../../services/records.ts';
import { createRecord, updateRecord } from '../../services/records.ts';
import { registerUser } from '../../services/auth.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 130)}`;
  if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l}${detail}`); }
};
type Attempt<T> = { ok: true; v: T } | { ok: false; e: any };
const attempt = async <T>(fn: () => Promise<T>): Promise<Attempt<T>> => {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, e }; }
};

const C = { ip: '10.0.0.31', userAgent: 'due-date-test/1.0', requestId: 'req-due' };
const org = await registerUser({
  name: 'Priya Raman', email: 'due-date@corp.io', password: 'Wander-Pasture-1842!',
  organizationName: 'DueDate Ltd', client: C,
});
const actor: ActorRef = {
  userId: org.user.id, organizationId: org.organizationId, role: 'owner', email: org.user.email,
};
const db = await getDb();

const rowOf = async (id: string): Promise<Record<string, unknown>> => {
  const r = await db.query<Record<string, unknown>>(
    `SELECT due_date, status, title FROM tasks WHERE organization_id = $1 AND id = $2`,
    [actor.organizationId, id],
  );
  const row = r.rows[0];
  if (!row) throw new Error('task vanished');
  return row;
};

const ledgerOf = async (id: string): Promise<Array<{ lead_minutes: number; sent_at: string | null }>> => {
  const r = await db.query<{ lead_minutes: number; sent_at: string | null }>(
    `SELECT lead_minutes, sent_at FROM event_reminders
    WHERE organization_id = $1 AND entity_kind = 'task' AND entity_id = $2
    ORDER BY lead_minutes`,
    [actor.organizationId, id],
  );
  return r.rows;
};

const LATER = '2027-03-01T10:00:00.000Z';
const EARLIER = '2027-02-01T09:00:00.000Z';

console.log('\n=== creating a dated task arms the ledger ===');
let taskId = '';
{
  const created = await createRecord(actor, 'tasks', { title: 'Dated task', due_date: LATER });
  taskId = String(created.record.id);

  const row = await rowOf(taskId);
  T('the due date is stored as the same instant',
    new Date(String(row['due_date'])).getTime() === new Date(LATER).getTime(), row['due_date']);

  const ledger = await ledgerOf(taskId);
  T('two advance notices are armed', ledger.length === 2, ledger.length);
  T('the hour and the quarter-hour leads are the ones armed',
    JSON.stringify(ledger.map((l) => l.lead_minutes)) === JSON.stringify([15, 60]),
    ledger.map((l) => l.lead_minutes));
  T('nothing has been sent yet', ledger.every((l) => l.sent_at === null));
}

console.log('\n=== an explicit null clears the date and retires the notices ===');
{
  await updateRecord(actor, 'tasks', taskId, { due_date: null });
  const row = await rowOf(taskId);
  T('the due date is now null', row['due_date'] === null, row['due_date']);
  T('the two pending notices are gone', (await ledgerOf(taskId)).length === 0);

  // Clearing an already-undated task must be a no-op, not a 400 and not a
  // notification claiming it was scheduled "for null".
  const again = await attempt(() => updateRecord(actor, 'tasks', taskId, { due_date: null }));
  T('clearing an already-undated task still succeeds', again.ok, again.ok ? '' : again.e);
  T('the row is still undated', (await rowOf(taskId))['due_date'] === null);
}

console.log('\n=== an empty string is the same instruction as null ===');
{
  await updateRecord(actor, 'tasks', taskId, { due_date: EARLIER });
  T('re-dating re-arms the notices', (await ledgerOf(taskId)).length === 2);

  await updateRecord(actor, 'tasks', taskId, { due_date: '' });
  T('an empty string clears the date', (await rowOf(taskId))['due_date'] === null);
  T('an empty string retires the notices', (await ledgerOf(taskId)).length === 0);
}

console.log('\n=== omitted is not the same as cleared ===');
{
  const created = await createRecord(actor, 'tasks', { title: 'Status only', due_date: LATER });
  const id = String(created.record.id);
  await updateRecord(actor, 'tasks', id, { status: 'in_progress' });

  const row = await rowOf(id);
  T('a patch that omits due_date leaves it alone', row['due_date'] !== null, row['due_date']);
  T('the notices survive an unrelated patch', (await ledgerOf(id)).length === 2);

  // The service refuses a patch that changes nothing, and that refusal is what
  // makes "omitted" observable: an empty object never reaches the UPDATE.
  await updateRecord(actor, 'tasks', id, { due_date: null });
  const empty = await attempt(() => updateRecord(actor, 'tasks', id, {}));
  T('a patch with no fields is refused', !empty.ok, empty.ok ? 'accepted' : empty.e);
  T('the refusal did not touch the row', (await rowOf(id))['due_date'] === null);
}

console.log('\n=== an invalid date is rejected, not coerced to null ===');
{
  const created = await createRecord(actor, 'tasks', { title: 'Guarded', due_date: LATER });
  const id = String(created.record.id);

  const bad = await attempt(() => updateRecord(actor, 'tasks', id, { due_date: 'next tuesday' }));
  T('an unparsable date is refused', !bad.ok, bad.ok ? 'accepted' : bad.e);
  T('the stored date is unchanged',
    new Date(String((await rowOf(id))['due_date'])).getTime() === new Date(LATER).getTime());
  T('the notices are unchanged', (await ledgerOf(id)).length === 2);

  const stringNull = await attempt(() => updateRecord(actor, 'tasks', id, { due_date: 'null' }));
  T('the literal string "null" is refused rather than read as null', !stringNull.ok);
}

console.log('\n=== an undated task created with an explicit null is simply undated ===');
{
  const created = await createRecord(actor, 'tasks', { title: 'Born undated', due_date: null });
  const id = String(created.record.id);
  T('create accepts an explicit null', (await rowOf(id))['due_date'] === null);
  T('create arms no notices', (await ledgerOf(id)).length === 0);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('FAILURES:');
  for (const f of fails) console.log(` - ${f}`);
  process.exit(1);
}
