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
