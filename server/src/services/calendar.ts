/**
 * Calendar: a month-range agenda of meetings (timed activities) and dated tasks.
 *
 * Two sources, one view. Meetings are `activities` rows of type `meeting` keyed
 * on `occurred_at`; tasks surface by `due_date`. Neither source is altered
 * here, so the calendar and the record pages cannot disagree: same rows, same
 * predicates.
 *
 * Scheduling writes an activity row, which the record timeline also shows --
 * one write, two views. Attendees are deliberately out of scope: there is no
 * attendee model, so a meeting is a timed note on an entity (RULE 6).
 */
import { TenantScope } from '../repositories/base.ts';
import type { DbClient } from '../db/driver.ts';
import { badRequest, notFound, validationFailed } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { securityLog } from '../lib/logger.ts';
import type { ActorRef } from './records.ts';
import { notifyOrgMembers } from './activity.ts';
import { cancelEventReminders, scheduleEventReminders } from './reminders.ts';
import { writeAudit } from './org.ts';

/** Widest range a single agenda request may cover -- a quarter view. */
const MAX_RANGE_DAYS = 93;
/** Rows per source. A month view renders ~42 days; 500 caps abuse, not use. */
const MAX_ROWS = 500;

export interface CalendarMeeting {
 id: string;
 entityType: string;
 entityId: string;
 subject: string | null;
 description: string | null;
 occurredAt: string;
 actorId: string | null;
 actorName: string | null;
}

export interface CalendarTask {
 id: string;
 title: string;
 status: string;
 priority: string;
 dueDate: string;
 relatedType: string | null;
 relatedId: string | null;
}

export interface CalendarAgenda {
 from: string;
 to: string;
 meetings: CalendarMeeting[];
 tasks: CalendarTask[];
}

/** Entity types a meeting may be attached to. Mirrors the timeline read path:
 * only types with detail pages, so every agenda entry links somewhere real. */
const MEETING_ENTITIES = ['contact', 'company', 'lead', 'deal', 'task'] as const;
type MeetingEntity = (typeof MEETING_ENTITIES)[number];
const ENTITY_TABLES: Record<MeetingEntity, string> = {
 contact: 'contacts',
 company: 'companies',
 lead: 'leads',
 deal: 'deals',
 task: 'tasks',
};

function parseBound(raw: unknown, name: string): Date {
 const d = new Date(String(raw ?? ''));
 if (Number.isNaN(d.getTime())) throw validationFailed({ [name]: 'Enter a valid date.' });
 return d;
}

export function parseRange(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } {
 const from = parseBound(fromRaw, 'from');
 const to = parseBound(toRaw, 'to');
 if (from.getTime() >= to.getTime()) {
 throw validationFailed({ to: 'The end of the range must be after its start.' });
 }
 if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
 throw validationFailed({ to: `A calendar request covers at most ${MAX_RANGE_DAYS} days.` });
 }
 return { from, to };
}

const toMeeting = (r: Record<string, unknown>): CalendarMeeting => ({
 id: String(r['id']),
 entityType: String(r['entity_type']),
 entityId: String(r['entity_id']),
 subject: r['subject'] === null ? null : String(r['subject']),
 description: r['description'] === null ? null : String(r['description']),
 occurredAt: String(r['occurred_at']),
 actorId: r['actor_id'] === null ? null : String(r['actor_id']),
 actorName: r['actor_name'] === null ? null : String(r['actor_name']),
});

const toTask = (r: Record<string, unknown>): CalendarTask => ({
 id: String(r['id']),
 title: String(r['title']),
 status: String(r['status']),
 priority: String(r['priority']),
 dueDate: String(r['due_date']),
 relatedType: r['related_type'] === null ? null : String(r['related_type']),
 relatedId: r['related_id'] === null ? null : String(r['related_id']),
});

export async function getCalendar(
 actor: ActorRef,
 fromRaw: unknown,
 toRaw: unknown,
): Promise<CalendarAgenda> {
 const { from, to } = parseRange(fromRaw, toRaw);
 const scope = new TenantScope(actor.organizationId);

 const meetings = await scope.query(
 `SELECT a.id, a.entity_type, a.entity_id, a.subject, a.description,
 a.occurred_at, a.actor_id, u.name AS actor_name
 FROM activities a LEFT JOIN users u ON u.id = a.actor_id
 WHERE a.organization_id = $1 AND a.type = 'meeting'
 AND a.occurred_at >= $2 AND a.occurred_at < $3
 ORDER BY a.occurred_at, a.id LIMIT ${MAX_ROWS}`,
 [actor.organizationId, from.toISOString(), to.toISOString()],
 );

 const tasks = await scope.query(
 `SELECT id, title, status, priority, due_date, related_type, related_id
 FROM tasks
 WHERE organization_id = $1 AND deleted_at IS NULL
 AND due_date IS NOT NULL AND due_date >= $2 AND due_date < $3
 ORDER BY due_date, id LIMIT ${MAX_ROWS}`,
 [actor.organizationId, from.toISOString(), to.toISOString()],
 );

 return {
 from: from.toISOString(),
 to: to.toISOString(),
 meetings: meetings.map(toMeeting),
 tasks: tasks.map(toTask),
 };
}

export interface ScheduleMeetingInput {
 entityType: string;
 entityId: string;
 occurredAt: string;
 subject: string;
 description?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function scheduleMeeting(
 actor: ActorRef,
 input: ScheduleMeetingInput,
): Promise<CalendarMeeting> {
 const entityType = String(input.entityType ?? '').trim();
 if (!(MEETING_ENTITIES as readonly string[]).includes(entityType)) {
 throw validationFailed({ entityType: 'Meetings attach to contacts, companies, leads, deals or tasks.' });
 }
 const entityId = String(input.entityId ?? '').trim().toLowerCase();
 if (!UUID_RE.test(entityId)) throw notFound('Record not found.');

 const scope = new TenantScope(actor.organizationId);
 // The meeting must attach to a row of this tenant. A foreign id -- guessed,
 // enumerated, or from another workspace -- is indistinguishable from a
 // missing one, so existence is never confirmed across tenants.
 const owner = await scope.queryOne(
 `SELECT id FROM ${ENTITY_TABLES[entityType as MeetingEntity]}
 WHERE organization_id = $1 AND id = $2`,
 [actor.organizationId, entityId],
 );
 if (!owner) throw notFound('Record not found.');

 const when = new Date(String(input.occurredAt ?? ''));
 if (Number.isNaN(when.getTime())) throw validationFailed({ occurredAt: 'Enter a valid date and time.' });
 const subject = String(input.subject ?? '').trim();
 if (subject.length < 1 || subject.length > 200) {
 throw validationFailed({ subject: 'Give the meeting a title of 1-200 characters.' });
 }
 const description = String(input.description ?? '');
 if (description.length > 2000) throw validationFailed({ description: 'Keep notes under 2000 characters.' });

 const id = newId();
 const db = scope.unsafe;
 await db.query(
 `INSERT INTO activities
 (id, organization_id, type, actor_id, entity_type, entity_id, subject, description, occurred_at)
 VALUES ($1,$2,'meeting',$3,$4,$5,$6,$7,$8)`,
 [id, actor.organizationId, actor.userId, entityType, entityId,
 subject, description.slice(0, 2000), when.toISOString()],
 );

 // A meeting on the shared calendar is visible work: every other member of the
 // workspace is told about it. The scheduler is excluded -- they just made it.
 await notifyOrgMembers(scope, actor, {
 type: 'calendar_meeting',
 title: `Meeting scheduled: ${subject}`,
 body: `${actor.email} scheduled "${subject}" for ${when.toISOString()}`,
 link: '/calendar',
 entityType: 'meeting',
 entityId: id,
 });
 // The meeting also earns its two advance notices: one an hour before it
 // starts, one fifteen minutes before. Best-effort, like the announcement above
 // -- a scheduling hiccup must not undo a meeting somebody just booked.
 await scope.bestEffort('reminder.schedule', async (s) => {
 await scheduleEventReminders(s, {
 organizationId: actor.organizationId, kind: 'meeting', id, dueAt: when.toISOString(),
 });
 return true;
 });

 const rows = await scope.query(
 `SELECT a.id, a.entity_type, a.entity_id, a.subject, a.description,
 a.occurred_at, a.actor_id, u.name AS actor_name
 FROM activities a LEFT JOIN users u ON u.id = a.actor_id
 WHERE a.organization_id = $1 AND a.id = $2`,
 [actor.organizationId, id],
 );
 const created = rows[0];
 if (!created) throw badRequest('Could not schedule the meeting.');
 securityLog('meeting.scheduled', {
 userId: actor.userId, organizationId: actor.organizationId,
 entityType, entityId, occurredAt: when.toISOString(),
 });
 return toMeeting(created);
}

export const __testing = { MAX_RANGE_DAYS, MAX_ROWS, MEETING_ENTITIES };

//  invitations 

export interface MeetingInvite {
 id: string;
 meetingId: string;
 userId: string;
 status: string;
 createdAt: string;
 respondedAt: string | null;
}

export interface InviteResult {
 invited: MeetingInvite[];
 alreadyInvited: string[];
}

const toInvite = (r: Record<string, unknown>): MeetingInvite => ({
 id: String(r['id']),
 meetingId: String(r['meeting_id']),
 userId: String(r['user_id']),
 status: String(r['status']),
 createdAt: String(r['created_at']),
 respondedAt: r['responded_at'] === null ? null : String(r['responded_at']),
});

async function loadMeeting(db: DbClient, actor: ActorRef, meetingId: string) {
 if (!UUID_RE.test(meetingId)) throw notFound('Meeting not found.');
 const rows = await db.query<{ id: string; subject: string | null; occurred_at: string }>(
 `SELECT id, subject, occurred_at FROM activities
 WHERE organization_id = $1 AND id = $2 AND type = 'meeting'`,
 [actor.organizationId, meetingId],
 );
 const meeting = rows.rows[0];
 if (!meeting) throw notFound('Meeting not found.');
 return meeting;
}

/**
 * Invites workspace members to a meeting. All-or-nothing: every id is
 * validated first (membership, existence), then invites and notifications are
 * written in one transaction. An id that is unknown, deleted, or outside the
 * tenant 404s the whole request -- a partial invite would leave the inviter
 * unsure who was told, and 404-vs-403 indistinguishability (no cross-tenant
 * oracle) matters more than convenience here, because the picker only ever
 * offers members.
 */
export async function inviteToMeeting(
 actor: ActorRef,
 meetingIdRaw: string,
 userIdsRaw: unknown,
): Promise<InviteResult> {
 const { getDb } = await import('../db/driver.ts');
 const { createNotification } = await import('./activity.ts');
 const db = await getDb();

 const meetingId = String(meetingIdRaw ?? '').trim().toLowerCase();
 const meeting = await loadMeeting(db, actor, meetingId);

 if (!Array.isArray(userIdsRaw)) throw validationFailed({ userIds: 'Invite at least one person.' });
 const wanted = [...new Set(userIdsRaw.map((u) => String(u ?? '').trim().toLowerCase()))];
 if (wanted.length < 1 || wanted.length > 50) {
 throw validationFailed({ userIds: 'Invite between 1 and 50 people at a time.' });
 }
 for (const id of wanted) {
 if (!UUID_RE.test(id)) throw notFound('Meeting not found.');
 }

 // Validate everybody before writing anything.
 const members = await db.query<{ user_id: string; email: string; name: string }>(
 `SELECT m.user_id, u.email, u.name FROM organization_members m
 JOIN users u ON u.id = m.user_id
 WHERE m.organization_id = $1 AND u.deleted_at IS NULL`,
 [actor.organizationId],
 );
 const directory = new Map(members.rows.map((m) => [m.user_id, m]));
 for (const id of wanted) {
 if (!directory.has(id)) throw notFound('Meeting not found.');
 }

 const existing = await db.query<{ user_id: string }>(
 `SELECT user_id FROM meeting_invites WHERE organization_id = $1 AND meeting_id = $2`,
 [actor.organizationId, meetingId],
 );
 const already = new Set(existing.rows.map((r) => r.user_id));
 const fresh = wanted.filter((id) => !already.has(id));

 const invited: MeetingInvite[] = await db.transaction(async (tx) => {
 const out: MeetingInvite[] = [];
 for (const userId of fresh) {
 const rows = await tx.query(
 `INSERT INTO meeting_invites (id, organization_id, meeting_id, user_id)
 VALUES ($1,$2,$3,$4) RETURNING id, meeting_id, user_id, status, created_at, responded_at`,
 [newId(), actor.organizationId, meetingId, userId],
 );
 const invite = toInvite(rows.rows[0]!);
 out.push(invite);
 const person = directory.get(userId)!;
 await createNotification(
 { organizationId: actor.organizationId },
 {
 userId,
 type: 'meeting_invite',
 title: `You are invited: ${meeting.subject || 'Meeting'}`,
 body: `${person.name || person.email} -- ${meeting.occurred_at}`,
 link: '/calendar',
 entityType: 'meeting',
 entityId: meetingId,
 },
 );
 }
 return out;
 });

 securityLog('meeting.invited', {
 userId: actor.userId, organizationId: actor.organizationId,
 meetingId, invited: invited.map((i) => i.userId),
 });
 return { invited, alreadyInvited: wanted.filter((id) => already.has(id)) };
}

/**
 * The invitee answers their own invitation. The row is claimed by
 * (organization, id, user) together: another tenant's invite id -- or another
 * user's -- matches nothing and 404s, confirming nothing about either.
 */
export async function respondToInvite(
 actor: ActorRef,
 inviteIdRaw: string,
 statusRaw: string,
): Promise<MeetingInvite> {
 const { getDb } = await import('../db/driver.ts');
 const db = await getDb();
 const inviteId = String(inviteIdRaw ?? '').trim().toLowerCase();
 const status = String(statusRaw ?? '').trim().toLowerCase();
 if (!UUID_RE.test(inviteId)) throw notFound('Invitation not found.');
 if (status !== 'accepted' && status !== 'declined') {
 throw validationFailed({ status: 'Answer accepted or declined.' });
 }
 const rows = await db.query(
 `UPDATE meeting_invites SET status = $4, responded_at = $5
 WHERE organization_id = $1 AND id = $2 AND user_id = $3
 RETURNING id, meeting_id, user_id, status, created_at, responded_at`,
 [actor.organizationId, inviteId, actor.userId, status, nowIso()],
 );
 const invite = rows.rows[0];
 if (!invite) throw notFound('Invitation not found.');
 return toInvite(invite);
}

/**
 * Minimal directory for the invite picker: id, name and email only. The full
 * member list (`GET /org/members`) carries roles, lockout and MFA state and
 * needs `users.read`, which sales -- who may schedule and invite -- does not
 * hold. This endpoint is gated on `activities.create` instead: exactly the
 * permission the picker serves, and nothing it does not need.
 */
export async function listInvitees(actor: ActorRef): Promise<{ id: string; name: string; email: string }[]> {
 const { getDb } = await import('../db/driver.ts');
 const db = await getDb();
 const rows = await db.query<{ id: string; name: string; email: string }>(
 `SELECT u.id, u.name, u.email FROM organization_members m
 JOIN users u ON u.id = m.user_id
 WHERE m.organization_id = $1 AND u.deleted_at IS NULL
 ORDER BY u.name, u.email`,
 [actor.organizationId],
 );
 return rows.rows;
}

export interface MyInvite {
 id: string;
 status: string;
 createdAt: string;
 meetingId: string;
 subject: string | null;
 occurredAt: string;
 entityType: string;
 entityId: string;
 inviterName: string | null;
}

/**
 * The caller's own inbox. Scoped three ways -- organization, invitee, and
 * (via the join) a meeting that still exists -- so a deleted meeting's
 * invites vanish with it instead of pointing at a ghost.
 */
export async function listMyInvites(actor: ActorRef, status?: string): Promise<MyInvite[]> {
 const { getDb } = await import('../db/driver.ts');
 const db = await getDb();
 const want = status === 'accepted' || status === 'declined' ? status : null;
 const rows = await db.query<{
 id: string; status: string; created_at: string; meeting_id: string;
 subject: string | null; occurred_at: string; entity_type: string;
 entity_id: string; inviter_name: string | null;
 }>(
 `SELECT i.id, i.status, i.created_at, i.meeting_id,
 a.subject, a.occurred_at, a.entity_type, a.entity_id,
 u.name AS inviter_name
 FROM meeting_invites i
 JOIN activities a ON a.id = i.meeting_id
 LEFT JOIN users u ON u.id = a.actor_id
 WHERE i.organization_id = $1 AND i.user_id = $2
 ${want ? 'AND i.status = $3' : ''}
 ORDER BY a.occurred_at, i.created_at`,
 want ? [actor.organizationId, actor.userId, want] : [actor.organizationId, actor.userId],
 );
 return rows.rows.map((r) => ({
 id: String(r.id),
 status: String(r.status),
 createdAt: String(r.created_at),
 meetingId: String(r.meeting_id),
 subject: r.subject === null ? null : String(r.subject),
 occurredAt: String(r.occurred_at),
 entityType: String(r.entity_type),
 entityId: String(r.entity_id),
 inviterName: r.inviter_name === null ? null : String(r.inviter_name),
 }));
}

//  event detail

/**
 * The two things that can appear on the calendar. A meeting is an activity
 * row; a task is a task row with a due date.
 */
export type CalendarEventKind = 'meeting' | 'task';

/**
 * One event, shaped for the shared "what is this?" window.
 *
 * The calendar chips and the notification list both open this shape, so there
 * is exactly one read behind both surfaces and they cannot drift apart: a
 * change to the window is a change to this payload.
 *
 * Reachability mirrors the agenda. The route gates on `activities.read` and
 * `tasks.read` -- the same pair the month view requires -- and every query is
 * tenant-scoped, so this endpoint publishes nothing the calendar does not
 * already publish to that role.
 */
export interface CalendarEventDetail {
  kind: CalendarEventKind;
  id: string;
  title: string;
  description: string | null;
  /** When the meeting starts, or when the task is due. */
  when: string | null;
  status: string | null;
  priority: string | null;
  creatorId: string | null;
  creatorName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  /** For a meeting: the record it is attached to. */
  entityType: string | null;
  entityId: string | null;
  /** For a task: the record it belongs to, when it has one. */
  relatedType: string | null;
  relatedId: string | null;
}

const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export async function getCalendarEvent(
  actor: ActorRef,
  kindRaw: unknown,
  idRaw: unknown,
): Promise<CalendarEventDetail> {
  const kind = String(kindRaw ?? '').trim().toLowerCase();
  if (kind !== 'meeting' && kind !== 'task') throw notFound('Event not found.');
  const id = String(idRaw ?? '').trim().toLowerCase();
  if (!UUID_RE.test(id)) throw notFound('Event not found.');

  const scope = new TenantScope(actor.organizationId);

  if (kind === 'meeting') {
  const rows = await scope.query(
  `SELECT a.id, a.entity_type, a.entity_id, a.subject, a.description,
  a.occurred_at, a.actor_id, u.name AS actor_name
  FROM activities a LEFT JOIN users u ON u.id = a.actor_id
  WHERE a.organization_id = $1 AND a.id = $2 AND a.type = 'meeting'`,
  [actor.organizationId, id],
  );
  const r = rows[0];
  if (!r) throw notFound('Event not found.');
  return {
  kind: 'meeting',
  id: String(r['id']),
  title: String(r['subject'] ?? 'Meeting'),
  description: nullable(r['description']),
  when: nullable(r['occurred_at']),
  status: null,
  priority: null,
  creatorId: nullable(r['actor_id']),
  creatorName: nullable(r['actor_name']),
  assigneeId: null,
  assigneeName: null,
  entityType: String(r['entity_type']),
  entityId: String(r['entity_id']),
  relatedType: null,
  relatedId: null,
  };
  }

  const rows = await scope.query(
  `SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date,
  t.creator_id, t.assignee_id, t.related_type, t.related_id,
  cu.name AS creator_name, au.name AS assignee_name
  FROM tasks t
  LEFT JOIN users cu ON cu.id = t.creator_id
  LEFT JOIN users au ON au.id = t.assignee_id
  WHERE t.organization_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`,
  [actor.organizationId, id],
  );
  const r = rows[0];
  if (!r) throw notFound('Event not found.');
  return {
  kind: 'task',
  id: String(r['id']),
  title: String(r['title']),
  description: nullable(r['description']),
  when: nullable(r['due_date']),
  status: String(r['status']),
  priority: String(r['priority']),
  creatorId: nullable(r['creator_id']),
  creatorName: nullable(r['creator_name']),
  assigneeId: nullable(r['assignee_id']),
  assigneeName: nullable(r['assignee_name']),
  entityType: null,
  entityId: null,
  relatedType: nullable(r['related_type']),
  relatedId: nullable(r['related_id']),
  };
}

//  meeting lifecycle 

export interface UpdateMeetingInput {
 entityType?: string;
 entityId?: string;
 occurredAt?: string;
 subject?: string;
 description?: string | null;
}

type MeetingRow = {
 id: string;
 entity_type: string;
 entity_id: string;
 subject: string | null;
 description: string | null;
 occurred_at: string;
 actor_id: string | null;
 actor_name: string | null;
};

/** The agenda, the chip and the edit response must all read the same columns. */
const MEETING_SELECT =
 `SELECT a.id, a.entity_type, a.entity_id, a.subject, a.description,
 a.occurred_at, a.actor_id, u.name AS actor_name
 FROM activities a LEFT JOIN users u ON u.id = a.actor_id`;

/**
 * Audit write that cannot take its transaction down with it.
 *
 * Same reasoning as the records service's private helper: `writeAudit` swallows
 * its own errors, but a failed statement poisons a PostgreSQL transaction
 * whether or not the exception was caught. The SAVEPOINT keeps the accepted
 * risk where it is documented -- the audit row may be missing, nothing else.
 */
async function auditMeeting(
 scope: TenantScope,
 args: Parameters<typeof writeAudit>[1],
): Promise<void> {
 await scope.bestEffort('audit.write', async (s) => {
 await writeAudit(s.unsafe, args);
 return true;
 });
}

/**
 * Loads a meeting inside the caller's tenant, or 404s.
 *
 * `type = 'meeting'` is part of the predicate rather than a follow-up check: an
 * activity id belonging to another kind must be indistinguishable from a
 * missing one, and so must another tenant's meeting.
 */
async function loadMeetingRow(
 scope: TenantScope,
 actor: ActorRef,
 meetingId: string,
): Promise<MeetingRow> {
 const rows = await scope.query<MeetingRow>(
 `${MEETING_SELECT}
 WHERE a.organization_id = $1 AND a.id = $2 AND a.type = 'meeting'`,
 [actor.organizationId, meetingId],
 );
 const row = rows[0];
 if (!row) throw notFound('Meeting not found.');
 return row;
}

/**
 * Moves or edits a meeting.
 *
 * Editing is a permission rather than an ownership question: `activities.update`
 * is held by manager, admin and owner (`rbac.ts`), so a manager can correct
 * somebody else's typo on the shared calendar. Sales can schedule but not amend.
 * As everywhere else in this codebase, hiding the button is not authorisation --
 * the gate is on the route and the service still re-reads the row tenant-scoped.
 *
 * The two advance notices are re-armed only when the start time actually moves.
 * A corrected subject is not a new appointment, and re-arming on every edit
 * would re-send both notices for a title change. Comparing instants rather than
 * strings means a client re-sending the same time is a genuine no-op.
 */
export async function updateMeeting(
 actor: ActorRef,
 meetingIdRaw: string,
 input: UpdateMeetingInput,
 meta: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<CalendarMeeting> {
 const meetingId = String(meetingIdRaw ?? '').trim().toLowerCase();
 if (!UUID_RE.test(meetingId)) throw notFound('Meeting not found.');

 const scope = new TenantScope(actor.organizationId);
 const existing = await loadMeetingRow(scope, actor, meetingId);

 const sets: string[] = [];
 const params: unknown[] = [];
 // Named separately from the SQL fragments: the audit allowlist
 // (`AUDIT_ALLOW_FIELDS`) deliberately does not carry titles, notes or
 // timestamps, so without this an edit would leave an audit row saying
 // "something changed" and nothing about what. Recording the column names is
 // not recording the values, so the minimisation rule still holds.
 const touched: string[] = [];

 if (input.subject !== undefined) {
 const subject = String(input.subject ?? '').trim();
 if (subject.length < 1 || subject.length > 200) {
 throw validationFailed({ subject: 'Give the meeting a title of 1-200 characters.' });
 }
 params.push(subject);
 sets.push(`subject = $${params.length}`);
 touched.push('subject');
 }

 if (input.description !== undefined) {
 // An explicit null (or an empty string) clears the notes. Writing `''`
 // instead of NULL would leave two spellings of "no notes" in the table and
 // make `description === null` an unreliable check for callers.
 const description = String(input.description ?? '');
 if (description.length > 2000) {
 throw validationFailed({ description: 'Keep notes under 2000 characters.' });
 }
 params.push(description === '' ? null : description.slice(0, 2000));
 sets.push(`description = $${params.length}`);
 touched.push('description');
 }

 let movedTo: string | null = null;
 if (input.occurredAt !== undefined) {
 const when = new Date(String(input.occurredAt ?? ''));
 if (Number.isNaN(when.getTime())) {
 throw validationFailed({ occurredAt: 'Enter a valid date and time.' });
 }
 movedTo = when.toISOString();
 params.push(movedTo);
 sets.push(`occurred_at = $${params.length}`);
 touched.push('occurred_at');
 }

 if (input.entityType !== undefined || input.entityId !== undefined) {
 if (input.entityType === undefined || input.entityId === undefined) {
 throw validationFailed({ entityType: 'Send both entityType and entityId to move the meeting.' });
 }
 const entityType = String(input.entityType).trim();
 if (!(MEETING_ENTITIES as readonly string[]).includes(entityType)) {
 throw validationFailed({ entityType: 'Meetings attach to contacts, companies, leads, deals or tasks.' });
 }
 const entityId = String(input.entityId).trim().toLowerCase();
 if (!UUID_RE.test(entityId)) throw notFound('Record not found.');
 // The new attachment must be a row of this tenant, for the same reason
 // scheduling checks it: a foreign id must not be confirmed by moving a
 // meeting onto it.
 const owner = await scope.queryOne(
 `SELECT id FROM ${ENTITY_TABLES[entityType as MeetingEntity]}
 WHERE organization_id = $1 AND id = $2`,
 [actor.organizationId, entityId],
 );
 if (!owner) throw notFound('Record not found.');
 params.push(entityType);
 sets.push(`entity_type = $${params.length}`);
 touched.push('entity_type');
 params.push(entityId);
 sets.push(`entity_id = $${params.length}`);
 touched.push('entity_id');
 }

 if (sets.length === 0) throw badRequest('No updatable fields were supplied.');

 const moved = movedTo !== null
 && new Date(movedTo).getTime() !== new Date(existing.occurred_at).getTime();

 const orgParam = params.length + 1;
 const idParam = params.length + 2;

 const updated = await scope.transaction(async (tx) => {
 const written = await tx.unsafe.query<{ id: string }>(
 `UPDATE activities SET ${sets.join(', ')}
 WHERE organization_id = $${orgParam} AND id = $${idParam} AND type = 'meeting'
 RETURNING id`,
 [...params, actor.organizationId, meetingId],
 );
 if (!written.rows[0]) throw notFound('Meeting not found.');

 const rows = await tx.query<MeetingRow>(
 `${MEETING_SELECT}
 WHERE a.organization_id = $1 AND a.id = $2 AND a.type = 'meeting'`,
 [actor.organizationId, meetingId],
 );
 const row = rows[0];
 if (!row) throw notFound('Meeting not found.');

 await auditMeeting(tx, {
 organizationId: actor.organizationId,
 actorId: actor.userId,
 actorRole: actor.role,
 action: 'activities.update',
 entityType: 'Meeting',
 entityId: meetingId,
 before: existing,
 after: row,
 metadata: { changed: touched, moved },
 ip: meta.ip,
 userAgent: meta.userAgent,
 requestId: meta.requestId,
 });

 // A move re-arms; a typo fix leaves the ledger untouched. The upsert inside
 // `scheduleEventReminders` resets `sent_at`, so a meeting moved after a
 // notice already went out earns fresh notices at the new times.
 if (moved && movedTo) {
 const dueAt = movedTo;
 await tx.bestEffort('reminder.schedule', async (s) => {
 await scheduleEventReminders(s, {
 organizationId: actor.organizationId, kind: 'meeting', id: meetingId, dueAt,
 });
 return true;
 });
 }

 return row;
 });

 securityLog('meeting.updated', {
 userId: actor.userId,
 organizationId: actor.organizationId,
 meetingId,
 moved,
 });
 return toMeeting(updated);
}

/**
 * Deletes a meeting.
 *
 * `activities.delete` is held by admin and owner only. That is stricter than
 * `tasks.delete`, which sales hold, and it is deliberate: a meeting has
 * invitees, and cancelling somebody else's appointment is not a decision this
 * matrix hands to the person who booked it. Relaxing that is a matrix change in
 * `rbac.ts`, not a change here.
 *
 * The delete is permanent rather than soft: `activities` carries no
 * `deleted_at`, the agenda has never filtered on one, and
 * `meeting_invites.meeting_id` is `ON DELETE CASCADE` -- so the invitations,
 * each invitee's inbox entry (`listMyInvites` joins the meeting) and the
 * calendar chip all disappear together.
 *
 * Pending advance notices are retired explicitly. The delivery handler would
 * no-op on a missing row anyway, but a cancelled meeting should not leave a
 * live promise to notify sitting in the ledger.
 *
 * Invitees are not notified of the cancellation. Delivered `notifications` rows
 * are immutable history and are not retracted; the honest statement is "the
 * meeting is gone from the calendar", not a retroactive fan-out. If cancellation
 * notices are wanted, that is a new notification type, not a silent side effect
 * of a DELETE.
 */
export async function deleteMeeting(
 actor: ActorRef,
 meetingIdRaw: string,
 meta: { ip?: string | null; userAgent?: string | null; requestId?: string | null } = {},
): Promise<void> {
 const meetingId = String(meetingIdRaw ?? '').trim().toLowerCase();
 if (!UUID_RE.test(meetingId)) throw notFound('Meeting not found.');

 const scope = new TenantScope(actor.organizationId);
 const existing = await loadMeetingRow(scope, actor, meetingId);

 await scope.transaction(async (tx) => {
 const removed = await tx.unsafe.query<{ id: string }>(
 `DELETE FROM activities
 WHERE organization_id = $1 AND id = $2 AND type = 'meeting'
 RETURNING id`,
 [actor.organizationId, meetingId],
 );
 if (!removed.rows[0]) throw notFound('Meeting not found.');

 await tx.bestEffort('reminder.cancel', async (s) => {
 await cancelEventReminders(s, actor.organizationId, 'meeting', meetingId);
 return true;
 });

 await auditMeeting(tx, {
 organizationId: actor.organizationId,
 actorId: actor.userId,
 actorRole: actor.role,
 action: 'activities.delete',
 entityType: 'Meeting',
 entityId: meetingId,
 before: existing,
 after: null,
 ip: meta.ip,
 userAgent: meta.userAgent,
 requestId: meta.requestId,
 });

 // The parent record's timeline keeps an honest record: the meeting is gone,
 // and the thing it was attached to should say so. Written after the delete,
 // on the parent entity, so it cannot resurrect the meeting row.
 await tx.bestEffort('activity.write', async (s) => {
 await s.unsafe.query(
 `INSERT INTO activities
 (id, organization_id, type, actor_id, entity_type, entity_id,
 subject, description, metadata, occurred_at, created_at)
 VALUES ($1,$2,'status_change',$3,$4,$5,$6,$7,$8::jsonb,now(),now())`,
 [
 newId(), actor.organizationId, actor.userId,
 existing.entity_type, existing.entity_id,
 existing.subject,
 'Meeting deleted',
 JSON.stringify({ meetingId, occurredAt: existing.occurred_at }),
 ],
 );
 return true;
 });
 });

 securityLog('meeting.deleted', {
 userId: actor.userId,
 organizationId: actor.organizationId,
 meetingId,
 });
}
