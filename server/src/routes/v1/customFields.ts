/**
 * Custom field routes.
 *
 * Definitions are managed (`custom_fields.manage`); values are read and written
 * under the record permissions of the entity they belong to. A viewer who can
 * read contacts can read their custom values, but cannot define new fields —
 * schema is an admin act, data is not.
 */
import { Router } from 'express';
import { authenticate, requirePermission, csrfGuard } from '../../middleware/security.ts';
import { asyncRoute, actorRef } from './helpers.ts';
import {
  createCustomField,
  deleteCustomField,
  getCustomFieldValues,
  listCustomFields,
  setCustomFieldValue,
} from '../../services/customFields.ts';

export const customFieldsRouter = Router();
customFieldsRouter.use(authenticate);

customFieldsRouter.get(
  '/:entityType',
  requirePermission('custom_fields.read'),
  asyncRoute(async (req, res) => {
    res.json({ data: await listCustomFields(actorRef(req), String(req.params.entityType ?? '')) });
  }),
);

customFieldsRouter.post(
  '/',
  csrfGuard,
  requirePermission('custom_fields.manage'),
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.status(201).json({
      data: await createCustomField(actorRef(req), {
        entityType: String(body['entityType'] ?? ''),
        key: String(body['key'] ?? ''),
        label: String(body['label'] ?? ''),
        fieldType: String(body['fieldType'] ?? ''),
        options: Array.isArray(body['options']) ? (body['options'] as unknown[]) : undefined,
        defaultValue: body['defaultValue'],
        isRequired: body['isRequired'] === true,
        isSearchable: body['isSearchable'] === true,
        position: typeof body['position'] === 'number' ? body['position'] : undefined,
      }),
    });
  }),
);

customFieldsRouter.delete(
  '/:id',
  csrfGuard,
  requirePermission('custom_fields.manage'),
  asyncRoute(async (req, res) => {
    await deleteCustomField(actorRef(req), String(req.params.id ?? ''));
    res.status(204).end();
  }),
);

customFieldsRouter.get(
  '/:entityType/:entityId/values',
  requirePermission('custom_fields.read'),
  asyncRoute(async (req, res) => {
    res.json({
      data: await getCustomFieldValues(
        actorRef(req),
        String(req.params.entityType ?? ''),
        String(req.params.entityId ?? ''),
      ),
    });
  }),
);

customFieldsRouter.put(
  '/:fieldId/values/:entityId',
  csrfGuard,
  requirePermission('custom_fields.manage'),
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const value = await setCustomFieldValue(
      actorRef(req),
      String(req.params.fieldId ?? ''),
      String(req.params.entityId ?? ''),
      body['value'],
    );
    res.json({ data: value });
  }),
);
