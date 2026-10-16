/**
 * Import / export routes.
 *
 * Export is admin+ (`exports.manage`): it dumps whole tables, so member-level
 * export would be bulk exfiltration with a button on it. Import is
 * `imports.manage` for the symmetric reason -- bulk creation bypasses the
 * per-record UI and its human review.
 *
 * Export returns the job row; nothing is polled because the transfer completes
 * synchronously under the row cap. Download is a separate `GET` on the job id
 * so bytes and metadata have different cache and audit characteristics.
 *
 * Import takes the CSV as the raw body (`text/csv` or `text/plain`) for the same
 * reason uploads avoid multipart: one bounded body, no parser to confuse.
 * `X-Entity-Type` names the target; `X-Idempotency-Key` is optional but
 * recommended.
 */
import { Router } from 'express';
import { authenticate, requirePermission, csrfGuard } from '../../middleware/security.ts';
import { asyncRoute, actorRef } from './helpers.ts';
import { downloadExport, exportRecords, importRecords } from '../../services/transfers.ts';

export const transfersRouter = Router();
transfersRouter.use(authenticate);

transfersRouter.post(
 '/exports',
 csrfGuard,
 requirePermission('exports.manage'),
 asyncRoute(async (req, res) => {
 const body = (req.body ?? {}) as Record<string, unknown>;
 const job = await exportRecords(actorRef(req), String(body['entityType'] ?? ''),
 typeof body['idempotencyKey'] === 'string' ? body['idempotencyKey'] : undefined);
 res.status(201).json({ data: job });
 }),
);

transfersRouter.get(
 '/exports/:id/download',
 requirePermission('exports.manage'),
 asyncRoute(async (req, res) => {
 const { bytes, fileName } = await downloadExport(
 actorRef(req), String(req.params.id ?? ''));
 res.setHeader('Content-Type', 'text/csv; charset=utf-8');
 res.setHeader('X-Content-Type-Options', 'nosniff');
 res.setHeader('Content-Disposition',
 `attachment; filename="${fileName.replace(/["\r\n]/g, '')}"`);
 res.send(bytes);
 }),
);

transfersRouter.post(
 '/imports',
 csrfGuard,
 requirePermission('imports.manage'),
 asyncRoute(async (req, res) => {
 const entityType = String(req.get('x-entity-type') ?? '');
 if (!entityType) {
 res.status(400).json({ code: 'BAD_REQUEST', message: 'X-Entity-Type header is required.' });
 return;
 }
 const raw = req.body as unknown;
 // Express may hand us a parsed object when the client sent JSON by
 // mistake; an import body must be CSV text. Rejecting here rather than
 // stringifying means a wrong Content-Type fails loudly at the boundary
 // instead of importing one row containing "[object Object]".
 const text = typeof raw === 'string' ? raw
 : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
 if (text === null) {
 res.status(400).json({
 code: 'BAD_REQUEST',
 message: 'Request body must be CSV text (Content-Type: text/csv).',
 });
 return;
 }
 const key = req.get('x-idempotency-key')?.trim() || undefined;
 const job = await importRecords(actorRef(req), entityType, text, key);
 res.status(201).json({ data: job });
 }),
);
