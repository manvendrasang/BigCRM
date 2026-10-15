/**
 * Linked records on the detail page: tasks related to this record, and (for
 * companies) deals belonging to it.
 *
 * The links already exist in the schema -- tasks carry `related_type` /
 * `related_id`, deals carry `company_id` -- but no page rendered them, so the
 * relations were write-only. These sections list and quick-create in place:
 * opening a company shows its tasks and deals, and both can be added without
 * leaving the page. A 403 hides the section (same precedent as
 * RecordExtras); anything else is a muted note, never a page error.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { createRecord, listRecords, money, shortDate } from '../lib/records';
import { listPipelines, listStages } from '../lib/kanban';
import type { Pipeline, Stage } from '../lib/kanban';
import { Section } from './ui';

interface TaskRow {
 id: string;
 title: string;
 status: string;
 priority: string;
 due_date: string | null;
}

export function RelatedTasks({
 entityType,
 entityId,
}: {
 entityType: string;
 entityId: string;
}): JSX.Element | null {
 const { actor } = useAuth();
 const canCreate = actor?.role !== 'viewer';
 const [rows, setRows] = useState<TaskRow[]>([]);
 const [visible, setVisible] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [title, setTitle] = useState('');
 const [dueDate, setDueDate] = useState('');
 const [busy, setBusy] = useState(false);

 const load = useCallback(async () => {
 try {
 const result = await listRecords<TaskRow>('tasks', {
 limit: 50,
 filters: { related_type: entityType, related_id: entityId },
 });
 setRows(result.data);
 setVisible(true);
 } catch (err) {
 if (err instanceof ApiError && err.status === 403) setVisible(false);
 else setError(err instanceof ApiError ? err.message : 'Could not load tasks.');
 }
 }, [entityType, entityId]);

 useEffect(() => {
 void load();
 }, [load]);

 async function create(e: React.FormEvent): Promise<void> {
 e.preventDefault();
 if (!title.trim()) return;
 setBusy(true);
 setError(null);
 try {
 await createRecord('tasks', {
 title: title.trim(),
 ...(dueDate ? { due_date: dueDate } : {}),
 related_type: entityType,
 related_id: entityId,
 });
 setTitle('');
 setDueDate('');
 await load();
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not create the task.');
 } finally {
 setBusy(false);
 }
 }

 if (!visible) return null;

 return (
 <Section title="Tasks">
 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}
 {rows.length === 0 ? (
 <p className="muted">No tasks linked to this record yet.</p>
 ) : (
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 <th scope="col">Title</th>
 <th scope="col">Status</th>
 <th scope="col">Due</th>
 </tr>
 </thead>
 <tbody>
 {rows.map((t) => (
 <tr key={t.id}>
 <td>
 <Link to={`/tasks/${t.id}`}>{t.title}</Link>
 </td>
 <td>{t.status}</td>
 <td>{t.due_date ? shortDate(t.due_date) : '--'}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 {canCreate && (
 <form onSubmit={(e) => { void create(e); }}>
 <div className="form-grid">
 <label className="field">
 <span>New task *</span>
 <input
 value={title}
 required
 maxLength={200}
 placeholder="e.g. Send the proposal"
 onChange={(e) => setTitle(e.target.value)}
 />
 </label>
 <label className="field">
 <span>Due date</span>
 <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
 </label>
 </div>
 <div className="form-actions">
 <button type="submit" className="btn btn-secondary" disabled={busy || !title.trim()}>
 {busy ? 'Adding...' : 'Add task'}
 </button>
 </div>
 </form>
 )}
 </Section>
 );
}

interface DealRow {
 id: string;
 name: string;
 value_c: unknown;
 currency: unknown;
 status: string;
}

export function RelatedDeals({ companyId }: { companyId: string }): JSX.Element | null {
 const { actor } = useAuth();
 const canCreate = actor?.role !== 'viewer';
 const [rows, setRows] = useState<DealRow[]>([]);
 const [visible, setVisible] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [name, setName] = useState('');
 const [pipelines, setPipelines] = useState<Pipeline[]>([]);
 const [pipelineId, setPipelineId] = useState('');
 const [stages, setStages] = useState<Stage[]>([]);
 const [stageId, setStageId] = useState('');
 const [busy, setBusy] = useState(false);

 const load = useCallback(async () => {
 try {
 const result = await listRecords<DealRow>('deals', {
 limit: 50,
 filters: { company_id: companyId },
 });
 setRows(result.data);
 setVisible(true);
 } catch (err) {
 if (err instanceof ApiError && err.status === 403) setVisible(false);
 else setError(err instanceof ApiError ? err.message : 'Could not load deals.');
 }
 }, [companyId]);

 useEffect(() => {
 void load();
 }, [load]);

 useEffect(() => {
 if (!canCreate) return;
 let cancelled = false;
 void (async () => {
 try {
 const pipes = await listPipelines();
 if (cancelled) return;
 setPipelines(pipes);
 if (pipes.length > 0 && pipes[0]) {
 setPipelineId((prev) => prev || pipes[0]!.id);
 }
 } catch {
 // The list still renders; only the quick-add form loses its options.
 }
 })();
 return () => {
 cancelled = true;
 };
 }, [canCreate]);

 useEffect(() => {
 if (!pipelineId) {
 setStages([]);
 setStageId('');
 return;
 }
 let cancelled = false;
 void (async () => {
 try {
 const fetched = await listStages(pipelineId);
 if (cancelled) return;
 setStages(fetched);
 setStageId((prev) => (fetched.some((s) => s.id === prev) ? prev : (fetched[0]?.id ?? '')));
 } catch {
 if (!cancelled) {
 setStages([]);
 setStageId('');
 }
 }
 })();
 return () => {
 cancelled = true;
 };
 }, [pipelineId]);

 async function create(e: React.FormEvent): Promise<void> {
 e.preventDefault();
 if (!name.trim() || !pipelineId || !stageId) return;
 setBusy(true);
 setError(null);
 try {
 await createRecord('deals', {
 name: name.trim(),
 pipeline_id: pipelineId,
 stage_id: stageId,
 company_id: companyId,
 });
 setName('');
 await load();
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not create the deal.');
 } finally {
 setBusy(false);
 }
 }

 if (!visible) return null;

 return (
 <Section title="Deals">
 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}
 {rows.length === 0 ? (
 <p className="muted">No deals for this company yet.</p>
 ) : (
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 <th scope="col">Deal</th>
 <th scope="col">Value</th>
 <th scope="col">Status</th>
 </tr>
 </thead>
 <tbody>
 {rows.map((d) => (
 <tr key={d.id}>
 <td>
 <Link to={`/deals/${d.id}`}>{d.name}</Link>
 </td>
 <td>{money(d.value_c, d.currency)}</td>
 <td>{d.status}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 {canCreate && (
 <form onSubmit={(e) => { void create(e); }}>
 <div className="form-grid">
 <label className="field">
 <span>New deal *</span>
 <input
 value={name}
 required
 maxLength={200}
 placeholder="e.g. Acme renewal"
 onChange={(e) => setName(e.target.value)}
 />
 </label>
 <label className="field">
 <span>Pipeline</span>
 <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} aria-label="Pipeline">
 {pipelines.map((p) => (
 <option key={p.id} value={p.id}>
 {p.name}
 </option>
 ))}
 </select>
 </label>
 <label className="field">
 <span>Stage</span>
 <select value={stageId} onChange={(e) => setStageId(e.target.value)} aria-label="Stage">
 {stages.map((s) => (
 <option key={s.id} value={s.id}>
 {s.name}
 </option>
 ))}
 </select>
 </label>
 </div>
 <div className="form-actions">
 <button
 type="submit"
 className="btn btn-secondary"
 disabled={busy || !name.trim() || !stageId}
 >
 {busy ? 'Adding...' : 'Add deal'}
 </button>
 </div>
 </form>
 )}
 </Section>
 );
}
