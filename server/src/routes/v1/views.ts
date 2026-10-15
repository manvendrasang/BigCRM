/**
 * Saved-view routes: `GET/POST /api/v1/views`, `DELETE /api/v1/views/:id`.
 *
 * No update endpoint: a view is small and cheap, so editing is delete +
 * recreate. An update endpoint would need ownership-transfer semantics (can
 * the owner change? can shared be unshared by a non-admin?) that delete +
 * recreate sidesteps entirely.
 */
import { Router } from 'express';
import { authenticate, csrfGuard } from '../../middleware/security.ts';
import { asyncRoute, actorRef, strParam } from './helpers.ts';
import { createSavedView, deleteSavedView, listSavedViews } from '../../services/savedViews.ts';

export const viewsRouter = Router();
viewsRouter.use(authenticate);

viewsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json({ data: await listSavedViews(actorRef(req), strParam(req, 'entityType') || undefined) });
  }),
);

viewsRouter.post(
  '/',
  csrfGuard,
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const asRecord = (v: unknown): Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    res.status(201).json({
      data: await createSavedView(actorRef(req), {
        name: String(body['name'] ?? ''),
        entityType: String(body['entityType'] ?? ''),
        filters: asRecord(body['filters']),
        sort: asRecord(body['sort']),
        columns: Array.isArray(body['columns']) ? (body['columns'] as string[]) : undefined,
        isShared: body['isShared'] === true,
      }),
    });
  }),
);

viewsRouter.delete(
  '/:id',
  csrfGuard,
  asyncRoute(async (req, res) => {
    await deleteSavedView(actorRef(req), String(req.params.id ?? ''));
    res.status(204).end();
  }),
);
