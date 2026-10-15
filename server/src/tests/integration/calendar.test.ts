/**
 * Calendar tests.
 *
 * The properties that matter:
 * 1. The agenda is tenant-scoped on both sources (meetings AND tasks).
 * 2. Range validation is strict — bad dates, reversed bounds, over-wide ranges.
 * 3. Scheduling attaches only to a row of the caller's tenant; anything else
 *    404s without confirming existence.
 * 4. One write powers two views: a scheduled meeting appears in the record
 *    timeline as well as the agenda.
 * 5. Responses are camelCase (the BIG-33 class of defect).
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { getDb } from '../../db/driver.ts';
import { newId } from '../../lib/ids.ts';
import type { ActorRef } from '../../services/records.ts';
import { createRecord } from '../../services/records.ts';
import { listActivities } from '../../services/activity.ts';
import { getCalendar, inviteToMeeting, listInvitees, listMyInvites, respondToInvite, scheduleMeeting, __testing } from '../../services/calendar.ts';
import { registerUser } from '../../services/auth.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 130)}`;
  if (c) { pass++; console.log(`  [PASS] ${l}`); } else { fails.push(l); console.log(`  [FAIL] ${l}${detail}`); }
};
type Attempt<T> = { ok: true; v: T } | { ok: false; e: any };
const attempt = async <T>(fn: () => Promise<T>): Promise<Attempt<T>> => {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, e }; }
};
const C = { ip: '10.0.0.21', userAgent: 'calendar-test/1.0', requestId: 'req-cal' };

const mkOrg = async (name: string, email: string) => {
  const r = await registerUser({
    name, email, password: 'Calendar-Test-Pass!42',
    organizationName: `${name} Ltd`, client: C,
  });
  const actor: ActorRef = {
    userId: r.user.id, organizationId: r.organizationId, role: 'owner', email: r.user.email,
  };
  return actor;
};

const acme = await mkOrg('CalAcme', 'cal-acme@corp.io');
const globex = await mkOrg('CalGlobex', 'cal-globex@corp.io');
const db = await getDb();

const contact = await createRecord(acme, 'contacts', {
  first_name: 'Cal', last_name: 'Ender', email: 'cal.ender@corp.io',
});
const contactId = String(contact.record.id);
const otherContact = await createRecord(globex, 'contacts', {
  first_name: 'Foreign', last_name: 'Entity', email: 'foreign@globex.io',
});
const otherContactId = String(otherContact.record.id);

const DAY = '2026-11-15';
const at = (day: string, hour: string): string => `${day}T${hour}:00.000Z`;

console.log('\n=== range validation ===');
{
  T('MAX_RANGE_DAYS is a quarter', __testing.MAX_RANGE_DAYS === 93, __testing.MAX_RANGE_DAYS);

  const badFrom = await attempt(() => getCalendar(acme, 'not-a-date', `${DAY}T00:00:00Z`));
  T('an unparsable start is refused', !badFrom.ok, badFrom);

  const reversed = await attempt(() => getCalendar(acme, `${DAY}T00:00:00Z`, `${DAY}T00:00:00Z`));
  T('an empty range is refused', !reversed.ok, reversed);

  const wide = await attempt(() => getCalendar(
    acme, '2026-01-01T00:00:00Z', '2026-05-01T00:00:00Z'));
  T('a 120-day range is refused', !wide.ok, wide);

  const empty = await getCalendar(acme, `${DAY}T00:00:00Z`, '2026-11-16T00:00:00Z');
  T('an empty month is an empty agenda, not an error',
    empty.meetings.length === 0 && empty.tasks.length === 0, empty);
  T('the agenda echoes its bounds', empty.from.startsWith(DAY) && empty.to.startsWith('2026-11-16'), empty);
}

console.log('\n=== scheduling validation ===');
{
  const base = {
    entityType: 'contact', entityId: contactId,
    occurredAt: at(DAY, '10:00'), subject: 'Discovery call',
  };

  const badEntity = await attempt(() => scheduleMeeting(acme, { ...base, entityType: 'invoice' }));
  T('an unknown entity type is refused', !badEntity.ok, badEntity);

  const badId = await attempt(() => scheduleMeeting(acme, { ...base, entityId: 'not-a-uuid' }));
  T('a malformed id 404s rather than 400s (no oracle)', !badId.ok && /404|NOT_FOUND|not found/i.test(String(badId.e?.message ?? badId.e?.code ?? '')), badId);

  const missing = await attempt(() => scheduleMeeting(acme, { ...base, entityId: newId() }));
  T('an unknown id 404s', !missing.ok, missing);

  const foreign = await attempt(() => scheduleMeeting(acme, { ...base, entityId: otherContactId }));
  T("another tenant's record 404s", !foreign.ok, foreign);

  const noSubject = await attempt(() => scheduleMeeting(acme, { ...base, subject: '   ' }));
  T('an empty subject is refused', !noSubject.ok, noSubject);

  const badWhen = await attempt(() => scheduleMeeting(acme, { ...base, occurredAt: 'whenever' }));
  T('an unparsable time is refused', !badWhen.ok, badWhen);
}

console.log('\n=== one write, two views ===');
{
  const created = await scheduleMeeting(acme, {
    entityType: 'contact', entityId: contactId,
    occurredAt: at(DAY, '10:00'), subject: 'Discovery call', description: 'Bring the deck.',
  });
  T('a meeting is scheduled', typeof created.id === 'string' && created.id.length > 0);
  T('the response is camelCase',
    'occurredAt' in created && 'entityType' in created && !('occurred_at' in created), Object.keys(created));
  T('the subject survives', created.subject === 'Discovery call', created.subject);

  const agenda = await getCalendar(acme, `${DAY}T00:00:00Z`, '2026-11-16T00:00:00Z');
  T('the meeting appears in the agenda',
    agenda.meetings.length === 1 && agenda.meetings[0]!.id === created.id, agenda.meetings.length);
  T('the agenda entry carries the actor name', typeof agenda.meetings[0]!.actorName === 'string', agenda.meetings[0]);

  const outside = await getCalendar(acme, '2026-11-16T00:00:00Z', '2026-11-17T00:00:00Z');
  T('the next day excludes it', outside.meetings.length === 0, outside.meetings.length);

  const timeline = await listActivities(acme, 'contact', contactId);
  T('the same write appears in the record timeline',
    timeline.some((a) => String(a['id']) === created.id), timeline.length);
}

console.log('\n=== tasks surface by due date ===');
{
  const open = await createRecord(acme, 'tasks', { title: 'Prepare proposal', due_date: `${DAY}T12:00:00Z` });
  const openId = String(open.record.id);
  await createRecord(acme, 'tasks', { title: 'Far future', due_date: '2027-01-05T12:00:00Z' });
  const done = await createRecord(acme, 'tasks', { title: 'Old task', due_date: `${DAY}T09:00:00Z` });
  await db.query(`UPDATE tasks SET status = 'completed', completed_at = now() WHERE id = $1`, [done.record.id]);
  const gone = await createRecord(acme, 'tasks', { title: 'Deleted task', due_date: `${DAY}T09:00:00Z` });
  await db.query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [gone.record.id]);
  await createRecord(globex, 'tasks', { title: 'Foreign task', due_date: `${DAY}T09:00:00Z` });

  const agenda = await getCalendar(acme, `${DAY}T00:00:00Z`, '2026-11-16T00:00:00Z');
  const ids = agenda.tasks.map((t) => t.id);
  T('the due task appears', ids.includes(openId), ids);
  T('the far-future task does not (open + completed in range)',
    agenda.tasks.length === 2, agenda.tasks.length);
  T('completed tasks still show (dimmed client-side)',
    (await getCalendar(acme, `${DAY}T00:00:00Z`, '2026-11-16T00:00:00Z'))
      .tasks.some((t) => t.status === 'completed'));
  T('deleted tasks never show', !ids.includes(String(gone.record.id)));
  T("another tenant's tasks never show",
    agenda.tasks.every((t) => t.title !== 'Foreign task'));
  T('task rows are camelCase',
    agenda.tasks.every((t) => 'dueDate' in t && !('due_date' in t)), agenda.tasks[0]);
}

console.log('\n=== meetings never leak across tenants ===');
{
  await scheduleMeeting(globex, {
    entityType: 'contact', entityId: otherContactId,
    occurredAt: at(DAY, '11:00'), subject: 'Foreign meeting',
  });
  const agenda = await getCalendar(acme, `${DAY}T00:00:00Z`, '2026-11-16T00:00:00Z');
  T("another tenant's meeting never shows",
    agenda.meetings.every((m) => m.subject !== 'Foreign meeting'),
    agenda.meetings.map((m) => m.subject));
}

console.log('\n=== invitations ===');
const inviteMeeting = await scheduleMeeting(acme, {
  entityType: 'contact', entityId: contactId,
  occurredAt: at(DAY, '14:00'), subject: 'Planning session',
});
// A second member inside the acme tenant, so cross-user (not just
// cross-tenant) denial has a real target.
const insider = await mkOrg('CalInsider', 'cal-insider@corp.io');
await db.query(
  `INSERT INTO organization_members (id, organization_id, user_id, role, joined_at, created_at, updated_at)
   VALUES ($1,$2,$3,'sales',now(),now(),now())`,
  [newId(), acme.organizationId, insider.userId],
);
const insiderAcme: ActorRef = { ...insider, organizationId: acme.organizationId, role: 'sales' };
{
  const badMeeting = await attempt(() => inviteToMeeting(acme, 'not-a-uuid', [acme.userId]));
  T('a malformed meeting id 404s', !badMeeting.ok, badMeeting);

  const missing = await attempt(() => inviteToMeeting(acme, newId(), [acme.userId]));
  T('an unknown meeting 404s', !missing.ok, missing);

  const foreignMeeting = await (async () => {
    const m = await scheduleMeeting(globex, {
      entityType: 'contact', entityId: otherContactId,
      occurredAt: at(DAY, '15:00'), subject: 'Foreign planning',
    });
    return attempt(() => inviteToMeeting(acme, m.id, [acme.userId]));
  })();
  T("another tenant's meeting 404s", !foreignMeeting.ok, foreignMeeting);

  const noList = await attempt(() => inviteToMeeting(acme, inviteMeeting.id, 'nope'));
  T('a non-array body is refused', !noList.ok, noList);

  const empty = await attempt(() => inviteToMeeting(acme, inviteMeeting.id, []));
  T('an empty invite list is refused', !empty.ok, empty);

  const badUser = await attempt(() => inviteToMeeting(acme, inviteMeeting.id, ['nope']));
  T('a malformed user id 404s the whole request', !badUser.ok, badUser);

  const outsider = await attempt(() => inviteToMeeting(acme, inviteMeeting.id, [globex.userId]));
  T("a non-member 404s the whole request (no partial invites)", !outsider.ok, outsider);
}

console.log('\n=== invite, notify, answer ===');
{
  const result = await inviteToMeeting(acme, inviteMeeting.id, [acme.userId, insider.userId, acme.userId]);
  T('new invitees are invited, input deduped',
    result.invited.length === 2 && result.alreadyInvited.length === 0,
    { invited: result.invited.length, already: result.alreadyInvited.length });
  T('invite rows are camelCase',
    result.invited.every((i) => 'meetingId' in i && !('meeting_id' in i)), result.invited[0]);

  const again = await inviteToMeeting(acme, inviteMeeting.id, [acme.userId]);
  T('re-inviting is a no-op reported as already invited',
    again.invited.length === 0 && again.alreadyInvited.length === 1, again);

  const notes = await db.query<{ type: string; link: string | null }>(
    `SELECT type, link FROM notifications WHERE organization_id = $1 AND type = 'meeting_invite'`,
    [acme.organizationId],
  );
  T('each invitee got a notification', notes.rows.length === 2, notes.rows.length);
  T('the notification links to the calendar',
    notes.rows.every((n) => n.link === '/calendar'), notes.rows);

  // The invitee answers their own invitation.
  const mine = result.invited.find((i) => i.userId === acme.userId)!;
  const answered = await respondToInvite(
    { userId: acme.userId, organizationId: acme.organizationId, role: 'owner', email: acme.email },
    mine.id, 'accepted',
  );
  T('accepting records the answer', answered.status === 'accepted' && answered.respondedAt !== null, answered);

  const declined = await respondToInvite(
    { userId: acme.userId, organizationId: acme.organizationId, role: 'owner', email: acme.email },
    mine.id, 'declined',
  );
  T('changing the answer overwrites it', declined.status === 'declined', declined);

  const badAnswer = await attempt(() => respondToInvite(
    { userId: acme.userId, organizationId: acme.organizationId, role: 'owner', email: acme.email },
    mine.id, 'maybe',
  ));
  T('anything but accepted/declined is refused', !badAnswer.ok, badAnswer);

  const theirs = await attempt(() => respondToInvite(insiderAcme, mine.id, 'accepted'));
  T("answering another user's invite 404s", !theirs.ok, theirs);

  const foreignInvite = await attempt(() => respondToInvite(globex, mine.id, 'accepted'));
  T("answering across tenants 404s", !foreignInvite.ok, foreignInvite);
}

console.log('\n=== invitee directory ===');
{
  const dir = await listInvitees(acme);
  T('the directory lists members', dir.length >= 1, dir.length);
  T('entries carry only id, name and email — no roles, no security fields',
    dir.every((d) => Object.keys(d).sort().join(',') === 'email,id,name'), dir[0]);
  const other = await listInvitees(globex);
  T('tenants see disjoint directories',
    other.every((d) => !dir.some((m) => m.id === d.id)));
}

console.log('\n=== invitation inbox ===');
{
  // insiderAcme was invited to inviteMeeting above and has not answered in a
  // way that sticks (acme's invite was declined; invite a fresh one).
  const fresh = await scheduleMeeting(acme, {
    entityType: 'contact', entityId: contactId,
    occurredAt: at(DAY, '16:00'), subject: 'Follow-up',
  });
  await inviteToMeeting(acme, fresh.id, [insider.userId, acme.userId]);

  const inbox = await listMyInvites(insiderAcme);
  const freshRow = inbox.find((i) => i.meetingId === fresh.id);
  T('the inbox lists only my own invites',
    inbox.every((i) => i.id !== undefined) && freshRow !== undefined, inbox.length);
  T('entries carry the meeting join (subject, time, inviter)',
    freshRow?.subject === 'Follow-up' && typeof freshRow?.inviterName === 'string', freshRow);
  T('entries are camelCase',
    freshRow !== undefined && 'meetingId' in freshRow && !('meeting_id' in freshRow),
    freshRow ? Object.keys(freshRow) : null);

  const filtered = await listMyInvites(insiderAcme, 'accepted');
  T('status filter applies', filtered.every((i) => i.status === 'accepted'), filtered.length);
  await respondToInvite(insiderAcme, freshRow!.id, 'accepted');
  T('answered invites appear under their status',
    (await listMyInvites(insiderAcme, 'accepted')).some((i) => i.id === freshRow!.id));

  const mine = await listMyInvites(acme);
  T("another user's invite rows never appear in mine",
    mine.every((i) => i.id !== freshRow!.id), mine.map((i) => i.id));

  // A deleted meeting takes its invites out of every inbox.
  await db.query('DELETE FROM activities WHERE id = $1', [fresh.id]);
  T('a deleted meeting vanishes from the inbox',
    (await listMyInvites(insiderAcme)).every((i) => i.meetingId !== fresh.id));
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
