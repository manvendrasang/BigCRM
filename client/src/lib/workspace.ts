/**
 * Client API for saved views, calendar, notifications and audit reads.
 *
 * Same shape as `lib/item8.ts`: thin wrappers over `api.get/post/del` with
 * server-side envelope handling. Uploads and imports use raw `fetch` because
 * the body is not JSON, but still attach the CSRF header the same way.
 */
import { api } from './api';

//  saved views 

export interface SavedViewRow {
 id: string;
 name: string;
 entityType: string;
 isShared: boolean;
 ownerId: string | null;
}

export async function listViews(entityType?: string): Promise<SavedViewRow[]> {
 const qs = entityType ? `?entityType=${encodeURIComponent(entityType)}` : '';
 const body = await api.get<unknown>(`/views${qs}`);
 return Array.isArray(body) ? (body as SavedViewRow[]) : [];
}

export async function createView(input: {
 name: string;
 entityType: string;
 isShared?: boolean;
 filters?: Record<string, unknown>;
 sort?: Record<string, unknown>;
 columns?: string[];
}): Promise<SavedViewRow> {
 return api.post<SavedViewRow>('/views', input);
}

export async function deleteView(id: string): Promise<void> {
 await api.del(`/views/${encodeURIComponent(id)}`);
}

//  notifications 

export interface NotificationRow {
 id: string;
 type: string;
 title: string;
 body: string;
 link: string | null;
 readAt: string | null;
 createdAt: string;
}

export interface NotificationList {
 items: NotificationRow[];
 unread: number;
}

export async function listNotifications(unreadOnly = false): Promise<NotificationList> {
 const qs = unreadOnly ? '?unread=true' : '';
 const body = await api.get<unknown>(`/notifications${qs}`);
 if (typeof body !== 'object' || body === null || !('items' in body)) {
 return { items: [], unread: 0 };
 }
 return body as unknown as NotificationList;
}

export async function markNotificationRead(id: string): Promise<void> {
 await api.post(`/notifications/${encodeURIComponent(id)}/read`);
}

export async function markAllNotificationsRead(): Promise<{ marked: number }> {
 const body = await api.post<{ data: { marked: number } }>('/notifications/read-all');
 return body.data;
}

//  audit logs 

export interface AuditRow {
 id: string;
 action: string;
 entityType: string;
 entityId: string | null;
 outcome: string;
 changedFields: string[];
 ip: string | null;
 userAgent: string | null;
 requestId: string | null;
 createdAt: string;
}

export async function listAuditLogs(filters: {
 limit?: number;
 offset?: number;
 action?: string;
 entityType?: string;
 outcome?: string;
} = {}): Promise<{ items: AuditRow[]; total: number }> {
 const params = new URLSearchParams();
 params.set('limit', String(filters.limit ?? 25));
 params.set('offset', String(filters.offset ?? 0));
 if (filters.action) params.set('action', filters.action);
 if (filters.entityType) params.set('entityType', filters.entityType);
 if (filters.outcome) params.set('outcome', filters.outcome);
 const body = await api.get<unknown>(`/org/audit-logs?${params.toString()}`);
 // `api.get` already unwraps the outer `{ data: ... }` envelope, so this sees
 // `{ items, total }` directly. Unwrapping a second time yields an empty log
 // with no error -- the page simply renders "no entries match" forever -- so the
 // shape is checked rather than assumed.
 if (typeof body !== 'object' || body === null || !('items' in body)) {
 return { items: [], total: 0 };
 }
 return body as unknown as { items: AuditRow[]; total: number };
}

//  activities 

export interface ActivityRow {
 id: string;
 type: string;
 actorId: string | null;
 subject: string | null;
 description: string | null;
 occurredAt: string;
 createdAt: string;
}

/**
 * Timeline for one record, newest first. The endpoint returns a bare array
 * (not an `{ items }` envelope), so anything else degrades to an empty
 * timeline rather than a crash inside the detail page.
 */
export async function listActivities(entityType: string, entityId: string): Promise<ActivityRow[]> {
 const body = await api.get<unknown>(
 `/activities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
 );
 return Array.isArray(body) ? (body as ActivityRow[]) : [];
}

//  calendar 

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

const emptyAgenda = (from: string, to: string): CalendarAgenda => ({ from, to, meetings: [], tasks: [] });

export async function getCalendar(from: string, to: string): Promise<CalendarAgenda> {
 const body = await api.get<unknown>(
 `/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
 );
 if (typeof body !== 'object' || body === null) return emptyAgenda(from, to);
 const b = body as Partial<CalendarAgenda>;
 return {
 from: typeof b.from === 'string' ? b.from : from,
 to: typeof b.to === 'string' ? b.to : to,
 meetings: Array.isArray(b.meetings) ? b.meetings : [],
 tasks: Array.isArray(b.tasks) ? b.tasks : [],
 };
}

export async function scheduleMeeting(input: {
 entityType: string;
 entityId: string;
 occurredAt: string;
 subject: string;
 description?: string;
}): Promise<CalendarMeeting> {
 return api.post<CalendarMeeting>('/calendar/meetings', input);
}

export interface MeetingInvitee {
 id: string;
 name: string;
 email: string;
}

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

export async function listInvitees(): Promise<MeetingInvitee[]> {
 const body = await api.get<unknown>('/calendar/invitees');
 return Array.isArray(body) ? (body as MeetingInvitee[]) : [];
}

export async function inviteToMeeting(meetingId: string, userIds: string[]): Promise<InviteResult> {
 const body = await api.post<unknown>(`/calendar/meetings/${encodeURIComponent(meetingId)}/invite`, { userIds });
 if (typeof body !== 'object' || body === null) return { invited: [], alreadyInvited: [] };
 const b = body as Partial<InviteResult>;
 return {
 invited: Array.isArray(b.invited) ? b.invited : [],
 alreadyInvited: Array.isArray(b.alreadyInvited) ? b.alreadyInvited : [],
 };
}

export async function respondToInvite(inviteId: string, status: 'accepted' | 'declined'): Promise<MeetingInvite> {
 return api.post<MeetingInvite>(`/calendar/invites/${encodeURIComponent(inviteId)}/respond`, { status });
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

export async function listMyInvites(status?: 'invited' | 'accepted' | 'declined'): Promise<MyInvite[]> {
 const qs = status ? `?status=${encodeURIComponent(status)}` : '';
 const body = await api.get<unknown>(`/calendar/invites${qs}`);
 return Array.isArray(body) ? (body as MyInvite[]) : [];
}

export interface MemberRow {
 userId: string;
 email: string;
 name: string;
 role: string;
 status: string;
 mfaEnabled: boolean;
 lastLoginAt: string | null;
 /** Whether THIS signed-in actor may set this member's password. Server-decided. */
 canResetPassword: boolean;
 /** An open reset request from this member, if any. Drives the roster badge. */
 passwordResetRequested: boolean;
}

export interface CreatedMember {
 user: { id: string; email: string; name: string; emailVerified: boolean; mfaEnabled: boolean };
 membershipRole: string;
 generatedPassword: string;
}

export async function listMembers(): Promise<MemberRow[]> {
 const body = await api.get<unknown>('/org/members');
 return Array.isArray(body) ? (body as MemberRow[]) : [];
}

export interface RoleOptions {
 assignable: string[];
 hierarchy: string[];
 note?: string;
}

/**
 * Roles the current actor may grant. The server combines permission
 * (`users.invite`) with the rank rule, so the client does not restate RBAC --
 * an empty `assignable` means the actor may not create members at all.
 */
export async function listAssignableRoles(): Promise<RoleOptions> {
 const body = await api.get<unknown>('/org/roles');
 if (typeof body !== 'object' || body === null) return { assignable: [], hierarchy: [] };
 const b = body as Partial<RoleOptions>;
 return {
 assignable: Array.isArray(b.assignable) ? b.assignable : [],
 hierarchy: Array.isArray(b.hierarchy) ? b.hierarchy : [],
 note: typeof b.note === 'string' ? b.note : undefined,
 };
}

/**
 * In-house member creation. The generated password is returned once by the
 * server and never again -- it is the admin's job to deliver it. Copy it now:
 * closing this panel loses it.
 */
export async function createMember(input: {
 email: string;
 role: string;
 name?: string;
}): Promise<CreatedMember> {
 return api.post<CreatedMember>('/org/members', input);
}

export interface PasswordResetRequestResult {
 requestId: string;
 requestedAt: string;
 /** How many owners/admins were notified. 0 when an open request already existed. */
 notified: number;
}

/**
 * A member asks the office to set a new password. The request lands in the
 * notifications of every owner/admin, who then set the password by hand.
 * Idempotent while a request is open.
 */
export async function requestPasswordReset(): Promise<PasswordResetRequestResult> {
 return api.post<PasswordResetRequestResult>('/org/members/password-reset-request');
}

/**
 * An owner/admin sets a member's password directly. `password` is typed by the
 * human handling the request (the UI collects it twice; the server validates a
 * single value). On success the member's sessions are revoked.
 */
export async function resetMemberPassword(
 userId: string,
 password: string,
): Promise<{ userId: string; sessionsRevoked: number }> {
 return api.post<{ userId: string; sessionsRevoked: number }>(
 `/org/members/${encodeURIComponent(userId)}/password`,
 { password },
 );
}
