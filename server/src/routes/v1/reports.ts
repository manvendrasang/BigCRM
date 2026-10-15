/**
 * Report routes: `GET /api/v1/reports/:name`.
 *
 * Four reports, one permission (`reports.read`), no query parameters. There is
 * deliberately no ad-hoc aggregation endpoint -- an endpoint that takes an
 * arbitrary `GROUP BY` from the client is a SQL-injection surface wearing a
 * report costume, and an endpoint that takes a fixed report name is not.
 */
import { Router } from 'express';
import { authenticate, requirePermission } from '../../middleware/security.ts';
import { asyncRoute, actorRef } from './helpers.ts';
import {
 leadFunnelReport,
 overviewReport,
 pipelineReport,
 taskLoadReport,
} from '../../services/reports.ts';
import type { ReportName } from '../../services/reports.ts';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

const NAMES: readonly ReportName[] = ['pipeline', 'lead-funnel', 'task-load', 'overview'];

reportsRouter.get('/:name', requirePermission('reports.read'), asyncRoute(async (req, res) => {
 const name = String(req.params.name ?? '');
 if (!(NAMES as readonly string[]).includes(name)) {
 res.status(404).json({ code: 'NOT_FOUND', message: `No report named '${name}'.` });
 return;
 }
 const actor = actorRef(req);
 switch (name as ReportName) {
 case 'pipeline':
 res.json({ data: await pipelineReport(actor) });
 return;
 case 'lead-funnel':
 res.json({ data: await leadFunnelReport(actor) });
 return;
 case 'task-load':
 res.json({ data: await taskLoadReport(actor) });
 return;
 case 'overview':
 res.json({ data: await overviewReport(actor) });
 return;
 }
}));
