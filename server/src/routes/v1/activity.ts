/**
 * Audit log reads + notifications.
 *
 * `GET /api/v1/org/audit-logs` pages the org's trail newest-first under
 * `audit.read`. The trail is append-only at the SQL layer so reads need no
 * mutation guard, but they do need the tenant predicate. Filters are exact-match
 * on `action`, `entity_type` and `outcome` only; free text over
 * `before_json`/`after_json` would be a full-table scan anyone could trigger,
 * so it does not exist.
 *
 * `GET /api/v1/notifications` lists the caller's own rows (org-scoped *and*
 * user-scoped). `POST /api/v1/notifications/:id/read` marks one;
 * `POST /api/v1/notifications/read-all` marks all. Marking another user's
 * notification 404s rather than 403s -- their existence is not information worth
 * confirming.
 */
import { Router } from 'express';
import { authenticate, requirePermission, csrfGuard } from '../../middleware/security.ts';
import { asyncRoute, actorRef, intParam, strParam } from './helpers.ts';
import {
 listActivities,
 listNotifications,
 markAllNotificationsRead,
 markNotificationRead,
 unreadNotificationCount,
} from '../../services/activity.ts';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);notificationsRouter.get(
 '/',
 asyncRoute(async (req, res) => {
 const limit = intParam(req, 'limit', 25, 100);
 const offset = intParam(req, 'offset', 0, 1_000_000);
 const unreadOnly = strParam(req, 'unread') === 'true';
 const [items, unread] = await Promise.all([
 listNotifications(actorRef(req), { limit, offset, unreadOnly }),
 unreadNotificationCount(actorRef(req)),
 ]);
 res.json({ data: { items, unread } });
 }),
);

notificationsRouter.post(
 '/:id/read',
 csrfGuard,
 asyncRoute(async (req, res) => {
 await markNotificationRead(actorRef(req), String(req.params.id ?? ''));
 res.status(204).end();
 }),
);

notificationsRouter.post(
 '/read-all',
 csrfGuard,
 asyncRoute(async (req, res) => {
 const marked = await markAllNotificationsRead(actorRef(req));
 res.json({ data: { marked } });
 }),
);

export const activitiesRouter = Router();
activitiesRouter.use(authenticate);

/** Timeline for one record. Entity types are validated against the activity CHECK. */
activitiesRouter.get(
 '/:entityType/:entityId',
 requirePermission('activities.read'),
 asyncRoute(async (req, res) => {
 res.json({
 data: await listActivities(
 actorRef(req),
 String(req.params.entityType ?? ''),
 String(req.params.entityId ?? ''),
 intParam(req, 'limit', 50, 200),
 ),
 });
 }),
);
