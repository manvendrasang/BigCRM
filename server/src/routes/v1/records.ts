/**
 * `/api/v1` record routes — companies, contacts, leads, deals, pipelines,
 * pipeline stages, tasks, notes, tags.
 *
 * The router is generated from the service's record types rather than written
 * once per entity, which is what keeps the permission mapping honest: there is
 * exactly one place where an HTTP verb becomes a `<resource>.<verb>` permission,
 * and it is derived from the same string the RBAC matrix checks.
 */
import { Router } from 'express';
import { asyncRoute, actorRef, meta, intParam, strParam, filterParams } from './helpers.ts';
import { authenticate, requirePermission, csrfGuard, searchLimiter } from '../../middleware/security.ts';
import {
  listRecords, getRecord, createRecord, updateRecord, softDeleteRecord, restoreRecord,
  convertLead, moveDealStage, createPipelineWithStages, listPipelineStages,
  type RecordType,
} from '../../services/records.ts';
import { badRequest } from '../../lib/errors.ts';

export const recordsRouter = Router();
recordsRouter.use(authenticate);

/** Paths whose verbs are not the plain CRUD set. */
const NOT_FOUND_403 = 'The requested record could not be found.';

/** Per-type filter columns the API will accept. Mirrors the service spec. */
const FILTERABLE: Record<RecordType, readonly string[]> = {
  contacts: ['status', 'lifecycle_stage', 'company_id', 'owner_id', 'email'],
  companies: ['status', 'domain', 'industry', 'owner_id'],
  leads: ['status', 'rating', 'owner_id', 'company_id', 'source'],
  deals: ['status', 'pipeline_id', 'stage_id', 'owner_id', 'company_id', 'contact_id', 'currency'],
  pipelines: ['is_default'],
  pipeline_stages: ['pipeline_id', 'is_won', 'is_lost'],
  tasks: ['status', 'priority', 'assignee_id', 'related_type', 'related_id'],
  notes: ['entity_type', 'entity_id'],
  tags: ['name'],
};

const listHandler = (type: RecordType) => asyncRoute(async (req, res) => {
  const result = await listRecords(actorRef(req), type, {
    limit: intParam(req, 'limit', 25, 200),
    offset: intParam(req, 'offset', 0, 1_000_000),
    sort: strParam(req, 'sort'),
    order: strParam(req, 'order'),
    q: strParam(req, 'q'),
    filters: filterParams(req, FILTERABLE[type]),
    includeDeleted: strParam(req, 'includeDeleted') === 'true',
  });
  res.json({
    data: result.data,
    pageInfo: {
      limit: result.limit, offset: result.offset, totalCount: result.total,
      hasMore: result.offset + result.data.length < result.total,
    },
  });
});

for (const type of ['contacts', 'companies', 'leads', 'deals', 'pipelines', 'pipeline_stages', 'tasks', 'notes', 'tags'] as const) {
  const r = Router({ mergeParams: true });

  // Search is the expensive path and the one most abused for enumeration.
  r.get('/', searchLimiter, requirePermission(`${type}.read`), listHandler(type));

  r.get('/:id', requirePermission(`${type}.read`), asyncRoute(async (req, res) => {
    res.json({ data: await getRecord(actorRef(req), type, String(req.params.id ?? '')) });
  }));

  r.post('/', csrfGuard, requirePermission(`${type}.create`), asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    // Specialised create paths that need more than one table write.
    if (type === 'pipelines' && (body.stages !== undefined || body.isDefault !== undefined)) {
      const record = await createPipelineWithStages(actorRef(req), {
        name: String(body.name ?? ''),
        description: body.description === undefined ? undefined : String(body.description),
        isDefault: body.isDefault === true,
        stages: Array.isArray(body.stages) ? body.stages.map((s) => String(s)) : undefined,
      }, meta(req));
      res.status(201).json({ data: record });
      return;
    }
    const result = await createRecord(actorRef(req), type, body ?? {}, meta(req));
    res.status(201).json({ data: result.record });
  }));

  r.patch('/:id', csrfGuard, requirePermission(`${type}.update`), asyncRoute(async (req, res) => {
    const result = await updateRecord(actorRef(req), type,
      String(req.params.id ?? ''), (req.body ?? {}) as Record<string, unknown>, meta(req));
    res.json({ data: result.record });
  }));

  r.delete('/:id', csrfGuard, requirePermission(`${type}.delete`), asyncRoute(async (req, res) => {
    await softDeleteRecord(actorRef(req), type, String(req.params.id ?? ''), meta(req));
    res.status(204).end();
  }));

  // Restore is a separate permission: "delete" should not imply "undo delete".
  r.post('/:id/restore', csrfGuard, requirePermission(`${type}.restore`), asyncRoute(async (req, res) => {
    await restoreRecord(actorRef(req), type, String(req.params.id ?? ''), meta(req));
    res.status(204).end();
  }));

  recordsRouter.use(`/${type}`, r);
}

// ── pipeline stages (nested read) ─────────────────────────────────────────────

recordsRouter.get('/pipelines/:id/stages', requirePermission('pipeline_stages.read'),
  asyncRoute(async (req, res) => {
    res.json({ data: await listPipelineStages(actorRef(req), String(req.params.id ?? '')) });
  }));

// ── deal stage movement ───────────────────────────────────────────────────────

recordsRouter.post('/deals/:id/stage', csrfGuard, requirePermission('deals.advance'),
  asyncRoute(async (req, res) => {
    const stageId = String((req.body as { stageId?: unknown } | undefined)?.stageId ?? '');
    if (!stageId) throw badRequest("'stageId' is required.");
    const deal = await moveDealStage(actorRef(req), String(req.params.id ?? ''), stageId, meta(req));
    res.json({ data: deal });
  }));

// ── lead conversion ───────────────────────────────────────────────────────────

recordsRouter.post('/leads/:id/convert', csrfGuard, requirePermission('leads.convert'),
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as {
      createCompany?: unknown; dealName?: unknown; dealValueC?: unknown;
      pipelineId?: unknown; stageId?: unknown;
    };
    const result = await convertLead(actorRef(req), String(req.params.id ?? ''), {
      createCompany: body.createCompany === true,
      dealName: body.dealName === undefined ? undefined : String(body.dealName),
      dealValueC: body.dealValueC === undefined ? undefined : Number(body.dealValueC),
      pipelineId: body.pipelineId === undefined ? undefined : String(body.pipelineId),
      stageId: body.stageId === undefined ? undefined : String(body.stageId),
    }, meta(req));
    res.status(201).json({ data: result });
  }));

export { NOT_FOUND_403 };
