/**
 * Generic record list: search, paginated table, create link.
 *
 * One component serves all five record types, driven by `RECORD_CONFIGS`.
 * A separate hand-written page per type would drift within weeks -- different
 * empty states, different error handling, different pagination bugs. The
 * trade-off is that per-type customisation lives in the config file, which is
 * exactly where a reviewer looks for it.
 *
 * Security posture, stated once because it applies to every row rendered:
 * values are rendered as text, never as HTML. A contact whose name is
 * `<img src=x onerror=...>` displays as that literal string. There is no
 * `dangerouslySetInnerHTML` anywhere in the record screens.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { field, listRecords, money } from '../../lib/records';
import type { RecordType } from '../../lib/records';
import { RECORD_CONFIGS } from '../../lib/recordConfig';
import { EmptyState } from '../../components/ui';

const PAGE_SIZE = 25;

function cellValue(type: RecordType, record: unknown, key: string): string {
 if (type === 'deals' && key === 'value_c') {
 const raw = (record as Record<string, unknown>)?.['value_c'];
 const cur = (record as Record<string, unknown>)?.['currency'];
 return money(raw, cur);
 }
 if (key === 'due_date' || key === 'expected_close_date') {
 const v = field(record, key);
 if (v === '--') return v;
 const d = new Date(v);
 return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
 }
 if (type === 'contacts' && key === 'last_name') {
 const first = field(record, 'first_name');
 const last = field(record, 'last_name');
 if (first === '--') return last;
 if (last === '--') return first;
 return `${first} ${last}`;
 }
 if (type === 'leads' && key === 'last_name') {
 const first = field(record, 'first_name');
 const last = field(record, 'last_name');
 if (first === '--') return last;
 if (last === '--') return first;
 return `${first} ${last}`;
 }
 return field(record, key);
}

function recordId(record: unknown): string | null {
 if (typeof record !== 'object' || record === null) return null;
 const id = (record as Record<string, unknown>)['id'];
 return typeof id === 'string' && id ? id : null;
}

export function RecordList({ type }: { type: RecordType }): JSX.Element {
 const config = RECORD_CONFIGS[type];
 const [searchParams, setSearchParams] = useSearchParams();
 const q = searchParams.get('q') ?? '';

 const [rows, setRows] = useState<unknown[]>([]);
 const [total, setTotal] = useState(0);
 const [offset, setOffset] = useState(0);
 const [isLoading, setIsLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [draft, setDraft] = useState(q);

 const load = useCallback(async () => {
 setIsLoading(true);
 setError(null);
 try {
 const result = await listRecords<unknown>(type, { offset, limit: PAGE_SIZE, q });
 setRows(result.data);
 setTotal(result.pageInfo.totalCount);
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not load records.');
 setRows([]);
 } finally {
 setIsLoading(false);
 }
 }, [type, offset, q]);

 useEffect(() => {
 setOffset(0);
 }, [type, q]);

 useEffect(() => {
 void load();
 }, [load]);

 // Keep the input in sync when the URL changes (back/forward navigation).
 useEffect(() => {
 setDraft(q);
 }, [q]);

 function submitSearch(e: React.FormEvent): void {
 e.preventDefault();
 setSearchParams(draft.trim() ? { q: draft.trim() } : {});
 }

 const page = Math.floor(offset / PAGE_SIZE) + 1;
 const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

 return (
 <div>
 <h1>{config.plural}</h1>
 <p className="muted">
 {total === 1 ? '1 record' : `${total.toLocaleString()} records`}
 </p>

 <div className="toolbar">
 <form onSubmit={submitSearch} className="form-row">
 <input
 className="search"
 type="search"
 placeholder={`Search ${config.plural.toLowerCase()}...`}
 value={draft}
 onChange={(e) => setDraft(e.target.value)}
 aria-label={`Search ${config.plural.toLowerCase()}`}
 />
 <button type="submit" className="btn btn-secondary">
 Search
 </button>
 </form>
 <Link className="btn btn-primary btn-auto" to="new">
 New {config.singular}
 </Link>
 {type === 'deals' && (
 <Link className="btn btn-secondary btn-auto" to="/deals/board">
 Board view
 </Link>
 )}
 </div>

 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}

 {isLoading ? (
 <p className="muted" role="status">
 Loading...
 </p>
 ) : rows.length === 0 ? (
 <EmptyState
 message={q ? `No ${config.plural.toLowerCase()} match ${q}.` : `No ${config.plural.toLowerCase()} yet.`}
 />
 ) : (
 <>
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 {config.columns.map((c) => (
 <th key={c.key} scope="col">
 {c.label}
 </th>
 ))}
 </tr>
 </thead>
 <tbody>
 {rows.map((row, i) => {
 const id = recordId(row);
 return (
 <tr key={id ?? `row-${i}`}>
 {config.columns.map((c, ci) => (
 <td key={c.key}>
 {ci === 0 && id ? (
 <Link to={id}>{cellValue(type, row, c.key)}</Link>
 ) : (
 cellValue(type, row, c.key)
 )}
 </td>
 ))}
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 <div className="pager">
 <button
 type="button"
 className="btn btn-secondary"
 disabled={offset === 0}
 onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
 >
 Previous
 </button>
 <span>
 Page {page} of {pageCount}
 </span>
 <button
 type="button"
 className="btn btn-secondary"
 disabled={offset + PAGE_SIZE >= total}
 onClick={() => setOffset(offset + PAGE_SIZE)}
 >
 Next
 </button>
 </div>
 </>
 )}
 </div>
 );
}
