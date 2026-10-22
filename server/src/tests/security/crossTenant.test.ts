/**
 * Cross-tenant negative tests.
 *
 * Every other suite proves that the *right* tenant can do the right thing. This
 * one proves the complement: a fully authorised owner in workspace A cannot
 * reach a single row in workspace B, through any door. That is the failure the
 * whole `TenantScope` design exists to prevent, and it is invisible to positive
 * tests -- a query that forgot its predicate returns the right answer for the
 * right user and somebody else's data for the wrong one.
 *
 * The doors exercised are the ones that take an id from the client rather than
 * deriving one from the session: record reads and writes, the shared event
 * window, calendar agenda, notifications, attachment download/list/delete,
 * export download, meeting edit/delete, the invitations inbox, and a queue job
 * whose payload names another tenant's reminder.
 *
 * Two rules are asserted throughout:
 *
 * 1. **404, not 403.** A 403 confirms the id exists elsewhere, which is itself
 *    a cross-tenant oracle. The API answers "not found" for both a missing row
 *    and a foreign one.
 * 2. **No echo.** The refusal body must not carry the foreign record's data.
 *
 * Each negative assertion is paired with a positive control in the owning
 * tenant, so a route that is simply broken cannot pass this suite.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { createApp } from '../../app.ts';
import { getDb } from '../../db/driver.ts';
import { newId } from '../../lib/ids.ts';
import type { AddressInfo } from 'node:net';
import type { ActorRef } from '../../services/records.ts';
import { createRecord } from '../../services/records.ts';
import { registerUser, loginUser } from '../../services/auth.ts';
import { createMember } from '../../services/org.ts';
import { scheduleMeeting, inviteToMeeting } from '../../services/calendar.ts';
import { deliverDueReminder } from '../../services/reminders.ts';

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

const C = { ip: '10.0.0.41', userAgent: 'cross-tenant-test/1.0', requestId: 'req-xt' };
const PASSWORD = 'Cross-Tenant-Pass!42';

//  boot 
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

const api = (path: string, token: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${BASE}/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

const tokenFor = async (email: string, password: string): Promise<string> => {
  const r = await loginUser({ email, password, client: C });
  if (r.kind !== 'ok') throw new Error(`login refused for ${email}: ${r.kind}`);
  return r.accessToken;
};

const mkOrg = async (name: string, email: string): Promise<ActorRef> => {
  const r = await registerUser({
    name, email, password: PASSWORD, organizationName: `${name} Ltd`, client: C,
  });
  return { userId: r.user.id, organizationId: r.organizationId, role: 'owner', email: r.user.email };
};

const db = await getDb();
const countNotifications = async (organizationId: string): Promise<number> => {
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications WHERE organization_id = $1`, [organizationId]);
  return Number(r.rows[0]?.n ?? 0);
};

//  two workspaces 
const acme = await mkOrg('XtAcme', 'xt-acme@corp.io');
const globex = await mkOrg('XtGlobex', 'xt-globex@corp.io');
const acmeToken = await tokenFor('xt-acme@corp.io', PASSWORD);
const globexToken = await tokenFor('xt-globex@corp.io', PASSWORD);

// A second globex member makes the meeting fan-out real: with one member there
// would be nothing to deliver, and the notification assertions would pass
// vacuously.
const globexMember = await createMember(globex, {
  email: 'xt-globex-sales@corp.io', role: 'sales', name: 'Globex Sales',
});
const globexMemberToken = await tokenFor('xt-globex-sales@corp.io', globexMember.generatedPassword);

const acmeMember = await createMember(acme, {
  email: 'xt-acme-sales@corp.io', role: 'sales', name: 'Acme Sales',
});
const acmeMemberToken = await tokenFor('xt-acme-sales@corp.io', acmeMember.generatedPassword);

const WHEN = '2027-03-01T10:00:00.000Z';
const FROM = '2027-03-01T00:00:00.000Z';
const TO = '2027-03-02T00:00:00.000Z';

const acmeContact = await createRecord(acme, 'contacts', {
  first_name: 'Acme', last_name: 'Insider', email: 'insider@acme.example',
});
const globexContact = await createRecord(globex, 'contacts', {
  first_name: 'Globex', last_name: 'Outsider', email: 'outsider@globex.example',
});
const acmeContactId = String(acmeContact.record.id);
const globexContactId = String(globexContact.record.id);

const acmeTask = await createRecord(acme, 'tasks', { title: 'Acme task', due_date: WHEN });
const globexTask = await createRecord(globex, 'tasks', {
  title: 'Globex confidential task', due_date: WHEN,
});
const globexTaskId = String(globexTask.record.id);

const acmeMeeting = await scheduleMeeting(acme, {
  entityType: 'contact', entityId: acmeContactId, occurredAt: WHEN, subject: 'Acme kickoff',
});
const globexMeeting = await scheduleMeeting(globex, {
  entityType: 'contact', entityId: globexContactId, occurredAt: WHEN, subject: 'Globex board meeting',
});

console.log('\n=== records ===');
{
  const read = await api(`/contacts/${globexContactId}`, acmeToken);
  const body = await read.json() as any;
  T('a foreign contact is 404, not 403', read.status === 404, read.status);
  T('the refusal does not echo the foreign record',
    !JSON.stringify(body).includes('Outsider'), body);

  const patch = await api(`/contacts/${globexContactId}`, acmeToken, {
    method: 'PATCH', body: JSON.stringify({ first_name: 'Hijacked' }),
  });
  T('a foreign contact cannot be patched', patch.status === 404, patch.status);

  const remove = await api(`/contacts/${globexContactId}`, acmeToken, { method: 'DELETE' });
  T('a foreign contact cannot be deleted', remove.status === 404, remove.status);

  const still = await api(`/contacts/${globexContactId}`, globexToken);
  T('the owning tenant still reads it (positive control)', still.status === 200, still.status);
  const stillBody = await still.json() as any;
  T('the row was not modified by the refused write',
    stillBody.data?.last_name === 'Outsider' && stillBody.data?.first_name === 'Globex', stillBody.data?.first_name);

  const search = await api('/contacts?q=Outsider', acmeToken);
  const searchBody = await search.json() as any;
  T('a search in another tenant returns no rows', search.status === 200 && (searchBody.data ?? []).length === 0,
    searchBody.data?.length);

  const ownSearch = await api('/contacts?q=Insider', acmeToken);
  const ownBody = await ownSearch.json() as any;
  T('the same search finds this tenant\'s row (positive control)',
    (ownBody.data ?? []).length === 1 && String(ownBody.data[0].last_name) === 'Insider', ownBody.data?.length);
}

console.log('\n=== tasks and the shared event window ===');
{
  const read = await api(`/tasks/${globexTaskId}`, acmeToken);
  T('a foreign task is 404', read.status === 404, read.status);

  const patch = await api(`/tasks/${globexTaskId}`, acmeToken, {
    method: 'PATCH', body: JSON.stringify({ status: 'completed' }),
  });
  T('a foreign task cannot be patched', patch.status === 404, patch.status);

  const eventTask = await api(`/calendar/events/task/${globexTaskId}`, acmeToken);
  T('the event window will not open a foreign task', eventTask.status === 404, eventTask.status);

  const eventMeeting = await api(`/calendar/events/meeting/${globexMeeting.id}`, acmeToken);
  const eventBody = await eventMeeting.json() as any;
  T('the event window will not open a foreign meeting', eventMeeting.status === 404, eventMeeting.status);
  T('the meeting refusal does not echo its subject',
    !JSON.stringify(eventBody).includes('Globex board meeting'), eventBody);

  const ownEvent = await api(`/calendar/events/meeting/${acmeMeeting.id}`, acmeToken);
  T('the same window opens this tenant\'s meeting (positive control)', ownEvent.status === 200, ownEvent.status);
}

console.log('\n=== calendar agenda ===');
{
  const res = await api(`/calendar?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`, acmeToken);
  const body = await res.json() as any;
  const meetings = (body.data?.meetings ?? []).map((m: any) => String(m.id));
  const tasks = (body.data?.tasks ?? []).map((t: any) => String(t.id));

  T('the agenda does not contain the foreign meeting', !meetings.includes(String(globexMeeting.id)), meetings);
  T('the agenda does not contain the foreign task', !tasks.includes(String(globexTaskId)), tasks);
  T('the agenda does contain this tenant\'s meeting (positive control)',
    meetings.includes(String(acmeMeeting.id)), meetings);
  T('the agenda does contain this tenant\'s task (positive control)',
    tasks.includes(String(acmeTask.record.id)), tasks);
}

console.log('\n=== notifications ===');
{
  // Both workspaces get a second member, so each inbox has real content. A
  // negative assertion against an empty inbox proves nothing.
  const res = await api('/notifications', acmeMemberToken);
  const body = await res.json() as any;
  const text = JSON.stringify(body);
  T('this tenant\'s inbox is readable', res.status === 200, res.status);
  T('it contains this tenant\'s own notice (positive control)', text.includes('Acme kickoff'), text.slice(0, 160));
  T('a foreign meeting notice is absent', !text.includes('Globex board meeting'));
  T('a foreign task notice is absent', !text.includes('Globex confidential task'));

  const own = await api('/notifications', globexMemberToken);
  const ownText = JSON.stringify(await own.json());
  T('the matching notice exists in the owning tenant (positive control)',
    ownText.includes('Globex board meeting'));
}

console.log('\n=== attachments ===');
let globexAttachmentId = '';
{
  const upload = await api('/attachments', globexToken, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      'x-entity-type': 'contact',
      'x-entity-id': globexContactId,
      'x-file-name': 'secret.txt',
    },
    body: 'Globex confidential bytes',
  });
  const uploadBody = await upload.json() as any;
  globexAttachmentId = String(uploadBody.data?.id ?? '');
  T('the owner uploads an attachment (positive control)',
    upload.status === 201 && globexAttachmentId.length > 0, upload.status);

  const foreign = await api(`/attachments/file/${globexAttachmentId}`, acmeToken);
  T('a foreign attachment cannot be downloaded', foreign.status === 404, foreign.status);
  T('the refusal body is not the file',
    !(await foreign.text()).includes('confidential bytes'));

  const own = await api(`/attachments/file/${globexAttachmentId}`, globexToken);
  T('the owner downloads the same bytes (positive control)',
    own.status === 200 && (await own.text()) === 'Globex confidential bytes', own.status);

  const list = await api(`/attachments/contact/${globexContactId}`, acmeToken);
  const listBody = await list.json() as any;
  T('listing a foreign entity\'s attachments returns nothing',
    list.status === 200 && (listBody.data ?? []).length === 0, list.status);

  const remove = await api(`/attachments/file/${globexAttachmentId}`, acmeToken, { method: 'DELETE' });
  T('a foreign attachment cannot be deleted', remove.status === 404, remove.status);

  const survive = await api(`/attachments/file/${globexAttachmentId}`, globexToken);
  T('the attachment survives the refused delete (positive control)', survive.status === 200, survive.status);
}

console.log('\n=== exports ===');
{
  const created = await api('/transfers/exports', globexToken, {
    method: 'POST', body: JSON.stringify({ entityType: 'contacts' }),
  });
  const createdBody = await created.json() as any;
  const jobId = String(createdBody.data?.id ?? '');
  T('the owner creates an export (positive control)', created.status === 201 && jobId.length > 0, created.status);

  const foreign = await api(`/transfers/exports/${jobId}/download`, acmeToken);
  T('a foreign export job cannot be downloaded', foreign.status === 404, foreign.status);

  const own = await api(`/transfers/exports/${jobId}/download`, globexToken);
  const csv = await own.text();
  T('the owning tenant downloads its own export (positive control)', own.status === 200, own.status);
  T('the export contains its own record', csv.includes('Outsider'), csv.slice(0, 120));
  T('the export contains no other tenant\'s record', !csv.includes('Insider'));
}

console.log('\n=== meeting invitations ===');
{
  const invited = await attempt(() => inviteToMeeting(globex, String(globexMeeting.id), [globexMember.user.id]));
  T('the owner invites a member (positive control)', invited.ok, invited.ok ? '' : invited.e);

  const mine = await api('/calendar/invites', globexMemberToken);
  const mineBody = await mine.json() as any;
  T('the invitee sees the invitation (positive control)',
    (mineBody.data ?? []).length === 1, mineBody.data?.length);

  const foreign = await api('/calendar/invites', acmeToken);
  const foreignBody = await foreign.json() as any;
  T('another tenant\'s inbox is empty', (foreignBody.data ?? []).length === 0, foreignBody.data?.length);
}

console.log('\n=== meeting edit and delete ===');
{
  const patch = await api(`/calendar/meetings/${globexMeeting.id}`, acmeToken, {
    method: 'PATCH', body: JSON.stringify({ subject: 'Hijacked by another tenant' }),
  });
  T('a foreign meeting cannot be edited', patch.status === 404, patch.status);

  const remove = await api(`/calendar/meetings/${globexMeeting.id}`, acmeToken, { method: 'DELETE' });
  T('a foreign meeting cannot be deleted', remove.status === 404, remove.status);

  const survive = await api(`/calendar/events/meeting/${globexMeeting.id}`, globexToken);
  const surviveBody = await survive.json() as any;
  T('the meeting is untouched in the owning tenant (positive control)',
    survive.status === 200 && surviveBody.data?.title === 'Globex board meeting', surviveBody.data?.title);
}

console.log('\n=== reminder delivery (worker payload boundary) ===');
{
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM event_reminders
    WHERE organization_id = $1 AND entity_kind = 'meeting' AND entity_id = $2
    ORDER BY lead_minutes DESC LIMIT 1`,
    [globex.organizationId, String(globexMeeting.id)],
  );
  const reminderId = String(rows.rows[0]?.id ?? '');
  T('the owning tenant has an armed reminder (positive control)', reminderId.length > 0);

  const before = await countNotifications(globex.organizationId);

  // The hostile shape: a job in *our* organisation naming *their* reminder.
  await deliverDueReminder({
    id: newId(),
    organizationId: acme.organizationId,
    type: 'reminder.deliver',
    payload: { reminderId },
    status: 'claimed',
    attempts: 0,
    maxAttempts: 5,
    runAt: new Date().toISOString(),
  });

  const after = await db.query<{ sent_at: string | null }>(
    `SELECT sent_at FROM event_reminders WHERE id = $1`, [reminderId]);
  T('the foreign reminder is not marked sent', after.rows[0]?.sent_at === null, after.rows[0]?.sent_at);
  T('no notification was written to the foreign tenant',
    (await countNotifications(globex.organizationId)) === before);

  // Positive control: the same job from the owning tenant does deliver, so the
  // assertion above cannot pass just because delivery is broken.
  await deliverDueReminder({
    id: newId(),
    organizationId: globex.organizationId,
    type: 'reminder.deliver',
    payload: { reminderId },
    status: 'claimed',
    attempts: 0,
    maxAttempts: 5,
    runAt: new Date().toISOString(),
  });
  const delivered = await db.query<{ sent_at: string | null }>(
    `SELECT sent_at FROM event_reminders WHERE id = $1`, [reminderId]);
  T('the same job from the owning tenant delivers (positive control)',
    delivered.rows[0]?.sent_at !== null, delivered.rows[0]?.sent_at);
  T('the delivery notifies the workspace',
    (await countNotifications(globex.organizationId)) > before);
}

await new Promise<void>((resolve) => server.close(() => resolve()));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('FAILURES:');
  for (const f of fails) console.log(` - ${f}`);
  process.exit(1);
}
