/**
 * Typed record API -- contacts, companies, leads, deals, tasks.
 *
 * Thin wrappers over `api.get/post/patch/del` that name the five record types
 * the UI screens cover. The server mounts each at `/api/v1/{type}` (not
 * `/api/v1/records/{type}` -- that prefix does not exist), with `{ data }` for
 * single records and `{ data, pageInfo }` for lists.
 *
 * Every value crossing this boundary is `unknown` until validated at render:
 * the server is trusted to enforce, not to shape, and a field the server stops
 * sending must render as blank rather than crash the page.
 */
import { api } from './api';

export type RecordType = 'contacts' | 'companies' | 'leads' | 'deals' | 'tasks';

export interface PageInfo {
 limit: number;
 offset: number;
 totalCount: number;
 hasMore: boolean;
}

export interface ListResult<T> {
 data: T[];
 pageInfo: PageInfo;
}

export type RecordInput = Record<string, unknown>;

const PAGE_SIZE = 25;

/** Lists one page of a record type, optionally filtered by free text. */
export async function listRecords<T>(
 type: RecordType,
 opts: { offset?: number; limit?: number; q?: string; filters?: Record<string, string> } = {},
): Promise<ListResult<T>> {
 const params = new URLSearchParams();
 params.set('limit', String(opts.limit ?? PAGE_SIZE));
 params.set('offset', String(opts.offset ?? 0));
 const q = (opts.q ?? '').trim();
 if (q) params.set('q', q);
 // Exact-match filters use the server's own names (`?pipeline_id=X`): the
 // route allowlists them per type, so an unknown key 400s rather than
 // silently widening the result.
 for (const [k, v] of Object.entries(opts.filters ?? {})) {
 if (v !== '') params.set(k, v);
 }
 // `raw`: the list envelope carries `pageInfo` alongside `data`, and the
 // default unwrap would drop it.
 const body = await api.get<{ data: T[]; pageInfo: PageInfo }>(`/${type}?${params.toString()}`, {
 raw: true,
 });
 return {
 data: Array.isArray(body.data) ? body.data : [],
 pageInfo: body.pageInfo ?? { limit: PAGE_SIZE, offset: 0, totalCount: 0, hasMore: false },
 };
}

/** Fetches one record by id. Throws `ApiError` 404 when it does not exist. */
export async function getRecord<T>(type: RecordType, id: string): Promise<T> {
 // The default unwrap returns `body.data` directly for single records.
 return api.get<T>(`/${type}/${encodeURIComponent(id)}`);
}

/** Creates a record. Only writable columns are accepted by the server. */
export async function createRecord<T>(type: RecordType, input: RecordInput): Promise<T> {
 return api.post<T>(`/${type}`, input);
}

/** Patches a record. Only updatable columns are accepted by the server. */
export async function updateRecord<T>(
 type: RecordType,
 id: string,
 input: RecordInput,
): Promise<T> {
 return api.patch<T>(`/${type}/${encodeURIComponent(id)}`, input);
}

/** Soft-deletes a record. Restore is a separate permission and a separate call. */
export async function deleteRecord(type: RecordType, id: string): Promise<void> {
 await api.del(`/${type}/${encodeURIComponent(id)}`);
}

/** Restores a soft-deleted record. */
export async function restoreRecord(type: RecordType, id: string): Promise<void> {
 await api.post(`/${type}/${encodeURIComponent(id)}/restore`);
}

export interface TaskAssignee {
 id: string;
 name: string | null;
 email: string;
 role: string;
}

/**
 * The people the caller may hand a task to.
 *
 * The server returns [] for roles without assignment authority and never
 * offers the owner to a manager, so the picker and the save path agree by
 * construction rather than by two copies of the same rule.
 */
export async function listTaskAssignees(): Promise<TaskAssignee[]> {
 const body = await api.get<unknown>('/tasks/assignees');
 return Array.isArray(body) ? (body as TaskAssignee[]) : [];
}

/** Converts a lead into a contact/company/deal. Lead-only. */
export async function convertLead(
 id: string,
 input: { companyName?: string; dealName?: string; pipelineId?: string } = {},
): Promise<unknown> {
 return api.post(`/leads/${encodeURIComponent(id)}/convert`, input);
}

/** Advances a deal to a new pipeline stage. Deal-only. */
export async function advanceDealStage(id: string, stageId: string): Promise<unknown> {
 return api.post(`/deals/${encodeURIComponent(id)}/stage`, { stageId });
}

/**
 * Renders any record field as display text.
 *
 * Records arrive as `unknown`-shaped JSON. A missing, null, or mistyped field
 * renders as an em dash rather than throwing -- the list must survive the server
 * adding, renaming, or dropping a column without a coordinated deploy.
 */
export function field(record: unknown, key: string): string {
 if (typeof record !== 'object' || record === null) return '--';
 const v = (record as Record<string, unknown>)[key];
 if (v === null || v === undefined || v === '') return '--';
 if (typeof v === 'string') return v;
 if (typeof v === 'number' || typeof v === 'boolean') return String(v);
 return '--';
}

/** Money stored as integer cents renders as dollars. Non-numbers render blank. */
export function money(cents: unknown, currency?: unknown): string {
 if (typeof cents !== 'number' || !Number.isFinite(cents)) return '--';
 const code = typeof currency === 'string' && currency ? currency : 'USD';
 try {
 return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(cents / 100);
 } catch {
 return `$${(cents / 100).toFixed(2)}`;
 }
}

/** ISO timestamps render as short dates. Anything else renders as-is or blank. */
export function shortDate(value: unknown): string {
 if (typeof value !== 'string' || !value) return '--';
 const d = new Date(value);
 if (Number.isNaN(d.getTime())) return value;
 return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
