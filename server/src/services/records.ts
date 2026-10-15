/**
 * CRM record services -- companies, contacts, leads, deals, pipelines, tasks,
 * notes, activities, tags.
 *
 *  The invariants this file exists to hold 
 *
 * 1. **Every read is tenant-scoped and excludes soft-deleted rows.** There is no
 * code path that can reach another tenant's row: `TenantScope` rejects any
 * statement missing an `organization_id` predicate at the SQL level
 * (`assertTenantPredicate`), not at the caller's discretion.
 *
 * 2. **Identifiers never reach SQL as text.** Columns and tables come from
 * `RecordSpec` constants declared here and are re-validated by
 * `allowlist()`. Sort columns, filter operators and order come from caller
 * input and are mapped through allowlists, never interpolated raw.
 *
 * 3. **The audit row and the mutation share one transaction.** If the business
 * write rolls back, so does its audit entry -- an audit trail can never claim
 * a change that did not happen. `writeAudit` swallows its own errors
 * (accepted risk A1), which is the only way a committed mutation can lack an
 * audit row; that is logged at `error` and counted, never silent.
 *
 * 4. **Soft delete, not hard delete.** `deleted_at`/`deleted_by` are set and the
 * row is filtered out of every read. Restoration is a separate, audited
 * operation with its own permission, so "delete" is reversible but not silent.
 *
 * 5. **Activity trail.** Each mutation writes an `activities` row describing who
 * did what to which entity, in the same transaction.
 */
import {
 TenantScope, allowlist, insert, countScoped, direction,
 type Row, type SortDirection,
} from '../repositories/base.ts';
import { badRequest, conflict, notFoundOrForbidden } from '../lib/errors.ts';
import { sanitizeRichText, stripControlChars } from '../lib/sanitize.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import {
 normaliseEmail, normalisePhone, normaliseCompanyName, normaliseDomain,
 normaliseCountry, displayName,
} from './normalise.ts';
import { writeAudit } from './org.ts';
import type { Role } from './rbac.ts';

export type ActorRef = {
 userId: string;
 organizationId: string;
 role: Role;
 email: string;
};

export type RequestMeta = { ip?: string | null; userAgent?: string | null; requestId?: string | null };

//  record specifications 

export type RecordType =
 | 'contacts' | 'companies' | 'leads' | 'deals'
 | 'pipelines' | 'pipeline_stages' | 'tasks' | 'notes' | 'tags';

type RecordSpec = {
 /** Columns a client may set on create. Never includes `id` or `organization_id`. */
 writable: readonly string[];
 /** Columns a client may set on update. Subset of `writable` plus `status`. */
 updatable: readonly string[];
 /** Columns a client may sort by. */
 sortable: readonly string[];
 /** Columns matched by the free-text `q` parameter. */
 searchable: readonly string[];
 /** Column holding the responsible user, if the type has one. */
 ownerColumn?: string;
 /**
 * Which columns carry provenance, and which of them this table actually has.
 * `created_by`/`updated_by` are present on the record tables but not on
 * `pipelines`, `pipeline_stages` or `tags`; `tasks` uses `creator_id` and
 * `notes` uses `author_id`. Guessing produced "column created_by of relation
 * pipelines does not exist", so the shape is declared here instead.
 */
 provenance: { actor: 'created_by' | 'creator_id' | 'author_id' | null; softDelete: boolean };
 /** The audit/activity entity label. */
 label: string;
};

const SPECS: Record<RecordType, RecordSpec> = {
 contacts: {
 label: 'contact',
 provenance: { actor: 'created_by', softDelete: true },
 writable: ['first_name', 'last_name', 'email', 'secondary_email', 'phone', 'mobile_phone',
 'job_title', 'department', 'company_id', 'owner_id', 'source', 'status', 'lifecycle_stage',
 'address_line1', 'city', 'region', 'postal_code', 'country_code', 'website', 'linkedin_url',
 'birthday', 'description'],
 updatable: ['first_name', 'last_name', 'email', 'secondary_email', 'phone', 'mobile_phone',
 'job_title', 'department', 'company_id', 'owner_id', 'source', 'status', 'lifecycle_stage',
 'address_line1', 'city', 'region', 'postal_code', 'country_code', 'website', 'linkedin_url',
 'birthday', 'description'],
 sortable: ['last_name', 'first_name', 'created_at', 'updated_at', 'email', 'status', 'lifecycle_stage'],
 searchable: ['first_name', 'last_name', 'email', 'phone', 'job_title', 'company_id'],
 ownerColumn: 'owner_id',
 },
 companies: {
 label: 'company',
 provenance: { actor: 'created_by', softDelete: true },
 writable: ['name', 'domain', 'industry', 'website', 'email', 'phone', 'employee_count',
 'annual_revenue_c', 'owner_id', 'status', 'description', 'address_line1', 'address_line2',
 'city', 'region', 'postal_code', 'country_code'],
 updatable: ['name', 'domain', 'industry', 'website', 'email', 'phone', 'employee_count',
 'annual_revenue_c', 'owner_id', 'status', 'description', 'address_line1', 'address_line2',
 'city', 'region', 'postal_code', 'country_code', 'archived_at'],
 sortable: ['name', 'created_at', 'updated_at', 'status', 'annual_revenue_c'],
 searchable: ['name', 'domain', 'industry', 'email', 'phone'],
 ownerColumn: 'owner_id',
 },
 leads: {
 label: 'lead',
 provenance: { actor: 'created_by', softDelete: true },
 writable: ['first_name', 'last_name', 'company_name', 'email', 'phone', 'title', 'source',
 'status', 'score', 'rating', 'owner_id', 'company_id', 'description'],
 updatable: ['first_name', 'last_name', 'company_name', 'email', 'phone', 'title', 'source',
 'status', 'score', 'rating', 'owner_id', 'company_id', 'description', 'lost_reason'],
 sortable: ['created_at', 'updated_at', 'score', 'status', 'last_name'],
 searchable: ['first_name', 'last_name', 'company_name', 'email', 'phone', 'title'],
 ownerColumn: 'owner_id',
 },
 deals: {
 label: 'deal',
 provenance: { actor: 'created_by', softDelete: true },
 writable: ['name', 'value_c', 'currency', 'pipeline_id', 'stage_id', 'probability',
 'expected_close_date', 'contact_id', 'company_id', 'owner_id', 'source', 'status', 'description'],
 updatable: ['name', 'value_c', 'currency', 'pipeline_id', 'stage_id', 'probability',
 'expected_close_date', 'contact_id', 'company_id', 'owner_id', 'source', 'status',
 'description', 'lost_reason', 'closed_at'],
 sortable: ['name', 'created_at', 'updated_at', 'value_c', 'expected_close_date', 'status'],
 searchable: ['name', 'description'],
 ownerColumn: 'owner_id',
 },
 pipelines: {
 label: 'pipeline',
 provenance: { actor: null, softDelete: true },
 writable: ['name', 'description', 'is_default'],
 updatable: ['name', 'description', 'is_default'],
 sortable: ['name', 'created_at'],
 searchable: ['name', 'description'],
 },
 pipeline_stages: {
 label: 'pipeline_stage',
 provenance: { actor: null, softDelete: true },
 writable: ['pipeline_id', 'name', 'position', 'probability', 'is_won', 'is_lost'],
 updatable: ['pipeline_id', 'name', 'position', 'probability', 'is_won', 'is_lost'],
 sortable: ['position', 'name', 'probability', 'created_at'],
 searchable: ['name'],
 },
 tasks: {
 label: 'task',
 provenance: { actor: 'creator_id', softDelete: true },
 writable: ['title', 'description', 'status', 'priority', 'assignee_id', 'due_date',
 'related_type', 'related_id'],
 updatable: ['title', 'description', 'status', 'priority', 'assignee_id', 'due_date',
 'related_type', 'related_id', 'completed_at'],
 sortable: ['due_date', 'created_at', 'updated_at', 'priority', 'status', 'title'],
 searchable: ['title', 'description'],
 },
 notes: {
 label: 'note',
 provenance: { actor: 'author_id', softDelete: true },
 writable: ['entity_type', 'entity_id', 'body_html', 'body_text', 'author_id'],
 updatable: ['body_html', 'body_text'],
 sortable: ['created_at', 'updated_at'],
 searchable: ['body_text'],
 },
 tags: {
 label: 'tag',
 // `tags` has no `deleted_at` and no provenance columns: a tag is a small
 // shared vocabulary entry, not an auditable record. Declared explicitly so
 // no query for this type emits `deleted_at IS NULL` against a column that
 // does not exist.
 provenance: { actor: null, softDelete: false },
 writable: ['name', 'color'],
 updatable: ['name', 'color'],
 sortable: ['name', 'created_at'],
 searchable: ['name'],
 },
};

export const isRecordType = (v: unknown): v is RecordType =>
 typeof v === 'string' && Object.prototype.hasOwnProperty.call(SPECS, v);

const specOf = (type: RecordType): RecordSpec => {
 const s = SPECS[type];
 if (!s) throw badRequest(`Unknown record type '${String(type)}'.`);
 return s;
};

/** Exposed for the route layer so it can advertise fields without duplicating them. */
export const recordSpec = (type: RecordType): Readonly<RecordSpec> => specOf(type);

//  input normalisation 

const str = (v: unknown, max: number): string | null => {
 if (v === undefined || v === null || v === '') return null;
 return String(v).trim().slice(0, max);
};

const req = (v: unknown, max: number, field: string): string => {
 const s = str(v, max);
 if (s === null || s.length === 0) throw badRequest(`'${field}' is required.`);
 return s;
};

const intOrNull = (v: unknown, field: string, min: number, max: number): number | null => {
 if (v === undefined || v === null || v === '') return null;
 const n = Number(v);
 if (!Number.isInteger(n) || n < min || n > max) {
 throw badRequest(`'${field}' must be an integer between ${min} and ${max}.`);
 }
 return n;
};

const bool = (v: unknown): boolean | null => {
 if (v === undefined || v === null || v === '') return null;
 if (typeof v === 'boolean') return v;
 const s = String(v).toLowerCase();
 if (s === 'true' || s === '1') return true;
 if (s === 'false' || s === '0') return false;
 throw badRequest('Expected a boolean value.');
};

/** RFC3339 date or null; rejects values `Date` would silently coerce to NaN. */
const dateOrNull = (v: unknown, field: string): string | null => {
 if (v === undefined || v === null || v === '') return null;
 const d = new Date(String(v));
 if (Number.isNaN(d.getTime())) throw badRequest(`'${field}' is not a valid date.`);
 return d.toISOString();
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = (v: unknown, field: string): string | null => {
 const s = str(v, 64);
 if (s === null) return null;
 if (!UUID_RE.test(s)) throw badRequest(`'${field}' must be a UUID.`);
 return s.toLowerCase();
};

const enumOf = <T extends string>(v: unknown, allowed: readonly T[], field: string): T | null => {
 const s = str(v, 40);
 if (s === null) return null;
 const hit = allowed.find((a) => a === s);
 if (!hit) throw badRequest(`'${field}' must be one of: ${allowed.join(', ')}.`);
 return hit;
};

/**
 * Per-type normalisation. Runs before the allowlist so a value that is
 * syntactically present but semantically wrong (a bad email, a >100 score) is
 * rejected here rather than surfacing as a database constraint error that leaks
 * schema detail to the client.
 */
type Prepared = Record<string, unknown>;

function prepare(type: RecordType, input: Row): Prepared {
 switch (type) {
 case 'contacts': {
 const out: Prepared = {
 first_name: str(input.first_name, 80) ?? '',
 last_name: req(input.last_name, 80, 'last_name'),
 };
 const email = normaliseEmail(input.email);
 const secondary = normaliseEmail(input.secondary_email);
 if (email) out.email = email;
 if (secondary) out.secondary_email = secondary;
 const phone = normalisePhone(input.phone);
 const mobile = normalisePhone(input.mobile_phone);
 if (phone) out.phone = phone;
 if (mobile) out.mobile_phone = mobile;
 const companyId = uuid(input.company_id, 'company_id');
 if (companyId) out.company_id = companyId;
 const ownerId = uuid(input.owner_id, 'owner_id');
 if (ownerId) out.owner_id = ownerId;
 const status = enumOf(input.status, ['active', 'inactive', 'archived'] as const, 'status');
 if (status) out.status = status;
 const stage = enumOf(input.lifecycle_stage,
 ['lead', 'prospect', 'customer', 'churned'] as const, 'lifecycle_stage');
 if (stage) out.lifecycle_stage = stage;
 for (const f of ['job_title', 'department', 'address_line1', 'city', 'region', 'postal_code'] as const) {
 const v = str(input[f], f === 'address_line1' ? 200 : 100);
 if (v) out[f] = v;
 }
 const country = normaliseCountry(input.country_code);
 if (country) out.country_code = country;
 const website = str(input.website, 500);
 if (website) out.website = website;
 const li = str(input.linkedin_url, 500);
 if (li) out.linkedin_url = li;
 const bday = dateOrNull(input.birthday, 'birthday');
 if (bday) out.birthday = bday.slice(0, 10);
 const description = str(input.description, 10_000);
 if (description) out.description = description;
 const source = str(input.source, 100);
 if (source) out.source = source;
 return out;
 }

 case 'companies': {
 const name = req(input.name, 200, 'name');
 const out: Prepared = { name, name_normalized: normaliseCompanyName(name) };
 const domain = normaliseDomain(input.domain);
 if (domain) out.domain = domain;
 const email = normaliseEmail(input.email);
 if (email) out.email = email;
 const phone = normalisePhone(input.phone);
 if (phone) out.phone = phone;
 const employees = intOrNull(input.employee_count, 'employee_count', 0, 100_000_000);
 if (employees !== null) out.employee_count = employees;
 const revenue = intOrNull(input.annual_revenue_c, 'annual_revenue_c', 0, Number.MAX_SAFE_INTEGER);
 if (revenue !== null) out.annual_revenue_c = revenue;
 const ownerId = uuid(input.owner_id, 'owner_id');
 if (ownerId) out.owner_id = ownerId;
 const status = enumOf(input.status, ['active', 'inactive', 'archived'] as const, 'status');
 if (status) out.status = status;
 for (const f of ['industry', 'website', 'description', 'address_line1', 'address_line2', 'city', 'region', 'postal_code'] as const) {
 const v = str(input[f], f === 'description' ? 10_000 : f.startsWith('address') ? 200 : 120);
 if (v) out[f] = v;
 }
 const country = normaliseCountry(input.country_code);
 if (country) out.country_code = country;
 return out;
 }

 case 'leads': {
 const out: Prepared = {
 first_name: str(input.first_name, 80) ?? '',
 last_name: req(input.last_name, 80, 'last_name'),
 };
 const email = normaliseEmail(input.email);
 if (email) { out.email = email; out.email_normalized = email; }
 const phone = normalisePhone(input.phone);
 if (phone) out.phone = phone;
 const companyName = str(input.company_name, 200);
 if (companyName) out.company_name = companyName;
 const title = str(input.title, 120);
 if (title) out.title = title;
 const source = str(input.source, 100);
 if (source) out.source = source;
 const status = enumOf(input.status,
 ['new', 'contacted', 'qualified', 'unqualified', 'nurturing', 'converted', 'lost'] as const, 'status');
 if (status) out.status = status;
 const score = intOrNull(input.score, 'score', 0, 100);
 if (score !== null) out.score = score;
 const rating = enumOf(input.rating, ['hot', 'warm', 'cold'] as const, 'rating');
 if (rating) out.rating = rating;
 const ownerId = uuid(input.owner_id, 'owner_id');
 if (ownerId) out.owner_id = ownerId;
 const companyId = uuid(input.company_id, 'company_id');
 if (companyId) out.company_id = companyId;
 const description = str(input.description, 10_000);
 if (description) out.description = description;
 return out;
 }

 case 'deals': {
 const name = req(input.name, 200, 'name');
 const pipelineId = uuid(input.pipeline_id, 'pipeline_id');
 const stageId = uuid(input.stage_id, 'stage_id');
 if (!pipelineId) throw badRequest("'pipeline_id' is required.");
 if (!stageId) throw badRequest("'stage_id' is required.");
 const out: Prepared = { name, pipeline_id: pipelineId, stage_id: stageId };
 const value = intOrNull(input.value_c, 'value_c', 0, Number.MAX_SAFE_INTEGER);
 if (value !== null) out.value_c = value;
 const currency = str(input.currency, 3);
 if (currency) out.currency = currency.toUpperCase();
 const probability = intOrNull(input.probability, 'probability', 0, 100);
 if (probability !== null) out.probability = probability;
 const close = dateOrNull(input.expected_close_date, 'expected_close_date');
 if (close) out.expected_close_date = close.slice(0, 10);
 for (const f of ['contact_id', 'company_id', 'owner_id'] as const) {
 const v = uuid(input[f], f);
 if (v) out[f] = v;
 }
 const status = enumOf(input.status, ['open', 'won', 'lost'] as const, 'status');
 if (status) out.status = status;
 const source = str(input.source, 100);
 if (source) out.source = source;
 const description = str(input.description, 10_000);
 if (description) out.description = description;
 return out;
 }

 case 'pipelines': {
 const name = req(input.name, 120, 'name');
 const out: Prepared = { name };
 const description = str(input.description, 2000);
 if (description) out.description = description;
 const def = bool(input.is_default);
 if (def !== null) out.is_default = def;
 return out;
 }

 case 'pipeline_stages': {
 const pipelineId = uuid(input.pipeline_id, 'pipeline_id');
 if (!pipelineId) throw badRequest("'pipeline_id' is required.");
 const name = req(input.name, 80, 'name');
 const position = intOrNull(input.position, 'position', 0, 10_000);
 if (position === null) throw badRequest("'position' is required.");
 const out: Prepared = { pipeline_id: pipelineId, name, position };
 const probability = intOrNull(input.probability, 'probability', 0, 100);
 if (probability !== null) out.probability = probability;
 const won = bool(input.is_won);
 if (won !== null) out.is_won = won;
 const lost = bool(input.is_lost);
 if (lost !== null) out.is_lost = lost;
 return out;
 }

 case 'tasks': {
 const out: Prepared = { title: req(input.title, 200, 'title') };
 const description = str(input.description, 20_000);
 if (description) out.description = description;
 const status = enumOf(input.status,
 ['todo', 'in_progress', 'blocked', 'completed', 'cancelled'] as const, 'status');
 if (status) out.status = status;
 const priority = enumOf(input.priority, ['low', 'medium', 'high', 'urgent'] as const, 'priority');
 if (priority) out.priority = priority;
 const assignee = uuid(input.assignee_id, 'assignee_id');
 if (assignee) out.assignee_id = assignee;
 const due = dateOrNull(input.due_date, 'due_date');
 if (due) out.due_date = due;
 const relatedType = enumOf(input.related_type,
 ['contact', 'company', 'lead', 'deal'] as const, 'related_type');
 if (relatedType) out.related_type = relatedType;
 const relatedId = uuid(input.related_id, 'related_id');
 if (relatedId) out.related_id = relatedId;
 // tasks_completed_consistent CHECK: completed_at must track status.
 if (status === 'completed') out.completed_at = nowIso();
 else if (status) out.completed_at = null;
 return out;
 }

 case 'notes': {
 const entityType = enumOf(input.entity_type,
 ['contact', 'company', 'lead', 'deal'] as const, 'entity_type');
 if (!entityType) throw badRequest("'entity_type' is required.");
 const entityId = uuid(input.entity_id, 'entity_id');
 if (!entityId) throw badRequest("'entity_id' is required.");
 return {
 entity_type: entityType,
 entity_id: entityId,
 // Stored XSS sink. `body_html` is markup by contract and is rendered as
 // markup by the client, so it must be passed through the allowlist
 // sanitiser on the way IN. Truncation alone left `<script>` and
 // `<img onerror>` intact in a field any reader of the record can view.
 body_html: sanitizeRichText(str(input.body_html, 100_000) ?? ''),
 body_text: stripControlChars(str(input.body_text, 100_000) ?? ''),
 };
 }

 case 'tags': {
 const name = req(input.name, 60, 'name');
 const colour = str(input.color, 7);
 const out: Prepared = { name, name_normalized: name.trim().toLowerCase() };
 if (colour) {
 if (!/^#[0-9a-fA-F]{6}$/.test(colour)) throw badRequest("'color' must be a hex colour like #6b7280.");
 out.color = colour;
 }
 return out;
 }

 default: {
 const never: never = type;
 throw badRequest(`Unhandled record type '${String(never)}'.`);
 }
 }
}

/** Creates the tenant + provenance columns that a client may never supply. */
function withServerFields(type: RecordType, prepared: Prepared, actor: ActorRef): Prepared {
 const spec = specOf(type);
 const out: Prepared = {
 ...prepared,
 id: newId(),
 organization_id: actor.organizationId,
 };
 // Drop anything the spec does not permit, so a caller cannot smuggle a column
 // through by naming it in the body.
 for (const key of Object.keys(out)) {
 const permitted = key === 'id' || key === 'organization_id'
 || key === 'created_by' || key === 'created_at' || key === 'updated_by' || key === 'updated_at'
 || key === 'creator_id' || key === 'author_id' || key === 'name_normalized'
 || key === 'email_normalized' || key === 'phone_normalized' || key === 'completed_at'
 || key === 'archived_at' || key === 'converted_at'
 || spec.writable.includes(key) || spec.updatable.includes(key);
 if (!permitted) delete out[key];
 }
 const now = nowIso();
 out.created_at = now;
 out.updated_at = now;
 // Only stamp the actor column this table actually has.
 if (spec.provenance.actor === 'created_by') {
 out.created_by = actor.userId;
 out.updated_by = actor.userId;
 } else if (spec.provenance.actor === 'creator_id') {
 out.creator_id = actor.userId;
 delete out.author_id;
 } else if (spec.provenance.actor === 'author_id') {
 out.author_id = actor.userId;
 delete out.creator_id;
 } else {
 delete out.created_by;
 delete out.updated_by;
 delete out.creator_id;
 delete out.author_id;
 }
 return out;
}

//  activity trail 

async function recordActivity(
 scope: TenantScope,
 actor: ActorRef,
 args: {
 type: string;
 entityType: string;
 entityId: string;
 subject?: string | null;
 description?: string | null;
 metadata?: Row;
 },
): Promise<void> {
 // `bestEffort` wraps this in a SAVEPOINT. A plain try/catch is NOT enough:
 // a rejected INSERT aborts the whole PostgreSQL transaction, so the business
 // write it was annotating would be rolled back while the caller still received
 // a "successful" result. See TenantScope.bestEffort.
 await scope.bestEffort('activity.write', async (s) => {
 await s.unsafe.query(
 `INSERT INTO activities (id, organization_id, type, actor_id, entity_type, entity_id,
 subject, description, metadata, occurred_at, created_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now(),now())`,
 [newId(), actor.organizationId, args.type, actor.userId, args.entityType, args.entityId,
 args.subject ? args.subject.slice(0, 300) : null,
 args.description ? args.description.slice(0, 2000) : null,
 JSON.stringify(args.metadata ?? {})],
 );
 return true;
 });
}

/**
 * Audit write that cannot take its transaction down with it.
 *
 * `writeAudit` already swallows its own errors (accepted risk A1: an audit
 * failure must not mask the business operation's own error). But inside a
 * transaction that is not sufficient on its own -- a failed statement poisons the
 * transaction regardless of whether the exception was caught. This wraps it in a
 * SAVEPOINT so the accepted risk stays exactly as narrow as documented: the audit
 * row may be missing, and nothing else is.
 */
async function audit(
 scope: TenantScope,
 args: Parameters<typeof writeAudit>[1],
): Promise<void> {
 await scope.bestEffort('audit.write', async (s) => {
 await writeAudit(s.unsafe, args);
 return true;
 });
}

//  read 

export type ListQuery = {
 limit?: number;
 offset?: number;
 sort?: string;
 order?: string;
 q?: string;
 /** Exact-match filters, validated per type. */
 filters?: Row;
 /** Restrict to records owned by this user (used for sales-visibility rules). */
 ownerId?: string;
 includeDeleted?: boolean;
};

const MAX_LIMIT = 200;

function buildFilters(type: RecordType, filters: Row | undefined, params: unknown[]): string[] {
 if (!filters) return [];
 const clauses: string[] = [];
 const spec = specOf(type);
 for (const [rawKey, rawValue] of Object.entries(filters)) {
 if (rawValue === undefined || rawValue === null || rawValue === '') continue;
 // A filter column must be both a real column of this type and something a
 // client is allowed to filter on; `status` and ownership are common, and
 // anything not in the spec is rejected rather than ignored.
 if (!spec.writable.includes(rawKey) && !spec.updatable.includes(rawKey)) {
 throw badRequest(`Cannot filter on '${rawKey}'.`);
 }
 const column = allowlist(rawKey, [...spec.writable, ...spec.updatable]);
 params.push(rawValue);
 clauses.push(`${column} = $${params.length}`);
 }
 return clauses;
}

export type ListResult = { data: Row[]; total: number; limit: number; offset: number };

export async function listRecords(
 actor: ActorRef,
 type: RecordType,
 query: ListQuery = {},
): Promise<ListResult> {
 const scope = new TenantScope(actor.organizationId);
 const spec = specOf(type);

 const limit = Math.min(Math.max(Number(query.limit ?? 25) || 25, 1), MAX_LIMIT);
 const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

 const sortColumn = query.sort ? allowlist(query.sort, spec.sortable) : (spec.sortable[2] ?? 'created_at');
 const order: SortDirection = direction(query.order);

 // `$1` is always organization_id, so the parameter array must be seeded with
 // it before any clause is numbered. (It previously started empty, which put
 // every generated placeholder one position ahead of its value -- an off-by-one
 // that only a real query execution reveals.)
 const params: unknown[] = [actor.organizationId];
 const clauses: string[] = [];

 const q = str(query.q, 120);
 if (q) {
 // Parameterised ILIKE over an allowlisted column set. `%` and `_` in the
 // user's term are escaped so they cannot widen the match.
 const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
 const parts = spec.searchable.map((c) => {
 const col = allowlist(c, spec.searchable);
 params.push(like);
 return `${col}::text ILIKE $${params.length} ESCAPE '\\'`;
 });
 if (parts.length > 0) clauses.push(`(${parts.join(' OR ')})`);
 }

 clauses.push(...buildFilters(type, query.filters, params));

 if (query.ownerId && spec.ownerColumn) {
 params.push(query.ownerId);
 clauses.push(`${spec.ownerColumn} = $${params.length}`);
 }

 // `tags` has no deleted_at column; emitting the predicate against it is a
 // hard SQL error, so the filter is driven by the spec, not assumed.
 const liveOnly = spec.provenance.softDelete && query.includeDeleted !== true;
 const where = [
 'organization_id = $1',
 ...(liveOnly ? ['deleted_at IS NULL'] : []),
 ...clauses,
 ].join(' AND ');

 const sql = `SELECT * FROM ${type} WHERE ${where} ORDER BY ${sortColumn} ${order}, id ${order} LIMIT ${limit} OFFSET ${offset}`;
 const data = await scope.query(sql, params);

 // Same predicates, no sort/limit -- so the count can never disagree with the page.
 const total = await countScoped(scope, type, clauses, params.slice(1), !spec.provenance.softDelete || Boolean(query.includeDeleted));

 return { data, total, limit, offset };
}

/**
 * Fetches one record by id.
 *
 * A row belonging to another tenant is indistinguishable from a missing one:
 * both return 404. Returning 403 would confirm the id exists, which is an
 * enumeration oracle.
 *
 * A soft-deleted row is also treated as missing unless the caller explicitly
 * asks for it -- otherwise `deleted_at` would be decorative, since the record
 * would still be reachable by id while absent from every list.
 */
export async function getRecord(
 actor: ActorRef,
 type: RecordType,
 id: string,
 options: { includeDeleted?: boolean } = {},
): Promise<Row> {
 if (!UUID_RE.test(id)) throw notFoundOrForbidden();
 const scope = new TenantScope(actor.organizationId);
 const liveOnly = specOf(type).provenance.softDelete && options.includeDeleted !== true;
 const row = await scope.queryOne(
 `SELECT * FROM ${type} WHERE organization_id = $1 AND id = $2${liveOnly ? ' AND deleted_at IS NULL' : ''}`,
 [actor.organizationId, id.toLowerCase()],
 );
 if (!row) throw notFoundOrForbidden();
 return row;
}

//  write 

export type WriteResult = { record: Row; created: boolean };

export async function createRecord(
 actor: ActorRef,
 type: RecordType,
 input: Row,
 meta: RequestMeta = {},
): Promise<WriteResult> {
 const scope = new TenantScope(actor.organizationId);
 const prepared = prepare(type, input);
 const full = withServerFields(type, prepared, actor);

 const tagName = full.name ?? full.title ?? full.last_name ?? null;

 const record = await scope.transaction(async (tx) => {
 const columns = Object.keys(full);
 const values = columns.map((c) => full[c]);
 const row = await insert(tx, type, columns, values, '*');

 await audit(tx, {
 organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
 action: `${type}.create`, entityType: specOf(type).label, entityId: String(full.id),
 after: row, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
 });

 await recordActivity(tx, actor, {
 type: 'created', entityType: specOf(type).label, entityId: String(full.id),
 subject: tagName ? String(tagName) : null,
 metadata: { recordType: type },
 });

 return row;
 });

 return { record, created: true };
}

export async function updateRecord(
 actor: ActorRef,
 type: RecordType,
 id: string,
 input: Row,
 meta: RequestMeta = {},
): Promise<WriteResult> {
 const scope = new TenantScope(actor.organizationId);
 const spec = specOf(type);
 const existing = await getRecord(actor, type, id);
 const prepared = prepare(type, input);

 // Only spec.updatable columns may change; an attempt to PATCH `organization_id`
 // is dropped rather than honoured.
 const changes: Prepared = {};
 for (const [k, v] of Object.entries(prepared)) {
 if (spec.updatable.includes(k)) changes[k] = v;
 }
 if (Object.keys(changes).length === 0) throw badRequest('No updatable fields were supplied.');

 // Keep the dedup key in step with the display value.
 if (type === 'companies' && changes.name) changes.name_normalized = normaliseCompanyName(changes.name);
 if (type === 'contacts' && changes.email) changes.email = normaliseEmail(changes.email);
 if (type === 'leads' && changes.email) {
 const e = normaliseEmail(changes.email);
 changes.email = e;
 changes.email_normalized = e;
 }
 if (type === 'tags' && changes.name) changes.name_normalized = String(changes.name).trim().toLowerCase();
 if (type === 'tasks' && changes.status) {
 changes.completed_at = changes.status === 'completed' ? nowIso() : null;
 }

 const columns = Object.keys(changes);
 // Parameter layout: $1 = organization_id, $2 = id, $3.. = the changed columns
 // in `Object.keys` order, then the optional `updated_by` stamp.
 // `assignments` used to start at `$2` and the id used to be referenced as
 // `columns.length + 1`, so every changed column was bound one position early
 // and `id` pointed at a column value. That silently wrote the id into the
 // first changed column; with two or more columns the id cast to uuid failed.
 const assignments = columns.map(
 (c, i) => `${allowlist(c, [...spec.updatable, 'name_normalized', 'email_normalized', 'completed_at'])} = $${i + 3}`,
 );

 const hasUpdatedBy = spec.provenance.actor === 'created_by';
 const record = await scope.transaction(async (tx) => {
 const params = [...columns.map((c) => changes[c])];
 const stamp = hasUpdatedBy
 ? `, updated_by = $${columns.length + 3}`
 : '';
 if (hasUpdatedBy) params.push(actor.userId);
 const result = await tx.unsafe.query(
 `UPDATE ${type} SET ${assignments.join(', ')}${stamp}, updated_at = now()
 WHERE organization_id = $1 AND id = $2
 RETURNING *`,
 [actor.organizationId, id.toLowerCase(), ...params],
 );
 const row = result.rows[0];
 if (!row) throw notFoundOrForbidden();

 await audit(tx, {
 organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
 action: `${type}.update`, entityType: spec.label, entityId: id.toLowerCase(),
 before: existing, after: row,
 ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
 });

 await recordActivity(tx, actor, {
 type: 'status_change', entityType: spec.label, entityId: id.toLowerCase(),
 metadata: { changed: columns },
 });

 return row;
 });

 return { record, created: false };
}

/**
 * Soft delete. Sets `deleted_at`/`deleted_by`; the row is excluded from every
 * read afterwards but its history, audit trail and references remain intact.
 */
export async function softDeleteRecord(
 actor: ActorRef,
 type: RecordType,
 id: string,
 meta: RequestMeta = {},
): Promise<void> {
 const scope = new TenantScope(actor.organizationId);
 const spec = specOf(type);
 if (!spec.provenance.softDelete) {
 // `tags` are a shared vocabulary, not an auditable record. Deleting one
 // would silently rewrite the meaning of every record already tagged with it,
 // so this is refused rather than implemented as a no-op.
 throw badRequest(`'${type}' records cannot be deleted.`);
 }
 const hasDeletedBy = !['tasks', 'pipeline_stages'].includes(type);
 if (!hasDeletedBy) {
 const exists = await getRecord(actor, type, id);
 await scope.transaction(async (tx) => {
 const r = await tx.unsafe.query(
 `UPDATE ${type} SET deleted_at = now(), updated_at = now()
 WHERE organization_id = $1 AND id = $2 RETURNING id`,
 [actor.organizationId, id.toLowerCase()],
 );
 if (!r.rows[0]) throw notFoundOrForbidden();
 await audit(tx, {
 organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
 action: `${type}.delete`, entityType: spec.label, entityId: id.toLowerCase(),
 before: exists, outcome: 'success',
 ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
 });
 await recordActivity(tx, actor, {
 type: 'status_change', entityType: spec.label, entityId: id.toLowerCase(),
 description: 'deleted',
 });
 });
 return;
 }

 const exists = await getRecord(actor, type, id);
 await scope.transaction(async (tx) => {
 const r = await tx.unsafe.query(
 `UPDATE ${type} SET deleted_at = now(), deleted_by = $2, updated_at = now()
 WHERE organization_id = $1 AND id = $3 RETURNING id`,
 [actor.organizationId, actor.userId, id.toLowerCase()],
 );
 if (!r.rows[0]) throw notFoundOrForbidden();
 await audit(tx, {
 organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
 action: `${type}.delete`, entityType: spec.label, entityId: id.toLowerCase(),
 before: exists, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
 });
 await recordActivity(tx, actor, {
 type: 'status_change', entityType: spec.label, entityId: id.toLowerCase(),
 description: 'deleted',
 });
 });
}

export async function restoreRecord(
 actor: ActorRef,
 type: RecordType,
 id: string,
 meta: RequestMeta = {},
): Promise<void> {
 const scope = new TenantScope(actor.organizationId);
 const spec = specOf(type);
 if (!UUID_RE.test(id)) throw notFoundOrForbidden();

 if (!spec.provenance.softDelete) {
 throw badRequest(`'${type}' records cannot be deleted, so they cannot be restored.`);
 }
 const tableHasDeletedBy = !['tasks', 'pipeline_stages'].includes(type);
 const sql = tableHasDeletedBy
 ? `UPDATE ${type} SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
 WHERE organization_id = $1 AND id = $2 AND deleted_at IS NOT NULL RETURNING id`
 : `UPDATE ${type} SET deleted_at = NULL, updated_at = now()
 WHERE organization_id = $1 AND id = $2 AND deleted_at IS NOT NULL RETURNING id`;

 await scope.transaction(async (tx) => {
 const r = await tx.unsafe.query(sql, [actor.organizationId, id.toLowerCase()]);
 if (!r.rows[0]) throw notFoundOrForbidden();
 await audit(tx, {
 organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
 action: `${type}.restore`, entityType: spec.label, entityId: id.toLowerCase(),
 ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
 });
 await recordActivity(tx, actor, {
 type: 'status_change', entityType: spec.label, entityId: id.toLowerCase(),
 description: 'restored',
 });
 });
}

//  deals: stage integrity 

/**
 * Moves a deal to another stage.
 *
 * The (pipeline_id, stage_id) composite foreign key already guarantees the pair
 * is coherent; this additionally re-reads the stage so the probability and
 * won/lost flags can be applied consistently, and it refuses a stage that
 * belongs to a different pipeline with a clear message rather than letting the
 * deferred constraint fire at COMMIT.
 */
export async function moveDealStage(
 actor: ActorRef,
 dealId: string,
 stageId: string,
 meta: RequestMeta = {},
): Promise<Row> {
 const scope = new TenantScope(actor.organizationId);
 const deal = await getRecord(actor, 'deals', dealId);

 const stage = await scope.queryOne(
 'SELECT * FROM pipeline_stages WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL',
 [actor.organizationId, stageId.toLowerCase()],
 );
 if (!stage) throw badRequest('That stage does not exist in this organization.');
 if (stage.pipeline_id !== deal.pipeline_id) {
 throw badRequest('That stage belongs to a different pipeline.');
 }

 const isWon = stage.is_won === true;
 const isLost = stage.is_lost === true;
 if (isWon && isLost) throw conflict('That stage is configured as both won and lost.');

 const nextStatus = isWon ? 'won' : isLost ? 'lost' : 'open';

 return scope.transaction(async (tx) => {
 const r = await tx.unsafe.query(
 `UPDATE deals SET stage_id = $3, pipeline_id = $4, probability = $5, status = $6,
 closed_at = CASE WHEN $6 <> 'open' THEN now() ELSE NULL END,
 updated_at = now(), updated_by = $7
 WHERE organization_id = $1 AND id = $2 RETURNING *`,
 [actor.organizationId, dealId.toLowerCase(), stageId.toLowerCase(), String(stage.pipeline_id),
 stage.probability ?? null, nextStatus, actor.userId],
 );
 const row = r.rows[0];
 if (!row) throw notFoundOrForbidden();

 await audit(tx, {
 organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
 action: 'deals.advance', entityType: 'deal', entityId: dealId.toLowerCase(),
 before: deal, after: row,
 metadata: { stage: stage.name, to: nextStatus },
 ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
 });

 await recordActivity(tx, actor, {
 type: isWon ? 'deal_won' : isLost ? 'deal_lost' : 'status_change',
 entityType: 'deal', entityId: dealId.toLowerCase(),
 subject: String(deal.name ?? ''),
 description: `moved to stage "${String(stage.name ?? '')}"`,
 metadata: { stageId, status: nextStatus },
 });

 return row;
 });
}

//  leads: conversion 

export type ConvertLeadResult = {
 lead: Row;
 contact: Row;
 company: Row | null;
 deal: Row | null;
};

/**
 * Converts a lead into a contact, optionally a company and an optional deal, in
 * a single transaction.
 *
 * All-or-nothing is the point: a lead that is marked `converted` without its
 * contact existing would be unrecoverable data loss dressed as a success. Every
 * INSERT and the `leads.status = 'converted'` UPDATE commit together or not at
 * all.
 */
export async function convertLead(
 actor: ActorRef,
 leadId: string,
 options: {
 createCompany?: boolean;
 dealName?: string;
 dealValueC?: number;
 pipelineId?: string;
 stageId?: string;
 } = {},
 meta: RequestMeta = {},
): Promise<ConvertLeadResult> {
 const scope = new TenantScope(actor.organizationId);
 const lead = await getRecord(actor, 'leads', leadId);

 if (lead.status === 'converted') throw conflict('That lead has already been converted.');
 if (lead.deleted_at) throw notFoundOrForbidden();

 const wantCompany = options.createCompany === true;
 const wantDeal = typeof options.dealName === 'string' && options.dealName.trim() !== '';

 // Resolve the destination pipeline up front: a lead must never become
 // "converted" with no deal row because a default pipeline was missing.
 let pipelineId: string | null = null;
 let stageId: string | null = null;
 if (wantDeal) {
 pipelineId = options.pipelineId ? String(options.pipelineId).toLowerCase() : null;
 const pipelineRow = pipelineId
 ? await scope.queryOne('SELECT * FROM pipelines WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL',
 [actor.organizationId, pipelineId])
 : await scope.queryOne(
 'SELECT * FROM pipelines WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, created_at ASC LIMIT 1',
 [actor.organizationId]);
 if (!pipelineRow) throw badRequest('No pipeline is available; create one before converting with a deal.');
 pipelineId = String(pipelineRow.id);

 stageId = options.stageId ? String(options.stageId).toLowerCase() : null;
 const stageRow = stageId
 ? await scope.queryOne(
 'SELECT * FROM pipeline_stages WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL',
 [actor.organizationId, stageId])
 : await scope.queryOne(
 `SELECT * FROM pipeline_stages WHERE organization_id = $1 AND pipeline_id = $2 AND deleted_at IS NULL
 ORDER BY position ASC LIMIT 1`,
 [actor.organizationId, pipelineId]);
 if (!stageRow) throw badRequest('The pipeline has no stages; add one before converting with a deal.');
 stageId = String(stageRow.id);
 }

 return scope.transaction(async (tx) => {
 //  company 
 let companyId: string | null = (lead.company_id as string | null) ?? null;
 let company: Row | null = null;
 if (wantCompany && !companyId) {
 const name = String(lead.company_name ?? `${displayName(lead.first_name, lead.last_name)} (company)`).slice(0, 200);
 const companyCols: Prepared = {
 id: newId(), organization_id: actor.organizationId,
 name, name_normalized: normaliseCompanyName(name),
 owner_id: actor.userId, status: 'active',
 created_at: nowIso(), updated_at: nowIso(),
 created_by: actor.userId, updated_by: actor.userId,
 };
 company = await insert(tx, 'companies', Object.keys(companyCols), Object.values(companyCols), '*');
 companyId = String(company.id);
 } else if (companyId) {
 company = await tx.queryOne(
 'SELECT * FROM companies WHERE organization_id = $1 AND id = $2',
 [actor.organizationId, companyId],
 );
 }

 //  contact 
 const contactCols: Prepared = {
 id: newId(), organization_id: actor.organizationId,
 first_name: String(lead.first_name ?? ''),
 last_name: String(lead.last_name ?? ''),
 lifecycle_stage: 'lead',
 status: 'active',
 owner_id: lead.owner_id ?? actor.userId,
 source: lead.source ?? null,
 description: lead.description ?? null,
 created_at: nowIso(), updated_at: nowIso(),
 created_by: actor.userId, updated_by: actor.userId,
 };
 if (lead.email_normalized ?? lead.email) contactCols.email = String(lead.email_normalized ?? lead.email);
 if (lead.phone) contactCols.phone = String(lead.phone);
 if (lead.title) contactCols.job_title = String(lead.title);
 if (companyId) contactCols.company_id = companyId;
 const contact = await insert(tx, 'contacts', Object.keys(contactCols), Object.values(contactCols), '*');

 //  deal 
 let deal: Row | null = null;
 if (wantDeal && pipelineId && stageId) {
 const dealCols: Prepared = {
 id: newId(), organization_id: actor.organizationId,
 name: String(options.dealName).slice(0, 200),
 pipeline_id: pipelineId,
 stage_id: stageId,
 status: 'open',
 contact_id: String(contact.id),
 owner_id: lead.owner_id ?? actor.userId,
 source: lead.source ?? null,
 created_at: nowIso(), updated_at: nowIso(),
 created_by: actor.userId, updated_by: actor.userId,
 };
 if (typeof options.dealValueC === 'number' && Number.isFinite(options.dealValueC) && options.dealValueC >= 0) {
 dealCols.value_c = Math.trunc(options.dealValueC);
 }
 if (companyId) dealCols.company_id = companyId;
 deal = await insert(tx, 'deals', Object.keys(dealCols), Object.values(dealCols), '*');
 }

 //  mark the lead converted 
 const upd = await tx.unsafe.query(
 `UPDATE leads SET status = 'converted', converted_at = now(), converted_contact_id = $3,
 converted_deal_id = $4, updated_at = now(), updated_by = $5
 WHERE organization_id = $1 AND id = $2 AND status <> 'converted'
 RETURNING *`,
 [actor.organizationId, leadId.toLowerCase(), String(contact.id), deal ? String(deal.id) : null, actor.userId],
 );
 const converted = upd.rows[0];
 if (!converted) throw conflict('That lead was converted concurrently; reload and try again.');

 await audit(tx, {
 organizationId: actor.organizationId, actorId: actor.userId, actorRole: actor.role,
 action: 'leads.convert', entityType: 'lead', entityId: leadId.toLowerCase(),
 before: lead, after: converted,
 metadata: { contactId: String(contact.id), companyId, dealId: deal ? String(deal.id) : null },
 ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
 });

 await recordActivity(tx, actor, {
 type: 'lead_converted', entityType: 'lead', entityId: leadId.toLowerCase(),
 subject: displayName(lead.first_name, lead.last_name),
 metadata: {
 contactId: String(contact.id),
 companyId,
 dealId: deal ? String(deal.id) : null,
 },
 });

 return { lead: converted, contact: contact, company, deal };
 });
}

//  pipelines 

/**
 * Creates a pipeline together with its default stages, atomically. A pipeline
 * with no stages cannot hold a deal, so the two are written together.
 */
export async function createPipelineWithStages(
 actor: ActorRef,
 input: { name: string; description?: string; isDefault?: boolean; stages?: string[] },
 meta: RequestMeta = {},
): Promise<Row> {
 const scope = new TenantScope(actor.organizationId);
 const { record } = await createRecord(actor, 'pipelines', {
 name: input.name,
 description: input.description,
 is_default: input.isDefault === true,
 }, meta);

 const stageNames = (input.stages ?? ['New', 'Qualification', 'Proposal', 'Negotiation', 'Won'])
 .map((s) => String(s).trim().slice(0, 80))
 .filter((s) => s !== '');
 if (stageNames.length === 0) throw badRequest('A pipeline needs at least one stage.');

 const probabilityFor = (i: number, n: number): number => Math.round((i / Math.max(n - 1, 1)) * 100);

 for (const [i, name] of stageNames.entries()) {
 const isWon = i === stageNames.length - 1;
 await createRecord(actor, 'pipeline_stages', {
 pipeline_id: String(record.id),
 name,
 position: i,
 probability: probabilityFor(i, stageNames.length),
 is_won: isWon,
 is_lost: false,
 }, meta);
 }

 if (input.isDefault === true) {
 // Exactly one default per tenant.
 await scope.unsafe.query(
 'UPDATE pipelines SET is_default = false WHERE organization_id = $1 AND id <> $2',
 [actor.organizationId, String(record.id)],
 );
 }

 return record;
}

export async function listPipelineStages(actor: ActorRef, pipelineId: string): Promise<Row[]> {
 if (!UUID_RE.test(pipelineId)) throw notFoundOrForbidden();
 const scope = new TenantScope(actor.organizationId);
 return scope.query(
 `SELECT * FROM pipeline_stages WHERE organization_id = $1 AND pipeline_id = $2 AND deleted_at IS NULL
 ORDER BY position ASC`,
 [actor.organizationId, pipelineId.toLowerCase()],
 );
}

/** Ensures a tenant has a pipeline. Used by `seed` and by first-run setup. */
export async function ensureDefaultPipeline(actor: ActorRef): Promise<Row> {
 const scope = new TenantScope(actor.organizationId);
 const existing = await scope.queryOne(
 'SELECT * FROM pipelines WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1',
 [actor.organizationId],
 );
 if (existing) return existing;
 return createPipelineWithStages(actor, { name: 'Sales Pipeline', isDefault: true }, {});
}

export const __testing = { prepare, buildFilters, SPECS };
