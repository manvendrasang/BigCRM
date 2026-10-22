/**
 * Audit reads, notifications, and activity feed reads.
 *
 * Writes to these tables happen elsewhere (the audit writer in the request
 * pipeline, notification creation at event sites, activity rows inside record
 * mutations). This module owns only reads plus the read-state transitions --
 * which keeps the append-only tables' write paths exactly where they are and
 * gives the new read endpoints one reviewed home.
 */
import { TenantScope } from '../repositories/base.ts';
import { notFound } from '../lib/errors.ts';
import { nowIso } from '../lib/time.ts';
import { newId } from '../lib/ids.ts';
import type { ActorRef } from './records.ts';

export type AuditFilters = {
 limit: number;
 offset: number;
 action?: string;
 entityType?: string;
 outcome?: string;
};

/** Pages the org's audit trail newest-first. Exact-match filters only. */
export async function listAuditLogs(
 actor: ActorRef,
 f: AuditFilters,
): Promise<{ items: Record<string, unknown>[]; total: number }> {
 const scope = new TenantScope(actor.organizationId);
 const clauses = ['organization_id = $1'];
 const params: unknown[] = [actor.organizationId];
 if (f.action) { params.push(f.action); clauses.push(`action = $${params.length}`); }
 if (f.entityType) { params.push(f.entityType); clauses.push(`entity_type = $${params.length}`); }
 if (f.outcome) { params.push(f.outcome); clauses.push(`outcome = $${params.length}`); }
 const where = clauses.join(' AND ');
 const totalRows = await scope.query<{ n: number }>(
 `SELECT COUNT(*)::int AS n FROM audit_logs WHERE ${where}`, params);
 // `created_at` ties are broken by id so pagination is stable: two rows in
 // the same millisecond must not swap places between pages.
 const items = await scope.query(
 `SELECT id,actor_id,actor_role,action,entity_type,entity_id,outcome,
 changed_fields,ip,user_agent,request_id,created_at
 FROM audit_logs WHERE ${where}
 ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
 [...params, f.limit, f.offset],
 );
 // `before_json`/`after_json` are deliberately excluded from the list view:
 // they can carry whole records including personal data, and the list is the
 // most-fetched view. Detail views can select them explicitly later.
 return { items: items.map(rowToAuditLog), total: totalRows[0]?.n ?? 0 };
}

export type NotificationFilters = { limit: number; offset: number; unreadOnly: boolean };

/**
 * Row mappers.
 *
 * Every other service in this codebase maps its rows to camelCase on the way
 * out (`rowToField`, `rowToView`, `rowToEndpoint`, and so on). These two reads
 * were returning the raw PostgreSQL result instead, so the audit viewer and the
 * notifications page rendered blank columns and `Invalid Date`: the fields were
 * there, under snake_case names no client reads.
 *
 * It typechecked and linted cleanly, because the return type was the permissive
 * `Record<string, unknown>`. The mismatch only shows when a browser renders it.
 */
const rowToAuditLog = (r: Record<string, unknown>): Record<string, unknown> => ({
 id: r['id'],
 actorId: r['actor_id'],
 actorRole: r['actor_role'],
 action: r['action'],
 entityType: r['entity_type'],
 entityId: r['entity_id'],
 outcome: r['outcome'],
 changedFields: r['changed_fields'],
 ip: r['ip'],
 userAgent: r['user_agent'],
 requestId: r['request_id'],
 createdAt: r['created_at'],
});

const rowToNotification = (r: Record<string, unknown>): Record<string, unknown> => ({
 id: r['id'],
 type: r['type'],
 title: r['title'],
 body: r['body'],
 link: r['link'],
 entityType: r['entity_type'],
 entityId: r['entity_id'],
 readAt: r['read_at'],
 createdAt: r['created_at'],
});

/** The caller's own notifications in this org, newest first. */
export async function listNotifications(
 actor: ActorRef,
 f: NotificationFilters,
): Promise<Record<string, unknown>[]> {
 const scope = new TenantScope(actor.organizationId);
 const unread = f.unreadOnly ? 'AND read_at IS NULL' : '';
 const rows = await scope.query(
 `SELECT id,type,title,body,link,entity_type,entity_id,read_at,created_at
 FROM notifications
 WHERE organization_id = $1 AND user_id = $2 ${unread}
 ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
 [actor.organizationId, actor.userId, f.limit, f.offset],
 );
 return rows.map(rowToNotification);
}

export async function unreadNotificationCount(actor: ActorRef): Promise<number> {
 const scope = new TenantScope(actor.organizationId);
 const rows = await scope.query<{ n: number }>(
 `SELECT COUNT(*)::int AS n FROM notifications
 WHERE organization_id = $1 AND user_id = $2 AND read_at IS NULL`,
 [actor.organizationId, actor.userId],
 );
 return rows[0]?.n ?? 0;
}

/**
 * Marks one notification read. Scoped to org AND user: another user's row is
 * unaddressable, so it 404s rather than confirming its existence.
 */
export async function markNotificationRead(actor: ActorRef, id: string): Promise<void> {
 const scope = new TenantScope(actor.organizationId);
 const r = await scope.query(
 `UPDATE notifications SET read_at = $4
 WHERE organization_id = $1 AND user_id = $2 AND id = $3 AND read_at IS NULL
 RETURNING id`,
 [actor.organizationId, actor.userId, id, nowIso()],
 );
 if (r.length === 0) {
 // Either nonexistent, another user's, or already read -- all three are "not
 // an unread notification of yours", so one 404 covers them without
 // distinguishing which.
 throw notFound('Notification not found.');
 }
}

export async function markAllNotificationsRead(actor: ActorRef): Promise<number> {
 const scope = new TenantScope(actor.organizationId);
 const r = await scope.query(
 `UPDATE notifications SET read_at = $3
 WHERE organization_id = $1 AND user_id = $2 AND read_at IS NULL
 RETURNING id`,
 [actor.organizationId, actor.userId, nowIso()],
 );
 return r.length;
}

/** Creates a notification. Used by event sites (invitations, assignments, imports). */
export async function createNotification(
 actor: { organizationId: string },
 input: {
 userId: string; type: string; title: string; body?: string;
 link?: string; entityType?: string; entityId?: string;
 },
): Promise<string> {
 const { getDb } = await import('../db/driver.ts');
 const { newId } = await import('../lib/ids.ts');
 const db = await getDb();
 const title = input.title.trim().slice(0, 200);
 if (!title) throw new Error('Notification title is required.');
 const id = newId();
 await db.query(
 `INSERT INTO notifications
 (id,organization_id,user_id,type,title,body,link,entity_type,entity_id,created_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
 [id, actor.organizationId, input.userId, input.type.slice(0, 80), title,
 (input.body ?? '').slice(0, 2000), input.link?.slice(0, 500) ?? null,
 input.entityType ?? null, input.entityId ?? null, nowIso()],
 );
 return id;
}

/** What every fan-out carries, whatever its audience. */
export interface NotificationFanout {
  type: string; title: string; body?: string; link?: string;
  entityType?: string; entityId?: string;
}

/** Live members of this workspace, optionally without one of them. */
async function liveMemberIds(
  scope: TenantScope,
  organizationId: string,
  excludeUserId?: string,
): Promise<string[]> {
  const sql = `SELECT m.user_id FROM organization_members m
  JOIN users u ON u.id = m.user_id
  WHERE m.organization_id = $1 AND u.deleted_at IS NULL
  ${excludeUserId ? 'AND m.user_id <> $2' : ''}`;
  const rows = await scope.query<{ user_id: string }>(
    sql,
    excludeUserId ? [organizationId, excludeUserId] : [organizationId],
  );
  return rows.map((r) => String(r.user_id));
}

/** One INSERT per recipient. The fan-out's only write path. */
async function insertNotifications(
  scope: TenantScope,
  organizationId: string,
  recipientIds: readonly string[],
  input: NotificationFanout,
): Promise<number> {
  const title = input.title.trim().slice(0, 200);
  if (!title) return 0;

  const body = (input.body ?? '').slice(0, 2000);
  const link = input.link?.slice(0, 500) ?? null;
  const type = input.type.slice(0, 80);
  const entityType = input.entityType ?? null;
  const entityId = input.entityId ?? null;

  for (const userId of recipientIds) {
  await scope.unsafe.query(
  `INSERT INTO notifications
  (id,organization_id,user_id,type,title,body,link,entity_type,entity_id,created_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [newId(), organizationId, userId, type, title, body, link,
  entityType, entityId, nowIso()],
  );
  }
  return recipientIds.length;
}

/**
 * Fan a calendar event out to the whole workspace.
 *
 * A task or a meeting that lands on the shared calendar is visible work, so
 * every member is told about it -- except the person who created it. They
 * already know; a notification to yourself is noise.
 *
 * Written against a `TenantScope` so the call site can run it inside the same
 * transaction as the event itself: either both land or neither does.
 */
export async function notifyOrgMembers(
  scope: TenantScope,
  actor: { organizationId: string; userId: string },
  input: NotificationFanout,
): Promise<number> {
  const recipients = await liveMemberIds(scope, actor.organizationId, actor.userId);
  return insertNotifications(scope, actor.organizationId, recipients, input);
}

/**
 * Fan a notification out to every member of the workspace, whatever their
 * role, and including whoever caused it.
 *
 * The create-time fan-out above deliberately skips its own author; a due
 * reminder does not. "It is due in an hour" is a fact about the work rather
 * than a reaction to somebody's action, and the person who booked the meeting
 * is exactly as likely to be the one running late for it.
 */
export async function notifyAllMembers(
  scope: TenantScope,
  organizationId: string,
  input: NotificationFanout,
): Promise<number> {
  const recipients = await liveMemberIds(scope, organizationId);
  return insertNotifications(scope, organizationId, recipients, input);
}

/** Record timeline: activities on one entity, newest first. Powers the detail-page history. */
const rowToActivity = (r: Record<string, unknown>): Record<string, unknown> => ({
 id: r['id'],
 type: r['type'],
 actorId: r['actor_id'],
 subject: r['subject'],
 description: r['description'],
 occurredAt: r['occurred_at'],
 createdAt: r['created_at'],
});

export async function listActivities(
 actor: ActorRef,
 entityType: string,
 entityId: string,
 limit = 50,
): Promise<Record<string, unknown>[]> {
 const scope = new TenantScope(actor.organizationId);
 const rows = await scope.query(
 `SELECT id,type,actor_id,subject,description,occurred_at,created_at
 FROM activities
 WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3
 ORDER BY occurred_at DESC, id DESC LIMIT $4`,
 [actor.organizationId, entityType, entityId, Math.min(Math.max(limit, 1), 200)],
 );
 return rows.map(rowToActivity);
}
