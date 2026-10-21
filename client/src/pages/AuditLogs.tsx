/**
 * Audit log viewer.
 *
 * Pages the org's append-only audit trail newest-first with exact-match
 * filters on action, entity type and outcome. The list view deliberately
 * omits before/after snapshots -- those can carry whole records and belong in
 * an export, not a page that refreshes on every click.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { listAuditLogs } from '../lib/workspace';
import type { AuditRow } from '../lib/workspace';
import { EmptyState } from '../components/ui';

export function AuditLogs(): JSX.Element {
 const [items, setItems] = useState<AuditRow[]>([]);
 const [total, setTotal] = useState(0);
 const [offset, setOffset] = useState(0);
 const [action, setAction] = useState('');
 const [outcome, setOutcome] = useState('');
 const [error, setError] = useState<string | null>(null);

 const PAGE = 25;

 const load = useCallback(async () => {
 setError(null);
 try {
 const result = await listAuditLogs({
 limit: PAGE,
 offset,
 action: action.trim() || undefined,
 outcome: outcome.trim() || undefined,
 });
 setItems(result.items);
 setTotal(result.total);
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not load the audit log.');
 }
 }, [offset, action, outcome]);

 useEffect(() => {
 void load();
 }, [load]);

 const page = Math.floor(offset / PAGE) + 1;
 const pageCount = Math.max(1, Math.ceil(total / PAGE));

 return (
 <div className="enter">
 <h1>Audit log</h1>
 <p className="muted">
 {total === 1 ? '1 entry' : `${total.toLocaleString()} entries`}. Append-only; entries cannot be edited or deleted.
 </p>

 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}

 <div className="toolbar">
 <form
 onSubmit={(e) => { e.preventDefault(); setOffset(0); }}
 className="form-row"
 >
 <input
 className="search audit-filter"
 placeholder="Action (e.g. contacts.create)"
 value={action}
 onChange={(e) => setAction(e.target.value)}
 aria-label="Filter by action"
 />
 <select value={outcome} onChange={(e) => { setOutcome(e.target.value); setOffset(0); }} aria-label="Filter by outcome">
 <option value="">Any outcome</option>
 <option value="success">success</option>
 <option value="failure">failure</option>
 <option value="denied">denied</option>
 </select>
 <button type="submit" className="btn btn-secondary">Filter</button>
 </form>
 </div>

 {items.length === 0 ? (
 <EmptyState message="No entries match." />
 ) : (
 <>
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 <th scope="col">When</th>
 <th scope="col">Action</th>
 <th scope="col">Entity</th>
 <th scope="col">Outcome</th>
 <th scope="col">IP</th>
 <th scope="col">Changed</th>
 </tr>
 </thead>
 <tbody>
 {items.map((r) => (
 <tr key={r.id}>
 <td>{new Date(r.createdAt).toLocaleString()}</td>
 <td><code>{r.action}</code></td>
 <td>{r.entityType}</td>
 <td>{r.outcome}</td>
 <td>{r.ip ?? '--'}</td>
 <td>{(r.changedFields ?? []).join(', ') || '--'}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 <div className="pager">
 <button
 type="button"
 className="btn btn-secondary"
 disabled={offset === 0}
 onClick={() => setOffset(Math.max(0, offset - PAGE))}
 >
 Previous
 </button>
 <span>
 Page {page} of {pageCount}
 </span>
 <button
 type="button"
 className="btn btn-secondary"
 disabled={offset + PAGE >= total}
 onClick={() => setOffset(offset + PAGE)}
 >
 Next
 </button>
 </div>
 </>
 )}
 </div>
 );
}
