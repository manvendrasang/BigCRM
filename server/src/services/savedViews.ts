/**
 * Saved views: named filter/sort/column presets on record lists.
 *
 * A view belongs to one user (`owner_id`) in one org, or is shared
 * org-wide (`is_shared`, settable only by admin+ -- enforced here, not in the
 * route, so no route can forget). Applying a view re-runs the list query with
 * the stored parameters; the stored `filters` object is validated key-by-key
 * against the record type's FILTERABLE set at apply time, so a view saved
 * before a filter was removed cannot smuggle an unallowlisted clause into the
 * query later.
 *
 * `columns` is presentation (which table columns the UI shows) and is stored
 * but never trusted for query building -- the server projects its own columns.
 */
import { TenantScope } from '../repositories/base.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import type { ActorRef } from './records.ts';

const ENTITY_TYPES: readonly string[] = [
 'contacts', 'companies', 'leads', 'deals', 'tasks', 'notes', 'tags',
];

export type SavedView = {
 id: string;
 name: string;
 entityType: string;
 filters: Record<string, unknown>;
 sort: Record<string, unknown>;
 columns: string[];
 isShared: boolean;
 ownerId: string | null;
};

const rowToView = (r: Record<string, unknown>): SavedView => ({
 id: String(r['id']),
 name: String(r['name']),
 entityType: String(r['entity_type']),
 filters: (r['filters'] as Record<string, unknown> | null) ?? {},
 sort: (r['sort'] as Record<string, unknown> | null) ?? {},
 columns: Array.isArray(r['columns']) ? (r['columns'] as string[]) : [],
 isShared: r['is_shared'] === true,
 ownerId: r['owner_id'] === null ? null : String(r['owner_id']),
});

/** Views visible to the caller: their own plus shared org views. */
export async function listSavedViews(
 actor: ActorRef,
 entityType?: string,
): Promise<SavedView[]> {
 const scope = new TenantScope(actor.organizationId);
 const typeClause = entityType ? 'AND entity_type = $3' : '';
 const params: unknown[] = entityType
 ? [actor.organizationId, actor.userId, entityType]
 : [actor.organizationId, actor.userId];
 const rows = await scope.query(
 `SELECT * FROM saved_views
 WHERE organization_id = $1 AND deleted_at IS NULL
 AND (owner_id = $2 OR is_shared) ${typeClause}
 ORDER BY is_shared DESC, name`,
 params,
 );
 return rows.map(rowToView);
}

export async function createSavedView(
 actor: ActorRef,
 input: {
 name: string; entityType: string;
 filters?: Record<string, unknown>; sort?: Record<string, unknown>;
 columns?: string[]; isShared?: boolean;
 },
): Promise<SavedView> {
 const name = input.name.trim();
 if (name.length < 1 || name.length > 80) {
 throw badRequest('Name must be between 1 and 80 characters.');
 }
 if (!ENTITY_TYPES.includes(input.entityType)) {
 throw badRequest(`Unknown entity type '${input.entityType}'.`);
 }
 if (input.isShared === true && actor.role !== 'admin' && actor.role !== 'owner') {
 // Sharing publishes a view to the whole org. A member creating a "shared"
 // view would be writing org-wide configuration with a member's authority.
 throw forbidden('Only admins can share views.');
 }
 // Filters and sort are stored as given but validated at apply time; storing
 // them raw keeps the view forward-compatible with new filter keys, while
 // apply-time validation keeps it safe. What is bounded here is size: a 100 KB
 // JSON blob in a view row is either a bug or an attack on the list query.
 const filtersJson = JSON.stringify(input.filters ?? {});
 const sortJson = JSON.stringify(input.sort ?? {});
 if (filtersJson.length > 5000 || sortJson.length > 2000) {
 throw badRequest('Filters or sort are too large.');
 }
 const columns = Array.isArray(input.columns)
 ? input.columns.filter((c) => typeof c === 'string').slice(0, 30) : [];

 const scope = new TenantScope(actor.organizationId);
 const id = newId();
 const now = nowIso();
 await scope.query(
 `INSERT INTO saved_views
 (id,organization_id,owner_id,name,entity_type,filters,sort,columns,is_shared,created_at,updated_at)
 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$10)`,
 [id, actor.organizationId, actor.userId, name, input.entityType,
 filtersJson, sortJson, columns, input.isShared === true, now],
 );
 const rows = await scope.query(
 `SELECT * FROM saved_views WHERE organization_id = $1 AND id = $2`,
 [actor.organizationId, id],
 );
 return rowToView(rows[0]!);
}

/** Deletes your own view, or any view if admin+. Shared views need admin+. */
export async function deleteSavedView(actor: ActorRef, id: string): Promise<void> {
 const scope = new TenantScope(actor.organizationId);
 const rows = await scope.query(
 `SELECT owner_id, is_shared FROM saved_views
 WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
 [actor.organizationId, id],
 );
 if (rows.length === 0) throw notFound('View not found.');
 const own = String(rows[0]!['owner_id']) === actor.userId;
 const shared = rows[0]!['is_shared'] === true;
 const admin = actor.role === 'admin' || actor.role === 'owner';
 if ((!own && !admin) || (shared && !admin)) {
 throw forbidden('You cannot delete this view.');
 }
 await scope.query(
 `UPDATE saved_views SET deleted_at = $3, updated_at = $3
 WHERE organization_id = $1 AND id = $2
 RETURNING id`,
 [actor.organizationId, id, nowIso()],
 );
}
