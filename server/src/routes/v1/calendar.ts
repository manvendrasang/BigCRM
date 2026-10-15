/**
 * `/api/v1/calendar` -- month-range agenda and meeting scheduling.
 *
 * `GET /` takes `from`/`to` (ISO) and defaults to the current calendar month
 * when they are absent, so the route answers 200 to a bare request. `POST
 * /meetings` schedules a meeting activity on a record the caller's tenant
 * owns. Reads need `activities.read`; scheduling needs `activities.create`,
 * which viewers do not hold.
 */
import express from 'express';
const { Router } = express;
import { z } from 'zod';
import { asyncRoute, actorRef } from './helpers.ts';
import { authenticate, csrfGuard, requirePermission } from '../../middleware/security.ts';
import { validationFailed } from '../../lib/errors.ts';
import { getCalendar, inviteToMeeting, listInvitees, listMyInvites, respondToInvite, scheduleMeeting } from '../../services/calendar.ts';

export const calendarRouter = Router();
calendarRouter.use(authenticate);

const monthBounds = (now: Date): { from: string; to: string } => {
 const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
 const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
 return { from: from.toISOString(), to: to.toISOString() };
};

calendarRouter.get(
 '/',
 requirePermission('activities.read'),
 requirePermission('tasks.read'),
 asyncRoute(async (req, res) => {
 const q = req.query as Record<string, unknown>;
 const defaults = monthBounds(new Date());
 const agenda = await getCalendar(
 actorRef(req),
 typeof q['from'] === 'string' ? q['from'] : defaults.from,
 typeof q['to'] === 'string' ? q['to'] : defaults.to,
 );
 res.json({ data: agenda });
 }),
);

const scheduleSchema = z.object({
 entityType: z.string().trim().min(1).max(40),
 entityId: z.string().trim().min(1).max(64),
 occurredAt: z.string().trim().min(1).max(64),
 subject: z.string().trim().min(1).max(200),
 description: z.string().max(2000).optional(),
});

calendarRouter.post(
 '/meetings',
 csrfGuard,
 requirePermission('activities.create'),
 asyncRoute(async (req, res) => {
 const parsed = scheduleSchema.safeParse(req.body);
 if (!parsed.success) {
 const fields: Record<string, string> = {};
 for (const issue of parsed.error.issues) {
 const key = issue.path.join('.') || '_';
 if (!(key in fields)) fields[key] = issue.message;
 }
 throw validationFailed(fields);
 }
 const created = await scheduleMeeting(actorRef(req), {
 entityType: parsed.data.entityType,
 entityId: parsed.data.entityId,
 occurredAt: parsed.data.occurredAt,
 subject: parsed.data.subject,
 description: parsed.data.description,
 });
 res.status(201).json({ data: created });
 }),
);

calendarRouter.get(
 '/invitees',
 requirePermission('activities.create'),
 asyncRoute(async (req, res) => {
 res.json({ data: await listInvitees(actorRef(req)) });
 }),
);

calendarRouter.get(
 '/invites',
 requirePermission('activities.read'),
 asyncRoute(async (req, res) => {
 const q = req.query as Record<string, unknown>;
 const status = typeof q['status'] === 'string' ? q['status'] : undefined;
 if (status !== undefined && status !== 'invited' && status !== 'accepted' && status !== 'declined') {
 throw validationFailed({ status: 'Filter by invited, accepted or declined.' });
 }
 res.json({ data: await listMyInvites(actorRef(req), status) });
 }),
);

const inviteSchema = z.object({
 userIds: z.array(z.string().trim().min(1).max(64)).min(1).max(50),
});

calendarRouter.post(
 '/meetings/:id/invite',
 csrfGuard,
 requirePermission('activities.create'),
 asyncRoute(async (req, res) => {
 const parsed = inviteSchema.safeParse(req.body);
 if (!parsed.success) throw validationFailed({ userIds: 'Invite between 1 and 50 people.' });
 const result = await inviteToMeeting(actorRef(req), String(req.params.id ?? ''), parsed.data.userIds);
 res.status(200).json({ data: result });
 }),
);

const respondSchema = z.object({
 status: z.enum(['accepted', 'declined']),
});

calendarRouter.post(
 '/invites/:inviteId/respond',
 csrfGuard,
 requirePermission('activities.read'),
 asyncRoute(async (req, res) => {
 const parsed = respondSchema.safeParse(req.body);
 if (!parsed.success) throw validationFailed({ status: 'Answer accepted or declined.' });
 const invite = await respondToInvite(actorRef(req), String(req.params.inviteId ?? ''), parsed.data.status);
 res.status(200).json({ data: invite });
 }),
);
