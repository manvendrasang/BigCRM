/**
 * Workspace client tests (saved views, calendar, notifications, audit).
 *
 * These lock in the response unwrapping, which is where this module could
 * quietly go wrong: the audit endpoint returns a double envelope
 * (`{ data: { items, total } }`) while the list endpoints return a bare array.
 * Getting either wrong yields a page that renders empty without ever throwing,
 * which is the failure mode most likely to reach production unnoticed.
 *
 * They also pin the degradation path -- a malformed or unexpected body must
 * produce an empty list, not a crash inside a render.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
 createMember,
 getCalendar,
 inviteToMeeting,
 listActivities,
 listAssignableRoles,
 listAuditLogs,
 listInvitees,
 listMembers,
 listMyInvites,
 listNotifications,
 listViews,
 deleteView,
 respondToInvite,
 scheduleMeeting,
} from './workspace';
import { resetApiClient, setFetchImplementation } from './api';

afterEach(() => {
 resetApiClient();
 vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
 return new Response(JSON.stringify(body), {
 status,
 headers: { 'content-type': 'application/json' },
 });
}

describe('listAuditLogs', () => {
 it('unwraps the nested items/total envelope', async () => {
 setFetchImplementation(async () =>
 jsonResponse({
 data: {
 items: [
 { id: '1', action: 'contacts.create', entityType: 'contact', outcome: 'success' },
 ],
 total: 1,
 },
 }),
 );

 const result = await listAuditLogs();

 expect(result.total).toBe(1);
 expect(result.items).toHaveLength(1);
 expect(result.items[0]!.action).toBe('contacts.create');
 });

 it('sends limit, offset and the filters it was given', async () => {
 const seen: string[] = [];
 setFetchImplementation(async (url) => {
 seen.push(url);
 return jsonResponse({ data: { items: [], total: 0 } });
 });

 await listAuditLogs({ limit: 10, offset: 20, action: 'contacts.create', outcome: 'failure' });

 expect(seen[0]).toContain('limit=10');
 expect(seen[0]).toContain('offset=20');
 expect(seen[0]).toContain('action=contacts.create');
 expect(seen[0]).toContain('outcome=failure');
 });

 it('omits blank filters rather than sending empty strings', async () => {
 const seen: string[] = [];
 setFetchImplementation(async (url) => {
 seen.push(url);
 return jsonResponse({ data: { items: [], total: 0 } });
 });

 await listAuditLogs({ action: '', outcome: undefined });

 expect(seen[0]).not.toContain('action=');
 expect(seen[0]).not.toContain('outcome=');
 });

 it('degrades to an empty page when the envelope is not the expected shape', async () => {
 setFetchImplementation(async () => jsonResponse({ data: { nope: true } }));

 const result = await listAuditLogs();

 expect(result.items).toEqual([]);
 expect(result.total).toBe(0);
 });

 it('degrades to an empty page when the body is not an object', async () => {
 setFetchImplementation(async () => jsonResponse('unexpected'));

 const result = await listAuditLogs();

 expect(result.items).toEqual([]);
 expect(result.total).toBe(0);
 });
});

describe('listNotifications', () => {
 it('returns items and the unread count', async () => {
 setFetchImplementation(async () =>
 jsonResponse({ items: [{ id: 'n1', title: 'Lead assigned', readAt: null }], unread: 3 }),
 );

 const result = await listNotifications();

 expect(result.items).toHaveLength(1);
 expect(result.unread).toBe(3);
 });

 it('requests only unread when asked', async () => {
 const seen: string[] = [];
 setFetchImplementation(async (url) => {
 seen.push(url);
 return jsonResponse({ items: [], unread: 0 });
 });

 await listNotifications(true);

 expect(seen[0]).toContain('unread=true');
 });

 it('degrades to an empty list on an unexpected shape', async () => {
 setFetchImplementation(async () => jsonResponse([]));

 const result = await listNotifications();

 expect(result.items).toEqual([]);
 expect(result.unread).toBe(0);
 });
});

describe('listActivities', () => {
 it('returns the bare array the timeline endpoint sends', async () => {
 setFetchImplementation(async () =>
 jsonResponse([
 { id: 'a1', type: 'created', subject: 'Contact', occurredAt: '2026-10-01T00:00:00Z' },
 ]),
 );

 const rows = await listActivities('contact', 'c1');

 expect(rows).toHaveLength(1);
 expect(rows[0]!.type).toBe('created');
 });

 it('URL-encodes the entity type and id', async () => {
 const seen: string[] = [];
 setFetchImplementation(async (url) => {
 seen.push(url);
 return jsonResponse([]);
 });

 await listActivities('deal', 'id with/slash');

 expect(seen[0]).toContain('/activities/deal/id%20with%2Fslash');
 });

 it('degrades to an empty timeline when the body is not an array', async () => {
 setFetchImplementation(async () => jsonResponse({ items: [] }));

 await expect(listActivities('contact', 'c1')).resolves.toEqual([]);
 });
});

describe('getCalendar', () => {
 it('passes the range through and returns both sources', async () => {
 const seen: string[] = [];
 setFetchImplementation(async (url) => {
 seen.push(url);
 return jsonResponse({
 data: {
 from: '2026-11-01T00:00:00.000Z',
 to: '2026-12-01T00:00:00.000Z',
 meetings: [{ id: 'm1', subject: 'Kickoff' }],
 tasks: [{ id: 't1', title: 'Proposal' }],
 },
 });
 });

 const agenda = await getCalendar('2026-11-01', '2026-12-01');

 expect(seen[0]).toContain('from=2026-11-01');
 expect(seen[0]).toContain('to=2026-12-01');
 expect(agenda.meetings).toHaveLength(1);
 expect(agenda.tasks).toHaveLength(1);
 });

 it('degrades to an empty agenda on an unexpected shape', async () => {
 setFetchImplementation(async () => jsonResponse([]));

 await expect(getCalendar('2026-11-01', '2026-12-01')).resolves.toEqual({
 from: '2026-11-01',
 to: '2026-12-01',
 meetings: [],
 tasks: [],
 });
 });
});

describe('scheduleMeeting', () => {
 it('posts the meeting and returns it', async () => {
 const seen: { url: string; body: unknown }[] = [];
 setFetchImplementation(async (url, init) => {
 seen.push({ url, body: (init as { body?: unknown })?.body });
 return jsonResponse({ data: { id: 'm1', subject: 'Kickoff' } });
 });

 const created = await scheduleMeeting({
 entityType: 'contact',
 entityId: 'c1',
 occurredAt: '2026-11-15T10:00:00Z',
 subject: 'Kickoff',
 });

 expect(seen[0]!.url).toContain('/calendar/meetings');
 expect(created.id).toBe('m1');
 });
});

describe('meeting invitations', () => {
 it('lists invitees as a bare array', async () => {
 setFetchImplementation(async () =>
 jsonResponse([{ id: 'u1', name: 'Ava', email: 'ava@corp.io' }]),
 );

 const dir = await listInvitees();

 expect(dir).toHaveLength(1);
 expect(dir[0]!.email).toBe('ava@corp.io');
 });

 it('degrades to an empty directory on an unexpected shape', async () => {
 setFetchImplementation(async () => jsonResponse({ nope: true }));

 await expect(listInvitees()).resolves.toEqual([]);
 });

 it('posts invites URL-encoded and returns both lists', async () => {
 const seen: string[] = [];
 setFetchImplementation(async (url) => {
 seen.push(url);
 return jsonResponse({ data: { invited: [{ id: 'i1' }], alreadyInvited: ['u9'] } });
 });

 const result = await inviteToMeeting('m 1', ['u1']);

 expect(seen[0]).toContain('/calendar/meetings/m%201/invite');
 expect(result.invited).toHaveLength(1);
 expect(result.alreadyInvited).toEqual(['u9']);
 });

 it('degrades to empty lists on an unexpected shape', async () => {
 setFetchImplementation(async () => jsonResponse([]));

 await expect(inviteToMeeting('m1', ['u1'])).resolves.toEqual({ invited: [], alreadyInvited: [] });
 });

 it('answers an invite', async () => {
 setFetchImplementation(async () =>
 jsonResponse({ data: { id: 'i1', status: 'accepted' } }),
 );

 const invite = await respondToInvite('i1', 'accepted');

 expect(invite.status).toBe('accepted');
 });

 it('lists my invites, filtered by status', async () => {
 const seen: string[] = [];
 setFetchImplementation(async (url) => {
 seen.push(url);
 return jsonResponse([{ id: 'i1', status: 'invited', subject: 'Kickoff' }]);
 });

 const invites = await listMyInvites('invited');

 expect(seen[0]).toContain('/calendar/invites?status=invited');
 expect(invites).toHaveLength(1);
 expect(invites[0]!.subject).toBe('Kickoff');
 });

 it('degrades to an empty inbox on an unexpected shape', async () => {
 setFetchImplementation(async () => jsonResponse({ nope: true }));

 await expect(listMyInvites()).resolves.toEqual([]);
 });
});

describe('listViews', () => {
 it('returns the bare array the endpoint sends', async () => {
 setFetchImplementation(async () =>
 jsonResponse([{ id: 'v1', name: 'Hot leads', entityType: 'leads', isShared: false }]),
 );

 const views = await listViews('leads');

 expect(views).toHaveLength(1);
 expect(views[0]!.name).toBe('Hot leads');
 });

 it('passes the entity type through, URL-encoded', async () => {
 const seen: string[] = [];
 setFetchImplementation(async (url) => {
 seen.push(url);
 return jsonResponse([]);
 });

 await listViews('pipeline stages');

 expect(seen[0]).toContain('entityType=pipeline%20stages');
 });

 it('degrades to an empty list when the body is not an array', async () => {
 setFetchImplementation(async () => jsonResponse({ items: [] }));

 expect(await listViews()).toEqual([]);
 });
});

describe('deleteView', () => {
 it('URL-encodes the id rather than interpolating it raw', async () => {
 const seen: string[] = [];
 setFetchImplementation(async (url) => {
 seen.push(url);
 return jsonResponse({});
 });

 await deleteView('id with/slash');

 expect(seen[0]).toContain('id%20with%2Fslash');
 });

 it('propagates a delete failure instead of reporting success', async () => {
 setFetchImplementation(async () =>
 jsonResponse({ error: { message: 'Saved view not found.' } }, 404),
 );

 await expect(deleteView('v1')).rejects.toThrow();
 });
});

describe('members', () => {
 it('lists the roster as the bare array the endpoint sends', async () => {
  setFetchImplementation(async () =>
  jsonResponse([{
   user_id: 'u1', email: 'ava@corp.io', name: 'Ava', role: 'sales', status: 'active',
   joined_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
   mfa_enabled: true, email_verified_at: '2026-01-01T00:00:00Z',
   last_login_at: '2026-02-02T10:00:00Z', locked_until: null,
   canResetPassword: true, passwordResetRequested: true,
  }]),
  );

  const rows = await listMembers();

  expect(rows).toHaveLength(1);
  expect(rows[0]!.role).toBe('sales');
 });

 it('renames the snake_case columns the server actually sends', async () => {
  // The endpoint SELECTs from `organization_members` JOIN `users`, so the
  // multi-word columns arrive snake_case. Getting this wrong made
  // `resetMemberPassword` post to `/org/members/undefined/password` and
  // rendered every MFA cell as "Off" -- while the single-word columns still
  // looked right, so the bug hid behind a plausible roster.
  setFetchImplementation(async () =>
  jsonResponse([{
   user_id: 'u1', email: 'ava@corp.io', name: 'Ava', role: 'sales', status: 'active',
   mfa_enabled: true, last_login_at: '2026-02-02T10:00:00Z',
   canResetPassword: true, passwordResetRequested: true,
  }]),
  );

  const [row] = await listMembers();

  expect(row!.userId).toBe('u1');
  expect(row!.mfaEnabled).toBe(true);
  expect(row!.lastLoginAt).toBe('2026-02-02T10:00:00Z');
  expect(row!.canResetPassword).toBe(true);
  expect(row!.passwordResetRequested).toBe(true);
 });

 it('defaults absent booleans to false rather than leaving them undefined', async () => {
  setFetchImplementation(async () => jsonResponse([{ user_id: 'u2', email: 'bo@corp.io' }]));

  const [row] = await listMembers();

  expect(row!.userId).toBe('u2');
  expect(row!.mfaEnabled).toBe(false);
  expect(row!.canResetPassword).toBe(false);
  expect(row!.passwordResetRequested).toBe(false);
  expect(row!.lastLoginAt).toBeNull();
 });

 it('degrades to an empty roster on an unexpected shape', async () => {
  setFetchImplementation(async () => jsonResponse({ nope: true }));

  await expect(listMembers()).resolves.toEqual([]);
 });

 it('unwraps the role matrix the create form is built from', async () => {
  setFetchImplementation(async () =>
  jsonResponse({ data: { assignable: ['manager', 'sales', 'viewer'], hierarchy: ['owner', 'admin'], note: 'use transfer-ownership' } }),
  );

  const roles = await listAssignableRoles();

  expect(roles.assignable).toEqual(['manager', 'sales', 'viewer']);
  expect(roles.hierarchy).toContain('owner');
  expect(roles.note).toContain('transfer-ownership');
 });

 it('degrades to "no assignable roles" on an unexpected shape', async () => {
  setFetchImplementation(async () => jsonResponse([]));

  await expect(listAssignableRoles()).resolves.toEqual({ assignable: [], hierarchy: [] });
 });

 it('posts the new member and returns the one-time password', async () => {
  const seen: { url: string; method: string; body: unknown }[] = [];
  setFetchImplementation(async (url, init) => {
  seen.push({ url, method: String((init as { method?: string })?.method), body: JSON.parse(String((init as { body?: string })?.body)) });
  return jsonResponse({ data: { user: { id: 'u9', email: 'new@corp.io' }, membershipRole: 'sales', generatedPassword: 'GENERATED-PASS-VALUE' } });
  });

  const created = await createMember({ email: 'new@corp.io', role: 'sales', name: 'New Hire' });

  expect(seen[0]!.url).toContain('/org/members');
  expect(seen[0]!.method).toBe('POST');
  expect(seen[0]!.body).toEqual({ email: 'new@corp.io', role: 'sales', name: 'New Hire' });
  expect(created.generatedPassword).toBe('GENERATED-PASS-VALUE');
 });
});
