/**
 * Global search: one query across all five record types.
 *
 * There is no server-side global search endpoint, deliberately. A `UNION ALL`
 * across five tables with different columns returns rows the client cannot
 * type, and a free-text index across tenants is an exfiltration surface that
 * needs its own review. Instead the client fans out to the five existing list
 * endpoints -- each tenant-scoped, each rate-limited, each permission-checked --
 * and merges the first page of each.
 *
 * The trade-off is stated plainly: results are the top few per type, not a
 * globally ranked list, and five requests cost five rate-limit budgets. For a
 * CRM sidebar search that is the right shape; for full-text search across
 * millions of rows it is not, and that would be a server feature with its own
 * threat model.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { field, listRecords } from '../lib/records';
import type { RecordType } from '../lib/records';
import { RECORD_CONFIGS } from '../lib/recordConfig';
import { EmptyState } from '../components/ui';

const TYPES: RecordType[] = ['contacts', 'companies', 'leads', 'deals', 'tasks'];
const PER_TYPE = 5;

interface Hit {
 type: RecordType;
 id: string;
 title: string;
 subtitle: string;
}

function hitTitle(type: RecordType, row: unknown): string {
 if (type === 'contacts' || type === 'leads') {
 const first = field(row, 'first_name');
 const last = field(row, 'last_name');
 const name = [first === '--' ? '' : first, last === '--' ? '' : last].join(' ').trim();
 if (name) return name;
 }
 for (const key of ['name', 'title', 'company_name', 'email']) {
 const v = field(row, key);
 if (v !== '--') return v;
 }
 return '(untitled)';
}

function hitSubtitle(type: RecordType, row: unknown): string {
 if (type === 'contacts' || type === 'leads') return field(row, 'email');
 if (type === 'companies') return field(row, 'domain');
 if (type === 'deals') return field(row, 'status');
 if (type === 'tasks') return `${field(row, 'status')} - ${field(row, 'priority')}`;
 return '';
}

function rowId(row: unknown): string | null {
 if (typeof row !== 'object' || row === null) return null;
 const id = (row as Record<string, unknown>)['id'];
 return typeof id === 'string' && id ? id : null;
}

export function GlobalSearch(): JSX.Element {
 const [q, setQ] = useState('');
 const [hits, setHits] = useState<Hit[]>([]);
 const [totals, setTotals] = useState<Partial<Record<RecordType, number>>>({});
 const [isSearching, setIsSearching] = useState(false);
 const [hasSearched, setHasSearched] = useState(false);
 const [error, setError] = useState<string | null>(null);

 async function search(e: React.FormEvent): Promise<void> {
 e.preventDefault();
 const query = q.trim();
 if (!query) return;
 setIsSearching(true);
 setError(null);
 setHasSearched(true);
 try {
 // One request per type, in parallel. A type the user cannot read 403s;
 // that rejection is swallowed per-type so one denied section does not
 // blank the sections the user is allowed to see. Swallowing is safe here
 // because a 403 contributes zero rows either way -- the alternative (fail
 // the whole search) would let the narrowest permission hide everything.
 const settled = await Promise.all(
 TYPES.map(async (type): Promise<{ type: RecordType; rows: unknown[]; total: number }> => {
 try {
 const r = await listRecords<unknown>(type, { q: query, limit: PER_TYPE, offset: 0 });
 return { type, rows: r.data, total: r.pageInfo.totalCount };
 } catch (err) {
 if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
 return { type, rows: [], total: 0 };
 }
 throw err;
 }
 }),
 );
 const all: Hit[] = [];
 const counts: Partial<Record<RecordType, number>> = {};
 for (const s of settled) {
 counts[s.type] = s.total;
 for (const row of s.rows) {
 const id = rowId(row);
 if (!id) continue;
 all.push({ type: s.type, id, title: hitTitle(s.type, row), subtitle: hitSubtitle(s.type, row) });
 }
 }
 setHits(all);
 setTotals(counts);
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Search failed.');
 setHits([]);
 } finally {
 setIsSearching(false);
 }
 }

 return (
 <div>
 <h1>Search</h1>
 <p className="muted">One query across contacts, companies, leads, projects and tasks.</p>

 <form onSubmit={(e) => { void search(e); }} className="toolbar">
 <input
 className="search"
 type="search"
 placeholder="Search everything..."
 value={q}
 onChange={(e) => setQ(e.target.value)}
 aria-label="Search all records"
 />
 <button type="submit" className="btn btn-primary btn-auto" disabled={isSearching}>
 {isSearching ? 'Searching...' : 'Search'}
 </button>
 </form>

 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}

 {hasSearched && !isSearching && hits.length === 0 && !error && (
 <EmptyState message={`No records match ${q.trim()}.`} />
 )}

 {hits.length > 0 && (
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 <th scope="col">Type</th>
 <th scope="col">Record</th>
 <th scope="col">Detail</th>
 </tr>
 </thead>
 <tbody>
 {hits.map((h) => (
 <tr key={`${h.type}-${h.id}`}>
 <td>{RECORD_CONFIGS[h.type].singular}</td>
 <td>
 <Link to={`/${h.type}/${h.id}`}>{h.title}</Link>
 </td>
 <td>{h.subtitle || '--'}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}

 {hasSearched && hits.length > 0 && (
 <p className="muted" style={{ marginTop: 12 }}>
 Showing top {PER_TYPE} per type.
 {TYPES.map((t) => ` ${RECORD_CONFIGS[t].plural}: ${totals[t] ?? 0}`).join(' -')}
 </p>
 )}
 </div>
 );
}
