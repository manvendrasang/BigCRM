/**
 * Meeting edit and delete.
 *
 * `scheduleMeeting` was the only lifecycle verb a meeting had: it could be
 * created and then never corrected or cancelled. These assertions cover the
 * parts that are not obvious from the route gate:
 *
 * 1. **Editing re-arms the advance notices only when the start time moves.** A
 *    corrected subject is not a new appointment; re-arming on every edit would
 *    re-send both notices for a typo.
 * 2. **Deleting retires the pending notices but keeps sent ones.** The ledger is
 *    history, not configuration: a notice that already went out is not
 *    un-sent, and a row that never went out is not left pointing at a meeting
 *    that no longer exists.
 * 3. **Deleting cascades the invitations** (`meeting_invites.meeting_id` is
 *    `ON DELETE CASCADE`), so an invitee's inbox cannot point at a ghost.
 * 4. **Both verbs are audited**, and the parent record's timeline records the
 *    cancellation -- a meeting that vanishes silently is a support ticket.
 * 5. **The type is part of the predicate.** An activity that is not a meeting
 *    cannot be edited or deleted through the meeting verbs.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { getDb } from '../../db/driver.ts';
import { newId } from '../../lib/ids.ts';
import type { ActorRef } from '../../services/records.ts';
import { createRecord } from '../../services/records.ts';
import { registerUser } from '../../services/auth.ts';
import { createMember } from '../../services/org.ts';
import {
  deleteMeeting, inviteToMeeting, scheduleMeeting, updateMeeting,
} from '../../services/calendar.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 140)}`;
  if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l}${detail}`); }
};
type Attempt<T> = { ok: true; v: T } | { ok: false; e: any };
const attempt = async <T>(fn: () => Promise<T>): Promise<Attempt<T>> => {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, e }; }
};

const C = { ip: '10.0.0.61', userAgent: 'meeting-lifecycle-test/1.0', requestId: 'req-ml' };

const org = await registerUser({
  name: 'Tomas Feld', email: 'meeting-lifecycle@corp.io', password: 'Quiet-Harbour-2841!',
  organizationName: 'Lifecycle Ltd', client: C,
});
const owner: ActorRef = {
  userId: org.user.id, organizationId: org.organizationId, role: 'owner', email: org.user.email,
};
const member = await createMember(owner, {
  email: 'meeting-invitee@corp.io', role: 'sales', name: 'Meeting Invitee',
});

const contact = await createRecord(owner, 'contacts', {
  first_name: 'Meet', last_name: 'Ing', email: 'meet.ing@corp.io',
});
const otherContact = await createRecord(owner, 'contacts', {
  first_name: 'Other', last_name: 'Anchor', email: 'other.anchor@corp.io',
});
const contactId = String(contact.record.id);
const otherContactId = String(otherContact.record.id);

const db = await getDb();

type LedgerRow = {
  id: string; lead_minutes: number; due_at: string; fire_at: string;
  enqueued_at: string | null; sent_at: string | null;
};
const ledger = async (meetingId: string): Promise<LedgerRow[]> => {
  const r = await db.query<LedgerRow>(
    `SELECT id, lead_minutes, due_at, fire_at, enqueued_at, sent_at
    FROM event_reminders
    WHERE organization_id = $1 AND entity_kind = 'meeting' AND entity_id = $2
    ORDER BY lead_minutes`,
    [owner.organizationId, meetingId],
  );
  return r.rows;
};

const meetingRow = async (meetingId: string): Promise<Record<string, unknown> | null> => {
  const r = await db.query<Record<string, unknown>>(
    `SELECT id, subject, description, entity_type, entity_id, occurred_at
    FROM activities WHERE organization_id = $1 AND id = $2 AND type = 'meeting'`,
    [owner.organizationId, meetingId],
  );
  return r.rows[0] ?? null;
};

const auditRows = async (meetingId: string): Promise<Array<Record<string, unknown>>> => {
  const r = await db.query<Record<string, unknown>>(
    `SELECT action, entity_type, entity_id, before_json, after_json, metadata
    FROM audit_logs WHERE organization_id = $1 AND entity_id = $2 ORDER BY created_at`,
    [owner.organizationId, meetingId],
  );
  return r.rows;
};

const T1 = '2027-06-01T10:00:00.000Z';
const T2 = '2027-06-02T14:30:00.000Z';

console.log('\n=== creating the fixture ===');
const meeting = await scheduleMeeting(owner, {
  entityType: 'contact', entityId: contactId, occurredAt: T1,
  subject: 'Quarterly review', description: 'Bring numbers.',
});
{
  const rows = await ledger(meeting.id);
  T('a new meeting arms two notices', rows.length === 2, rows.length);
  T('the notices point at the meeting', rows.every((r) => r.sent_at === null));
}

console.log('\n=== a subject edit does not touch the ledger ===');
{
  const before = await ledger(meeting.id);
  const updated = await updateMeeting(owner, meeting.id, {
    subject: 'Quarterly review (renamed)', description: null,
  });
  const after = await ledger(meeting.id);

  T('the subject is updated', updated.subject === 'Quarterly review (renamed)', updated.subject);
  T('an explicit null clears the description', updated.description === null, updated.description);
  T('no notice was re-armed or rewritten',
    JSON.stringify(before) === JSON.stringify(after), { before, after });
  T('the response is camelCase',
    'occurredAt' in updated && !('occurred_at' in updated), Object.keys(updated));

  const audits = await auditRows(meeting.id);
  const edit = audits.find((a) => a['action'] === 'activities.update');
  T('the edit is audited', edit !== undefined, audits.map((a) => a['action']));
  // The value diff is minimised by `AUDIT_ALLOW_FIELDS` (which does not carry
  // titles or timestamps), so the fields changed are recorded by name instead.
  T('the audit names the changed fields',
    JSON.stringify(edit?.['metadata'] ?? {}).includes('subject')
      && JSON.stringify(edit?.['metadata'] ?? {}).includes('description'),
    edit?.['metadata']);
}

console.log('\n=== moving the meeting re-arms both notices at the new time ===');
{
  const updated = await updateMeeting(owner, meeting.id, { occurredAt: T2 });
  const rows = await ledger(meeting.id);

  T('the start time moves', new Date(updated.occurredAt).getTime() === new Date(T2).getTime(),
    updated.occurredAt);
  T('both notices survive the move', rows.length === 2, rows.length);
  T('every notice points at the new start time',
    rows.every((r) => new Date(r.due_at).getTime() === new Date(T2).getTime()),
    rows.map((r) => r.due_at));
  T('the fire times are the start time minus the lead',
    rows.every((r) => new Date(r.fire_at).getTime()
      === new Date(T2).getTime() - r.lead_minutes * 60_000),
    rows.map((r) => r.fire_at));
  T('a re-armed notice is queue-eligible again',
    rows.every((r) => r.enqueued_at === null && r.sent_at === null));

  // Re-sending the same instant is not a move: a client that PATCHes the whole
  // form must not re-arm (and therefore re-notify) on every save.
  const before = await ledger(meeting.id);
  await updateMeeting(owner, meeting.id, { occurredAt: T2, subject: 'Same time, new title' });
  const after = await ledger(meeting.id);
  T('re-sending the same instant does not re-arm',
    JSON.stringify(before) === JSON.stringify(after));
}

console.log('\n=== an edit can move the meeting to another record ===');
{
  const updated = await updateMeeting(owner, meeting.id, {
    entityType: 'contact', entityId: otherContactId,
  });
  T('the meeting is re-anchored', updated.entityId === otherContactId, updated.entityId);
  T('the stored row agrees', (await meetingRow(meeting.id))?.['entity_id'] === otherContactId);
}

console.log('\n=== invalid edits are refused and change nothing ===');
{
  const before = await meetingRow(meeting.id);

  const empty = await attempt(() => updateMeeting(owner, meeting.id, {}));
  T('an edit with no fields is refused', !empty.ok, empty.ok ? 'accepted' : empty.e);

  const manyFields = await attempt(() => updateMeeting(owner, meeting.id, {
    entityType: 'contact', entityId: otherContactId,
  }));
  T('moving to the same anchor is still allowed', manyFields.ok);

  const badTime = await attempt(() => updateMeeting(owner, meeting.id, { occurredAt: 'whenever' }));
  T('an unparsable time is refused', !badTime.ok, badTime.ok ? 'accepted' : badTime.e);

  const blankTitle = await attempt(() => updateMeeting(owner, meeting.id, { subject: '   ' }));
  T('a blank subject is refused', !blankTitle.ok, blankTitle.ok ? 'accepted' : blankTitle.e);

  const foreignAnchor = await attempt(() => updateMeeting(owner, meeting.id, {
    entityType: 'contact', entityId: newId(),
  }));
  T('an unknown anchor 404s', !foreignAnchor.ok);

  const halfAnchor = await attempt(() => updateMeeting(owner, meeting.id, { entityType: 'contact' }));
  T('half an anchor is refused', !halfAnchor.ok);

  const badEntityType = await attempt(() => updateMeeting(owner, meeting.id, {
    entityType: 'invoice', entityId: otherContactId,
  }));
  T('an unknown entity type is refused', !badEntityType.ok);

  const after = await meetingRow(meeting.id);
  T('the refused edits left the row untouched',
    JSON.stringify(before) === JSON.stringify(after), { before, after });
}

console.log('\n=== the verbs are meeting-only ===');
{
  // A `call` activity is a real row in the same table with a real id. It must be
  // invisible to the meeting verbs, exactly like another tenant's meeting.
  const callId = newId();
  await db.query(
    `INSERT INTO activities (id, organization_id, type, actor_id, entity_type, entity_id, subject, occurred_at)
    VALUES ($1,$2,'call',$3,'contact',$4,'Intro call',now())`,
    [callId, owner.organizationId, owner.userId, contactId],
  );
  const edit = await attempt(() => updateMeeting(owner, callId, { subject: 'Hijacked' }));
  const remove = await attempt(() => deleteMeeting(owner, callId));
  T('a non-meeting activity cannot be edited as a meeting', !edit.ok);
  T('a non-meeting activity cannot be deleted as a meeting', !remove.ok);

  const still = await db.query<{ id: string }>(
    `SELECT id FROM activities WHERE id = $1`, [callId]);
  T('the call activity survives', still.rows.length === 1);
}

console.log('\n=== deleting a meeting ===');
{
  const doomed = await scheduleMeeting(owner, {
    entityType: 'contact', entityId: contactId, occurredAt: T1, subject: 'Cancel me',
  });
  await inviteToMeeting(owner, doomed.id, [member.user.id]);

  const invitesBefore = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM meeting_invites WHERE meeting_id = $1`, [doomed.id]);
  T('the invitation exists before the delete', Number(invitesBefore.rows[0]?.n) === 1);

  // Mark one notice as already delivered, to prove history is not rewritten.
  const rows = await ledger(doomed.id);
  await db.query(`UPDATE event_reminders SET sent_at = now() WHERE id = $1`, [rows[0]!.id]);

  await deleteMeeting(owner, doomed.id);

  T('the meeting row is gone', (await meetingRow(doomed.id)) === null);
  T('the invitations cascade away',
    Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM meeting_invites WHERE meeting_id = $1`, [doomed.id],
    )).rows[0]?.n) === 0);

  const remaining = await ledger(doomed.id);
  T('the undelivered notice is retired', remaining.length === 1, remaining.length);
  T('the delivered notice is kept as history', remaining[0]?.sent_at !== null,
    remaining[0]?.sent_at);

  const audits = await auditRows(doomed.id);
  T('the delete is audited', audits.some((a) => a['action'] === 'activities.delete'),
    audits.map((a) => a['action']));
  const del = audits.find((a) => a['action'] === 'activities.delete');
  T('the delete audit has no after-image (the row is gone)', del?.['after_json'] === null,
    del?.['after_json']);

  const timeline = await db.query<{ id: string; subject: string | null; description: string | null }>(
    `SELECT id, subject, description FROM activities
    WHERE organization_id = $1 AND entity_type = 'contact' AND entity_id = $2
    AND type = 'status_change' AND description = 'Meeting deleted'`,
    [owner.organizationId, contactId],
  );
  T('the parent record timeline records the cancellation', timeline.rows.length === 1,
    timeline.rows.length);
  T('the timeline keeps the cancelled subject', timeline.rows[0]?.subject === 'Cancel me',
    timeline.rows[0]?.subject);

  const receipt = await attempt(() => deleteMeeting(owner, doomed.id));
  T('a second delete is a 404', !receipt.ok);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('FAILURES:');
  for (const f of fails) console.log(` - ${f}`);
  process.exit(1);
}
