/** Mounts every v1 route under a single, explicit prefix. */
import { Router } from 'express';
import { authRouter } from './auth.ts';
import { mfaRouter, publicMfaRouter } from './mfa.ts';
import { orgRouter, publicOrgRouter } from './org.ts';
import { recordsRouter } from './records.ts';
import { reportsRouter } from './reports.ts';
import { customFieldsRouter } from './customFields.ts';
import { attachmentsRouter } from './attachments.ts';
import { transfersRouter } from './transfers.ts';
import { notificationsRouter, activitiesRouter } from './activity.ts';
import { calendarRouter } from './calendar.ts';
import { viewsRouter } from './views.ts';

export const v1Router = Router();

// Invitation accept/preview sit outside the authenticated org router: the
// recipient has no account yet. `authenticate` is applied per-router inside,
// so mounting both here keeps the two access models visibly separate.
v1Router.use('/org', publicOrgRouter);
v1Router.use('/org', orgRouter);
// Public MFA challenge completion must be mounted BEFORE the authenticated
// `mfaRouter`, which applies `authenticate` to everything under it. Order is the
// only thing distinguishing them, so it is stated rather than left implicit.
v1Router.use('/auth/mfa', publicMfaRouter);
v1Router.use('/auth/mfa', mfaRouter);
v1Router.use('/auth', authRouter);
// Reports before the records router as a matter of hygiene: today the records
// router mounts nine fixed type paths and would not capture `/reports`, but a
// future generic `/:type` handler would. Mount order makes the reports prefix
// unambiguous regardless.
v1Router.use('/reports', reportsRouter);
// Custom fields, attachments and transfers mount before the records router for
// the same reason: fixed, unambiguous prefixes that must never be captured as
// a record type or id.
v1Router.use('/custom-fields', customFieldsRouter);
v1Router.use('/attachments', attachmentsRouter);
v1Router.use('/transfers', transfersRouter);
// Notifications and activities mount on fixed prefixes, so their
// router-level `authenticate` only ever sees their own paths.
// The audit log is on `orgRouter` (`/org/audit-logs`) rather than here: nothing
// should be mounted at '/' with middleware, because a root-mounted router is
// traversed by every request in the application and its middleware runs on all
// of them. See BIG-35.
v1Router.use('/notifications', notificationsRouter);
v1Router.use('/activities', activitiesRouter);
v1Router.use('/calendar', calendarRouter);
v1Router.use('/views', viewsRouter);
v1Router.use('/', recordsRouter);

export { authRouter, mfaRouter, publicMfaRouter, orgRouter, publicOrgRouter, recordsRouter, reportsRouter, customFieldsRouter, attachmentsRouter, transfersRouter, notificationsRouter, activitiesRouter, calendarRouter, viewsRouter };
