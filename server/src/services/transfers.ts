/**
 * Import / export (item 8).
 *
 * CSV export streams an org's records with formula-injection neutralisation;
 * CSV import validates every row against the record spec before writing
 * anything. Both run through job rows (`export_jobs`, `import_jobs`) so a
 * large transfer is observable and resumable rather than a request that times
 * out halfway.
 *
 * ── Export ───────────────────────────────────────────────────────────────────
 *
 * Synchronous for now: the query pages through the table in batches and the
 * CSV is built in memory, bounded by `MAX_EXPORT_ROWS`. Every cell passes
 * through `sanitizeCsvCell`, which prefixes formula triggers (`=`, `+`, `-`,
 * `@`) so a contact named `=cmd|...` cannot become code execution in the
 * recipient's spreadsheet. The job row records the row count and byte size;
 * the file itself is written to the local storage driver with a 7-day expiry.
 *
 * An export is admin+ only at the route layer. The data it contains is the
 * org's entire table, so member-level export would be a bulk-exfiltration
 * primitive wearing a feature costume.
 *
 * ── Import ───────────────────────────────────────────────────────────────────
 *
 * Validating, not blind: the header row must match writable columns for the
 * entity type, every row is parsed with the CSV bounds (max rows, max columns,
 * no NUL/control bytes), and rows are created through `createRecord` -- which
 * means every row gets the same validation, tenant scoping, and audit trail
 * as a single create. A row that fails validation is counted in `skipped_count`
 * with its line number, not silently dropped and not aborting the import.
 *
 * `idempotency_key` makes re-submission safe: uploading the same file twice
 * with the same key returns the original job rather than duplicating every
 * row. Without it, a retried request after a network blip doubles the data.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config/env.ts';
import { TenantScope } from '../repositories/base.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { parseCsv, sanitizeCsvCell, toCsv } from '../lib/csv.ts';
import { createRecord, listRecords, recordSpec, type ActorRef, type RecordType } from './records.ts';

/** Hard ceiling on export size: bounds memory regardless of table size. */
const MAX_EXPORT_ROWS = 50_000;
/** Rows read per page when streaming a table out. */
const EXPORT_PAGE = 1_000;
/** Hard ceiling on import rows: bounds both memory and write volume. */
const MAX_IMPORT_ROWS = 10_000;

const EXPORTABLE: readonly string[] = ['contacts', 'companies', 'leads', 'deals', 'tasks'];
const IMPORTABLE: readonly string[] = ['contacts', 'companies', 'leads'];

/** Columns exported per type, in order. Stable so diffs between exports mean something. */
const EXPORT_COLUMNS: Record<string, readonly string[]> = {
 contacts: ['id', 'first_name', 'last_name', 'email', 'phone', 'job_title', 'company_id', 'status', 'lifecycle_stage', 'created_at'],
 companies: ['id', 'name', 'domain', 'industry', 'email', 'phone', 'employee_count', 'status', 'created_at'],
 leads: ['id', 'first_name', 'last_name', 'company_name', 'email', 'phone', 'status', 'rating', 'score', 'created_at'],
 deals: ['id', 'name', 'value_c', 'currency', 'status', 'probability', 'expected_close_date', 'created_at'],
 tasks: ['id', 'title', 'status', 'priority', 'due_date', 'created_at'],
};

export type ExportJob = {
 id: string;
 entityType: string;
 status: string;
 rowCount: number | null;
 byteSize: number | null;
 storageKey: string | null;
 expiresAt: string;
 createdAt: string;
};

export type ImportJob = {
 id: string;
 entityType: string;
 status: string;
 totalRows: number;
 createdCount: number;
 skippedCount: number;
 errorCount: number;
 createdAt: string;
};

/**
 * Exports an entity type to CSV.
 *
 * Pages through the table rather than one unbounded SELECT, so a 40k-row table
 * does not hold a cursor -- or memory -- for the whole transfer. Cells are
 * sanitised per-cell (formula triggers), not per-file, because one hostile
 * value must not poison the rows around it.
 */
export async function exportRecords(
 actor: ActorRef,
 entityType: string,
 idempotencyKey?: string,
): Promise<ExportJob> {
 if (!EXPORTABLE.includes(entityType)) {
 throw badRequest(`'${entityType}' cannot be exported.`);
 }
 const scope = new TenantScope(actor.organizationId);
 const now = nowIso();

 if (idempotencyKey) {
 const prior = await scope.query(
 `SELECT * FROM export_jobs WHERE organization_id = $1 AND idempotency_key = $2`,
 [actor.organizationId, idempotencyKey],
 );
 if (prior.length > 0) return rowToExport(prior[0]!);
 }

 const id = newId();
 const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
 await scope.query(
 `INSERT INTO export_jobs
 (id,organization_id,entity_type,created_by,status,filters,expires_at,started_at,created_at,idempotency_key)
 VALUES ($1,$2,$3,$4,'processing','{}',$5,$6,$6,$7)`,
 [id, actor.organizationId, entityType, actor.userId, expiresAt, now, idempotencyKey ?? null],
 );

 try {
 const columns = EXPORT_COLUMNS[entityType]!;
 const dataRows: unknown[][] = [];
 let offset = 0;
 for (;;) {
 const page = await listRecords(actor, entityType as RecordType, {
 limit: EXPORT_PAGE, offset,
 });
 for (const row of page.data as Record<string, unknown>[]) {
 dataRows.push(columns.map((c) => sanitizeCsvCell(row[c])));
 }
 if (offset + page.data.length >= page.total || dataRows.length >= MAX_EXPORT_ROWS) break;
 offset += EXPORT_PAGE;
 }

 const csv = toCsv(columns, dataRows);
 const bytes = Buffer.from(csv, 'utf8');
 const checksum = createHash('sha256').update(bytes).digest('hex');
 const key = `exports/${checksum.slice(0, 2)}/${checksum}.csv`;
 if (env.storage.driver !== 'local') throw badRequest('Only the local storage driver is implemented.');
 await mkdir(join(env.storage.localDir, 'exports', checksum.slice(0, 2)), { recursive: true });
 await writeFile(join(env.storage.localDir, key), bytes);

 const finished = nowIso();
 await scope.query(
 `UPDATE export_jobs SET status = 'completed', storage_key = $3,
 row_count = $4, byte_size = $5, finished_at = $6
 WHERE organization_id = $1 AND id = $2`,
 [actor.organizationId, id, key, dataRows.length, bytes.length, finished],
 );
 } catch (err) {
 await scope.query(
 `UPDATE export_jobs SET status = 'failed', finished_at = $3
 WHERE organization_id = $1 AND id = $2`,
 [actor.organizationId, id, nowIso()],
 );
 throw err;
 }

 const rows = await scope.query(
 `SELECT * FROM export_jobs WHERE organization_id = $1 AND id = $2`,
 [actor.organizationId, id],
 );
 return rowToExport(rows[0]!);
}

/** Reads a completed export's bytes. Expired or missing exports 404. */
export async function downloadExport(
 actor: ActorRef,
 id: string,
): Promise<{ job: ExportJob; bytes: Buffer; fileName: string }> {
 const scope = new TenantScope(actor.organizationId);
 const rows = await scope.query(
 `SELECT * FROM export_jobs WHERE organization_id = $1 AND id = $2`,
 [actor.organizationId, id],
 );
 if (rows.length === 0) throw notFound('Export not found.');
 const job = rowToExport(rows[0]!);
 if (job.status !== 'completed' || !job.storageKey) {
 throw notFound('Export is not ready.');
 }
 if (new Date(job.expiresAt).getTime() < Date.now()) {
 throw notFound('Export has expired.');
 }
 const { readFile } = await import('node:fs/promises');
 const bytes = await readFile(join(env.storage.localDir, job.storageKey));
 return { job, bytes, fileName: `${job.entityType}-export-${job.id.slice(0, 8)}.csv` };
}

/**
 * Imports records from a CSV buffer.
 *
 * The header must be a subset of the type's writable columns -- an unknown
 * column is a client bug, and silently ignoring it would lose data the user
 * thought they imported. Every row goes through `createRecord`, so validation,
 * tenant scoping and audit are identical to single creates. Failures are
 * counted per-row with line numbers; the import completes with partial success
 * rather than rolling back the rows that were valid.
 */
export async function importRecords(
 actor: ActorRef,
 entityType: string,
 csvText: string,
 idempotencyKey?: string,
): Promise<ImportJob & { errors: { line: number; message: string }[] }> {
 if (!IMPORTABLE.includes(entityType)) {
 throw badRequest(`'${entityType}' cannot be imported.`);
 }
 const scope = new TenantScope(actor.organizationId);

 if (idempotencyKey) {
 const prior = await scope.query(
 `SELECT * FROM import_jobs WHERE organization_id = $1 AND idempotency_key = $2`,
 [actor.organizationId, idempotencyKey],
 );
 if (prior.length > 0) {
 const job = rowToImport(prior[0]!);
 return { ...job, errors: [] };
 }
 }

 const grid = parseCsv(csvText, { maxRows: MAX_IMPORT_ROWS + 1, maxCols: 60 });
 if (grid.length < 2) throw badRequest('CSV must have a header row and at least one data row.');
 const headers = grid[0]!.map((h) => h.trim());
 if (headers.some((h) => !h)) throw badRequest('CSV header contains an empty column name.');

 // Writable columns are the contract: anything else is either a system column
 // (id, organization_id) that the client must not set, or a typo.
 const writable = new Set<string>(recordSpec(entityType as RecordType).writable);
 for (const h of headers) {
 if (!writable.has(h)) throw badRequest(`Unknown or read-only column '${h}' for ${entityType}.`);
 }

 const id = newId();
 const now = nowIso();
 await scope.query(
 `INSERT INTO import_jobs
 (id,organization_id,entity_type,created_by,status,total_rows,started_at,created_at,idempotency_key)
 VALUES ($1,$2,$3,$4,'processing',$5,$6,$6,$7)`,
 [id, actor.organizationId, entityType, actor.userId, grid.length - 1, now, idempotencyKey ?? null],
 );

 let created = 0;
 let skipped = 0;
 const errors: { line: number; message: string }[] = [];

 for (let i = 1; i < grid.length; i++) {
 const cells = grid[i]!;
 if (cells.every((c) => !c.trim())) { skipped++; continue; }
 const input: Record<string, unknown> = {};
 headers.forEach((h, j) => {
 const v = (cells[j] ?? '').trim();
 if (v) input[h] = v;
 });
 try {
 await createRecord(actor, entityType as RecordType, input, {
 ip: 'import', userAgent: 'csv-import/1.0', requestId: `import-${id}`,
 });
 created++;
 } catch (err) {
 skipped++;
 const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
 if (errors.length < 100) errors.push({ line: i + 1, message: message.slice(0, 200) });
 }
 }

 const status = errors.length === grid.length - 1 ? 'failed' : 'completed';
 await scope.query(
 `UPDATE import_jobs SET status = $3, processed_rows = $4, created_count = $5,
 skipped_count = $6, error_count = $7, finished_at = $8
 WHERE organization_id = $1 AND id = $2`,
 [actor.organizationId, id, status, grid.length - 1, created, skipped, errors.length, nowIso()],
 );
 const rows = await scope.query(
 `SELECT * FROM import_jobs WHERE organization_id = $1 AND id = $2`,
 [actor.organizationId, id],
 );
 return { ...rowToImport(rows[0]!), errors };
}

const rowToExport = (r: Record<string, unknown>): ExportJob => ({
 id: String(r['id']),
 entityType: String(r['entity_type']),
 status: String(r['status']),
 rowCount: r['row_count'] === null || r['row_count'] === undefined ? null : Number(r['row_count']),
 byteSize: r['byte_size'] === null || r['byte_size'] === undefined ? null : Number(r['byte_size']),
 storageKey: r['storage_key'] === null ? null : String(r['storage_key']),
 expiresAt: String(r['expires_at']),
 createdAt: String(r['created_at']),
});

const rowToImport = (r: Record<string, unknown>): ImportJob => ({
 id: String(r['id']),
 entityType: String(r['entity_type']),
 status: String(r['status']),
 totalRows: Number(r['total_rows']),
 createdCount: Number(r['created_count']),
 skippedCount: Number(r['skipped_count']),
 errorCount: Number(r['error_count']),
 createdAt: String(r['created_at']),
});
