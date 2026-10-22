/**
 * Notifications page.
 *
 * Lists the caller's own notifications with an unread badge, and offers
 * mark-one-read and mark-all-read. The unread count is also surfaced in the
 * header via a badge on the nav link.
 *
 * A notification that names a calendar event opens the shared event window --
 * the same component, and the same read, as a calendar chip. Everything else
 * follows its stored link.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import {
 listNotifications,
 markAllNotificationsRead,
 markNotificationRead,
} from '../lib/workspace';
import type { NotificationRow } from '../lib/workspace';
import { EmptyState } from '../components/ui';
import { CalendarEventModal } from '../components/CalendarEventModal';
import type { CalendarEventTarget } from '../components/CalendarEventModal';

/**
 * A notification that names a calendar event opens the shared event window
 * instead of navigating. Meeting invites and the calendar-task /
 * calendar-meeting fan-outs all carry `entityType` + `entityId`, so they all
 * land in the same window the calendar chip opens.
 */
const eventTargetOf = (n: NotificationRow): CalendarEventTarget | null => {
  if (!n.entityId) return null;
  if (n.entityType === 'meeting') return { kind: 'meeting', id: n.entityId };
  if (n.entityType === 'task') return { kind: 'task', id: n.entityId };
  return null;
};

export function Notifications(): JSX.Element {
 const [items, setItems] = useState<NotificationRow[]>([]);
 const [unread, setUnread] = useState(0);
 const [error, setError] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const [eventTarget, setEventTarget] = useState<CalendarEventTarget | null>(null);

 const load = useCallback(async () => {
 try {
 const result = await listNotifications(false);
 setItems(result.items);
 setUnread(result.unread);
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not load notifications.');
 }
 }, []);

 useEffect(() => {
 void load();
 }, [load]);

 async function markOne(id: string): Promise<void> {
 try {
 await markNotificationRead(id);
 await load();
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not mark as read.');
 }
 }

 async function markAll(): Promise<void> {
 setBusy(true);
 try {
 await markAllNotificationsRead();
 await load();
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not mark all as read.');
 } finally {
 setBusy(false);
 }
 }

 return (
 <div className="enter">
 <h1>Notifications</h1>
 <p className="muted">
 {unread === 0 ? 'No unread notifications.' : `${unread} unread.`}
 </p>

 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}

 {unread > 0 && (
 <div className="toolbar">
 <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { void markAll(); }}>
 {busy ? 'Marking...' : 'Mark all as read'}
 </button>
 </div>
 )}

 {items.length === 0 ? (
 <EmptyState message="Nothing here." />
 ) : (
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 <th scope="col">Title</th>
 <th scope="col">Type</th>
 <th scope="col">Received</th>
 <th scope="col">Status</th>
 <th scope="col">Actions</th>
 </tr>
 </thead>
 <tbody>
 {items.map((n) => (
 <tr key={n.id}>
 {/* A notification that names a calendar event opens the shared
 event window, which is also what a calendar chip opens. Any other
 server-issued internal path (e.g. `/settings?member=<id>`) renders
 as a router link; anything else renders as text so a stored
 absolute URL can never become a link out. Following either marks
 the notification read. */}
 <td>
 {eventTargetOf(n) ? (
 <button
 type="button"
 className="link-button"
 onClick={() => {
 if (!n.readAt) {
 void markNotificationRead(n.id)
 .catch(() => {})
 .then(() => load());
 }
 setEventTarget(eventTargetOf(n));
 }}
 >
 {n.title}
 </button>
 ) : n.link && n.link.startsWith('/') ? (
 <Link
 to={n.link}
 onClick={() => {
 if (!n.readAt) {
 // Fire-and-forget: navigation unmounts this page, so we do
 // not reload the list; the badge catches up on next load.
 void markNotificationRead(n.id).catch(() => {});
 }
 }}
 >
 {n.title}
 </Link>
 ) : (
 n.title
 )}
 </td>
 <td>{n.type}</td>
 <td>{new Date(n.createdAt).toLocaleString()}</td>
 <td>{n.readAt ? 'Read' : 'Unread'}</td>
 <td>
 {!n.readAt && (
 <button
 type="button"
 className="btn btn-secondary btn-sm"
 onClick={() => { void markOne(n.id); }}
 >
 Mark read
 </button>
 )}
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 <CalendarEventModal target={eventTarget} onClose={() => setEventTarget(null)} />
 </div>
 );
}
