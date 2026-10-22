/**
 * Attachment routes.
 *
 * Upload is `POST /api/v1/attachments` with the raw file bytes as the body and
 * metadata in `X-` headers -- not multipart. Multipart parsing is a historically
 * rich source of boundary-smuggling and temp-file bugs; a single bounded body
 * with explicit headers has no parser to confuse.
 *
 * Headers:
 * X-Entity-Type contact | company | lead | deal | task | note
 * X-Entity-Id uuid of the record
 * X-File-Name original filename (validated, never touches disk)
 * Content-Type declared MIME (checked against magic bytes, never trusted)
 *
 * The body limit is enforced by Express before this handler runs; the service
 * enforces the file-size policy on top of that.
 */
import { Router } from 'express';
import { authenticate, requirePermission, csrfGuard } from '../../middleware/security.ts';
import { asyncRoute, actorRef } from './helpers.ts';
import {
 deleteAttachment,
 downloadAttachment,
 listAttachments,
 uploadAttachment,
} from '../../services/attachments.ts';

export const attachmentsRouter = Router();
attachmentsRouter.use(authenticate);

// Download is registered before the per-entity list: `/:entityType/:entityId`
// would otherwise capture `/file/<id>` as entityType='file' and answer 400
// "Unknown entity type 'file'." -- every attachment download was unreachable
// while the route still looked present. Static segments must be registered
// before parameterised ones that could swallow them.
attachmentsRouter.get(
 '/file/:id',
 requirePermission('attachments.read'),
 asyncRoute(async (req, res) => {
 const { attachment, bytes } = await downloadAttachment(
 actorRef(req), String(req.params.id ?? ''));
 // `nosniff` plus an explicit type stops the browser from second-guessing a
 // text file into HTML. `attachment` forces download rather than inline
 // rendering -- a file that renders inline in the app origin runs script in
 // the app origin, which is exactly the stored-XSS primitive uploads must
 // not become.
 res.setHeader('Content-Type', attachment.contentType);
 res.setHeader('X-Content-Type-Options', 'nosniff');
 res.setHeader('Content-Disposition',
 `attachment; filename="${attachment.fileName.replace(/["\r\n]/g, '')}"`);
 res.send(bytes); // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- intentional: binary file download with Content-Disposition: attachment, not HTML rendering
 }),
);

attachmentsRouter.get(
 '/:entityType/:entityId',
 requirePermission('attachments.read'),
 asyncRoute(async (req, res) => {
 res.json({
 data: await listAttachments(
 actorRef(req),
 String(req.params.entityType ?? ''),
 String(req.params.entityId ?? ''),
 ),
 });
 }),
);

attachmentsRouter.post(
 '/',
 csrfGuard,
 requirePermission('attachments.create'),
 asyncRoute(async (req, res) => {
 const entityType = String(req.get('x-entity-type') ?? '');
 const entityId = String(req.get('x-entity-id') ?? '');
 const fileName = String(req.get('x-file-name') ?? '');
 if (!entityType || !entityId || !fileName) {
 res.status(400).json({
 code: 'BAD_REQUEST',
 message: 'X-Entity-Type, X-Entity-Id and X-File-Name headers are required.',
 });
 return;
 }
 // Express parses JSON bodies into objects; a file upload arrives as a
 // Buffer (or a string when the client sent text). Anything else is a
 // client bug, rejected before it reaches validation.
 const raw = req.body as unknown;
 const buffer = Buffer.isBuffer(raw)
 ? raw
 : typeof raw === 'string' ? Buffer.from(raw, 'utf8') : null;
 if (!buffer) {
 res.status(400).json({ code: 'BAD_REQUEST', message: 'Request body must be the file bytes.' });
 return;
 }
 const attachment = await uploadAttachment(actorRef(req), {
 entityType,
 entityId,
 fileName,
 declaredMime: req.get('content-type')?.split(';')[0]?.trim(),
 buffer,
 });
 res.status(201).json({ data: attachment });
 }),
);


attachmentsRouter.delete(
 '/file/:id',
 csrfGuard,
 requirePermission('attachments.delete'),
 asyncRoute(async (req, res) => {
 await deleteAttachment(actorRef(req), String(req.params.id ?? ''));
 res.status(204).end();
 }),
);
