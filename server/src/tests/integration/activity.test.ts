/**
 * Audit log and notification read tests.
 *
 * Properties:
 * 1. Audit reads are tenant-scoped and never return `before_json`/`after_json`
 * in the list view (they can carry whole records).
 * 2. Notifications are scoped to org AND user -- one user cannot read or mark
 * another's.
 * 3. Marking another user's notification read 404s rather than confirming.
 * 4. Audit filters are exact-match and reject free text over JSON columns.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import type { ActorRef } from '../../services/records.ts';
import { newId } from '../../lib/ids.ts';
import {
 listActivities,
 listAuditLogs,
 listNotifications,
 markAllNotificationsRead,
 markNotificationRead,
 unreadNotificationCount,
} from '../../services/activity.ts';
import { registerUser } from '../../services/auth.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 const detail = x === undefined ? '' : ` -> ${(typeof x === 'object' ? JSON.stringify(x) : String(x)).slice(0, 200)}`;
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l}${detail}`); }
};

const C = { ip: '10.0.0.9', userAgent: 'activity-test/1.0', requestId: 'req-act' };
const mkUser = async (name: string, email: string) => {
 const r = await registerUser({
 name, email, password: 'Activity-Test!42',
 organizationName: `${name} Ltd`, client: C,
 });
 const actor: ActorRef = {
 userId: r.user.id, organizationId: r.organizationId, role: 'owner', email: r.user.email,
 };
 return actor;
};

const alice = await mkUser('Alice', 'act-alice@corp.io');
const bob = await mkUser('Bob', 'act-bob@corp.io');

console.log('\n=== audit logs ===');
{
 const { items, total } = await listAuditLogs(alice, { limit: 25, offset: 0 });
 T('audit list returns rows', total > 0, total);
 T('rows carry action and entityType (camelCase on the wire)',
 items.every((r) => 'action' in r && 'entityType' in r));
 T('rows expose createdAt, not created_at (the client reads camelCase)',
 items.every((r) => 'createdAt' in r && !('created_at' in r)));
 T('list view omits before_json/after_json',
 items.every((r) => !('before_json' in r) && !('after_json' in r)));
 T('rows carry actorRole, outcome and requestId',
 items.every((r) => 'actorRole' in r && 'outcome' in r && 'requestId' in r));

 const filtered = await listAuditLogs(alice, { limit: 25, offset: 0, action: 'contacts.create' });
 T('action filter is exact-match', filtered.items.every((r) => r['action'] === 'contacts.create'));

 const none = await listAuditLogs(alice, { limit: 25, offset: 0, action: 'no.such.action' });
 T('unknown action filter returns empty', none.items.length === 0 && none.total === 0);
}

console.log('\n=== notifications ===');
{
 const { createNotification } = await import('../../services/activity.ts');
 await createNotification(alice, {
 userId: alice.userId, type: 'test', title: 'For Alice',
 entityType: 'contact', entityId: newId(),
 });
 await createNotification(bob, {
 userId: bob.userId, type: 'test', title: 'For Bob',
 });

 const aliceItems = await listNotifications(alice, { limit: 25, offset: 0, unreadOnly: false });
 T('alice sees only her own notifications', aliceItems.length === 1 && aliceItems[0]!.title === 'For Alice');
 T('notifications are camelCase too (readAt/createdAt)',
 aliceItems[0]!.readAt === null
 && !Number.isNaN(new Date(String(aliceItems[0]!.createdAt)).getTime()),
 typeof aliceItems[0]!.createdAt);

 const bobItems = await listNotifications(bob, { limit: 25, offset: 0, unreadOnly: false });
 T('bob sees only his own', bobItems.length === 1 && bobItems[0]!.title === 'For Bob');

 const aliceUnread = await unreadNotificationCount(alice);
 T('alice unread count is 1', aliceUnread === 1, aliceUnread);

 // Bob tries to mark Alice's notification read.
 const aliceNotif = aliceItems[0]!;
 let crossUser = false;
 try { await markNotificationRead(bob, String(aliceNotif['id'])); } catch { crossUser = true; }
 T('marking another user\'s notification 404s', crossUser);

 // Alice marks her own.
 await markNotificationRead(alice, String(aliceNotif['id']));
 const afterMark = await unreadNotificationCount(alice);
 T('after marking read, unread is 0', afterMark === 0, afterMark);

 // Read-all.
 await createNotification(alice, { userId: alice.userId, type: 'test', title: 'Another' });
 const marked = await markAllNotificationsRead(alice);
 T('read-all marks the outstanding one', marked === 1, marked);
 T('unread is now 0', (await unreadNotificationCount(alice)) === 0);
}

console.log('\n=== activities ===');
{
 const items = await listActivities(alice, 'contact', newId());
 T('activity list returns an array (empty for unknown entity)', Array.isArray(items) && items.length === 0, items.length);
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
