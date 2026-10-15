/**
 * Tenant-scoped repository base.
 *
 * RULE 14/15: tenant isolation is enforced in the data layer, not in route
 * handlers. Two mechanisms back that up:
 *
 * 1. Compile-time -- `TenantScope` cannot be constructed without an
 * organizationId, so a tenant query without one is a type error rather than
 * a review comment. Every helper here takes a scope as its first argument.
 *
 * 2. Runtime -- every generated statement carries `organization_id = $n`. There
 * is no `query()` escape hatch exposed on the scope, so a query that omits
 * the tenant predicate cannot be expressed without deliberately going around
 * the abstraction.
 *
 * The legacy CRM leaked across tenants because `company_detail`'s contact query
 * simply omitted `organization_id`. Here that class of bug is unrepresentable.
 *
 * All values are bound parameters. Dynamic identifiers (sort columns, filter
 * keys) go through `allowlist()` which throws on anything unrecognised
 * (RULE 40) -- the one place a SQL fragment is assembled from a string.
 */
import type { DbClient } from '../db/driver.ts';
import { getDb } from '../db/driver.ts';
import { badRequest } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import { tenantDenials } from '../lib/metrics.ts';

export type Row = Record<string, unknown>;

export class TenantScope {
 readonly organizationId: string;
 private readonly tx: DbClient | null;

 constructor(organizationId: string, tx?: DbClient | null) {
 if (!organizationId || typeof organizationId !== 'string') {
 throw new Error('TenantScope requires an organizationId -- tenant scoping is not optional');
 }
 this.organizationId = organizationId;
 this.tx = tx ?? null;
 }

 /**
 * The raw driver. Deliberately NOT exposed as `client`.
 *
 * An earlier revision exposed `client` so services could issue ad-hoc SQL. That
 * re-opened exactly the hole this class exists to close: `SELECT * FROM contacts
 * WHERE id = $1` returns another tenant's row with no error -- the legacy CRM's
 * cross-tenant leak. Security Scenario 1 caught it. Reaching the driver now
 * requires naming it `unsafe`, so the bypass is visible at every call site.
 */
 get unsafe(): DbClient {
 return this.tx ?? driverRef();
 }

 get inTransaction(): boolean { return this.tx !== null; }

 /**
 * SELECT restricted to this tenant. The statement is rejected unless it filters
 * on `organization_id`, so a forgotten predicate fails loudly instead of
 * leaking. Prefer the repository helpers below; this exists for the handful of
 * hand-written list queries.
 */
 async query<T extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
 assertTenantPredicate(sql);
 const r = await this.unsafe.query<T>(sql, params);
 return r.rows;
 }

 async queryOne<T extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
 const rows = await this.query<T>(sql, params);
 return rows[0] ?? null;
 }

 /** Runs a unit of work in a transaction, re-scoping to that transaction. */
 async transaction<T>(fn: (scope: TenantScope) => Promise<T>): Promise<T> {
 return this.unsafe.transaction((tx) => fn(new TenantScope(this.organizationId, tx)));
 }

 /**
 * Runs a best-effort write inside the current transaction without being able
 * to take the transaction down with it.
 *
 * PostgreSQL aborts the *whole* transaction on any statement error, and that
 * is not recoverable by catching the exception in application code: every
 * later statement then fails with `25P02 current transaction is aborted`, and
 * the eventual COMMIT is silently downgraded to a ROLLBACK. An audit row that
 * failed to write therefore did not merely lose the audit row -- it discarded
 * the business write it was supposed to describe, while the caller still held
 * a `RETURNING` result and reported success.
 *
 * That exact failure was reproduced: an activity row rejected by a CHECK
 * constraint made the surrounding `createRecord` transaction roll back, so a
 * pipeline came back "created" from `RETURNING *` and was never in the table.
 *
 * The fix is the SQL idiom: a SAVEPOINT around the optional write. Failure
 * rolls back only to that point, the outer transaction stays usable, and the
 * commit still commits. Outside a transaction this degrades to a plain
 * try/catch, which is equally safe because there is nothing to poison.
 */
 async bestEffort<T>(label: string, fn: (scope: TenantScope) => Promise<T>): Promise<T | null> {
 if (!this.inTransaction) {
 try {
 return await fn(this);
 } catch (err) {
 logger.error({ err, label, organizationId: this.organizationId }, 'best-effort write failed');
 return null;
 }
 }

 // A fixed, non-interpolated savepoint name: `label` is a code constant and
 // must never reach the SQL string.
 const point = 'bigcrm_best_effort';
 try {
 await this.unsafe.exec(`SAVEPOINT ${point}`);
 } catch (err) {
 logger.error({ err, label }, 'could not establish savepoint; skipping optional write');
 return null;
 }
 try {
 const out = await fn(this);
 await this.unsafe.exec(`RELEASE SAVEPOINT ${point}`);
 return out;
 } catch (err) {
 logger.error({ err, label, organizationId: this.organizationId }, 'best-effort write failed and was rolled back');
 try {
 await this.unsafe.exec(`ROLLBACK TO SAVEPOINT ${point}`);
 await this.unsafe.exec(`RELEASE SAVEPOINT ${point}`);
 } catch (rbErr) {
 logger.fatal({ err: rbErr, label }, 'savepoint rollback failed -- transaction is unrecoverable');
 }
 return null;
 }
 }
}

/** Tables that carry tenant data; a SELECT against one must filter organization_id. */
const TENANT_TABLES = [
 'organization_members', 'teams', 'team_members', 'companies', 'contacts', 'leads',
 'pipelines', 'pipeline_stages', 'deals', 'activities', 'tasks', 'notes', 'tags',
 'contact_tags', 'company_tags', 'lead_tags', 'deal_tags', 'custom_fields',
 'custom_field_values', 'attachments', 'comments', 'notifications', 'audit_logs',
 'security_events', 'invitations', 'api_tokens', 'saved_views', 'import_jobs',
 'export_jobs', 'idempotency_keys', 'mfa_challenges',
];

/**
 * Runtime backstop for RULE 15. A statement that touches a tenant table without
 * an organization_id predicate throws instead of returning another tenant's rows.
 */
export function assertTenantPredicate(sql: string): void {
 const touches = TENANT_TABLES.filter((t) =>
 new RegExp(`\\b(?:from|join|update|into)\\s+(?:public\\.)?"?${t}"?\\b`, 'i').test(sql));
 if (touches.length === 0) return;
 if (!/\borganization_id\b/i.test(sql)) {
 throw new Error(
 `TenantScope: statement touches tenant table(s) [${touches.join(', ')}] with no ` +
 'organization_id predicate. Tenant scoping is mandatory (RULE 15).',
 );
 }
}

// Module-level handle so TenantScope can default to the shared driver without
// an import cycle between repositories and db/driver.
let cachedDriver: DbClient | null = null;
export function setDriver(db: DbClient): void { cachedDriver = db; }
function driverRef(): DbClient {
 if (!cachedDriver) throw new Error('database driver not initialised');
 return cachedDriver;
}
export async function initDriver(): Promise<DbClient> {
 if (!cachedDriver) cachedDriver = await getDb();
 return cachedDriver;
}

//  identifier allowlist (the only string-interpolated SQL in the codebase) 
const IDENT_RE = /^[a-z_][a-z0-9_]{0,40}$/;

/**
 * Validates an identifier that will be interpolated into SQL. Refuses anything
 * that is not a plain lowercase SQL identifier, so no quoting or injection
 * vector exists even if a caller passes user input.
 */
export const allowlist = (value: string, permitted: readonly string[]): string => {
 if (!IDENT_RE.test(value)) throw badRequest('Invalid field name.');
 if (!permitted.includes(value)) throw badRequest(`Field '${value}' cannot be used here.`);
 return value;
};

export type SortDirection = 'ASC' | 'DESC';
export const direction = (v: string | undefined): SortDirection =>
 String(v ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

//  query helpers 
export type QueryOptions = { limit: number; offset?: number };

/** SELECT with a mandatory tenant predicate. */
export async function selectAll<T extends Row = Row>(
 scope: TenantScope,
 sql: string,
 params: readonly unknown[] = [],
): Promise<T[]> {
 return scope.query<T>(sql, params);
}

export async function selectOne<T extends Row = Row>(
 scope: TenantScope,
 sql: string,
 params: readonly unknown[] = [],
): Promise<T | null> {
 return scope.queryOne<T>(sql, params);
}

/** Marks a cross-tenant access attempt in metrics for alerting. */
export const noteTenantDenial = (resource: string): void => {
 tenantDenials.inc({ resource });
};

/**
 * Runs a parameterized INSERT.
 * `columns` and `values` must be the same length; identifiers are validated.
 */
export async function insert(
 scope: TenantScope,
 table: string,
 columns: readonly string[],
 values: readonly unknown[],
 returning = '*',
): Promise<Row> {
 const cols = columns.map((c) => allowlist(c, ALL_COLUMNS));
 const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
 const sql = `INSERT INTO ${allowlist(table, ALL_TABLES)} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING ${returning}`;
 const rows = await scope.unsafe.query(sql, values);
 return rows.rows[0] ?? {};
}

/** COUNT scoped to the tenant, honouring deleted_at. */
export async function countScoped(
 scope: TenantScope,
 table: string,
 where: readonly string[] = [],
 params: readonly unknown[] = [],
 includeDeleted = false,
): Promise<number> {
 const t = allowlist(table, ALL_TABLES);
 const clauses = ['organization_id = $1', ...where];
 if (!includeDeleted) clauses.push('deleted_at IS NULL');
 const r = await scope.unsafe.query<{ n: number }>(
 `SELECT count(*)::int AS n FROM ${t} WHERE ${clauses.join(' AND ')}`,
 [scope.organizationId, ...params],
 );
 return r.rows[0]?.n ?? 0;
}

/**
 * Keyset (cursor) pagination over `(sort_column, id)`.
 * Both are already allowlisted by the caller; we only bind their values.
 */
export function keysetClause(
 sortColumn: string,
 dir: SortDirection,
 cursor: { t: string; id: string } | undefined,
 offsetParamIndex: number,
): { sql: string; params: unknown[] } {
 if (!cursor) return { sql: '', params: [] };
 const cmp = dir === 'ASC' ? '>' : '<';
 return {
 sql: `AND (${sortColumn}, id) ${cmp} ($${offsetParamIndex}, $${offsetParamIndex + 1})`,
 params: [cursor.t, cursor.id],
 };
}

//  column/table registries 
/** Every table a repository may touch. Anything else is rejected. */
export const ALL_TABLES = [
 'organizations', 'users', 'organization_members', 'teams', 'team_members',
 'companies', 'contacts', 'leads', 'pipelines', 'pipeline_stages', 'deals',
 'activities', 'tasks', 'notes', 'tags', 'contact_tags', 'company_tags',
 'lead_tags', 'deal_tags', 'custom_fields', 'custom_field_values',
 'attachments', 'comments', 'notifications', 'audit_logs', 'security_events',
 'sessions', 'password_resets', 'email_verifications', 'invitations',
 'mfa_recovery_codes', 'api_tokens', 'saved_views', 'import_jobs', 'export_jobs',
 'idempotency_keys',
] as const;

const COLUMN_RE = /^[a-z_][a-z0-9_]{0,40}$/;
export const isColumn = (v: string): boolean => COLUMN_RE.test(v);

/** Column allowlist for UPDATE/INSERT fragments. */
export const ALL_COLUMNS: readonly string[] = [
 'id', 'organization_id', 'user_id', 'organization_members_id', 'team_id',
 'name', 'slug', 'email', 'email_normalized', 'email_verified_at', 'password_hash',
 'password_changed_at', 'locale', 'timezone', 'avatar_url', 'status', 'role',
 'currency', 'locale', 'data_region', 'retention_days', 'settings',
 'name_normalized', 'domain', 'industry', 'website', 'phone', 'employee_count',
 'annual_revenue_c', 'owner_id', 'description', 'address_line1', 'address_line2',
 'city', 'region', 'postal_code', 'country_code', 'archived_at',
 'first_name', 'last_name', 'company_name', 'company_id', 'secondary_email',
 'phone_normalized', 'mobile_phone', 'job_title', 'department', 'source',
 'lifecycle_stage', 'linkedin_url', 'birthday', 'last_contacted_at',
 'email_normalized', 'score', 'rating', 'lost_reason', 'converted_at',
 'converted_contact_id', 'converted_deal_id',
 'is_default', 'position', 'probability', 'is_won', 'is_lost',
 'value_c', 'pipeline_id', 'stage_id', 'expected_close_date', 'closed_at',
 'title', 'assignee_id', 'creator_id', 'due_date', 'completed_at',
 'related_type', 'related_id', 'priority',
 'entity_type', 'entity_id', 'body_html', 'body_text', 'author_id',
 'color', 'key', 'label', 'field_type', 'options', 'default_value',
 'is_required', 'is_searchable', 'value_text', 'value_number', 'value_date',
 'value_bool', 'value_json',
 'file_id', 'file_name', 'content_type', 'size_bytes', 'storage_key',
 'checksum_sha256', 'version', 'uploaded_by', 'message', 'subject', 'metadata',
 'occurred_at', 'type', 'actor_id', 'link', 'read_at',
 'action', 'outcome', 'before_json', 'after_json', 'changed_fields',
 'ip', 'user_agent', 'request_id', 'severity', 'details', 'event',
 'family_id', 'refresh_jti', 'refresh_hash', 'used_at', 'rotated_at',
 'device_label', 'last_seen_at', 'absolute_expires_at', 'revoked_at',
 'revoked_reason', 'token_hash', 'expires_at', 'requested_ip', 'accepted_at',
 'invited_by', 'mfa_enabled', 'mfa_enrolled_at', 'totp_secret_encrypted',
 'code_hash', 'name_normalized', 'prefix', 'scopes', 'last_used_at',
 'last_used_ip', 'filters', 'sort', 'columns', 'is_shared', 'failed_login_count',
 'locked_until', 'last_login_at', 'last_login_ip', 'default_org_id', 'joined_at',
 'total_rows', 'processed_rows', 'created_count', 'updated_count',
 'skipped_count', 'error_count', 'error_report_key', 'idempotency_key',
 'storage_key', 'original_name', 'row_count', 'byte_size',
 'events', 'payload', 'attempt',
 'request_hash', 'locked_until', 'title',
 // 0003_mfa: the encrypted TOTP secret and the replay window.
 'mfa_last_used_step', 'mfa_recovery_used_at', 'totp_secret_encrypted',
 // mfa_challenges
 'purpose', 'attempts', 'consumed_at',
 // Audit/ownership columns. These were absent from the registry, which meant a
 // legitimate `INSERT` including them failed with "Field 'created_at' cannot be
 // used here" -- a fail-closed error, but one that made every write path in the
 // records service unusable rather than merely wrong. Found by executing
 // services/records.ts against a real database; see SECURITY_FINDINGS.md.
 'created_at', 'updated_at', 'deleted_at', 'created_by', 'updated_by', 'deleted_by',
 'actor_role',
 // Link tables and job/queue columns.
 'contact_id', 'deal_id', 'lead_id', 'tag_id', 'field_id',
 'started_at', 'finished_at', 'endpoint',
 'body',
] as const;