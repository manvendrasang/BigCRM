/**
 * Notifications page.
 *
 * Lists the caller's own notifications with an unread badge, and offers
 * mark-one-read and mark-all-read. The unread count is also surfaced in the
 * header via a badge on the nav link.
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

export function Notifications(): JSX.Element {
 const [items, setItems] = useState<NotificationRow[]>([]);
 const [unread, setUnread] = useState(0);
 const [error, setError] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);

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
 <div>
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
 {/* Links are server-issued internal paths (e.g. `/calendar`
 on a meeting invite); anything else renders as text so a
 stored absolute URL can never become a link out. */}
 <td>{n.link && n.link.startsWith('/') ? <Link to={n.link}>{n.title}</Link> : n.title}</td>
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
 </div>
 );
}
