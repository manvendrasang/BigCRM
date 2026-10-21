/**
 * Reports page: pipeline, funnel, task load.
 *
 * Each report is one server aggregation rendered as a table with a
 * proportional bar. No chart library: five bars do not need 200 KB of
 * dependencies, and a table is readable by a screen reader where a canvas is
 * not. The bar is a `div` with an inline width -- presentation, not content, so
 * assistive technology gets the numbers from the table cells.
 *
 * The metric definitions live server-side (`services/reports.ts`, RULE 152).
 * This page renders whatever the server returns and labels each report with
 * its definition, so a changed definition is visible where it is consumed.
 */
import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { money } from '../lib/records';
import { Section, EmptyState } from '../components/ui';

interface PipelineRow {
 pipelineId: string;
 pipelineName: string;
 stageId: string;
 stageName: string;
 position: number;
 dealCount: number;
 totalValueC: number | string;
 isWon: boolean;
 isLost: boolean;
}

interface FunnelRow {
 status: string;
 count: number;
}

interface TaskLoadRow {
 status: string;
 priority: string;
 count: number;
}

function Bar({ fraction }: { fraction: number }): JSX.Element {
 const pct = Math.max(0, Math.min(1, fraction)) * 100;
 return (
 <div
 aria-hidden="true"
 style={{
 height: 8,
 borderRadius: 4,
 background: 'var(--border)',
 overflow: 'hidden',
 minWidth: 80,
 }}
 >
 <div style={{ width: `${pct}%`, height: '100%', background: 'var(--primary)' }} />
 </div>
 );
}

function useReport<T>(name: string): { data: T[] | null; error: string | null } {
 const [data, setData] = useState<T[] | null>(null);
 const [error, setError] = useState<string | null>(null);

 useEffect(() => {
 let cancelled = false;
 void (async () => {
 try {
 const body = await api.get<unknown>(`/reports/${name}`);
 // The reports endpoint returns `{ data }`; the client unwrap yields the
 // array directly. Anything else is a contract break, rendered as an
 // error rather than an empty report -- an empty pipeline and a broken
 // pipeline must not look the same.
 if (!cancelled) {
 if (Array.isArray(body)) setData(body as T[]);
 else setError(`Unexpected response for the ${name} report.`);
 }
 } catch (err) {
 if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load reports.');
 }
 })();
 return () => {
 cancelled = true;
 };
 }, [name]);

 return { data, error };
}

export function Reports(): JSX.Element {
 const pipeline = useReport<PipelineRow>('pipeline');
 const funnel = useReport<FunnelRow>('lead-funnel');
 const tasks = useReport<TaskLoadRow>('task-load');

 const maxStageValue = Math.max(1, ...(pipeline.data ?? []).map((r) => Number(r.totalValueC) || 0));
 const maxFunnel = Math.max(1, ...(funnel.data ?? []).map((r) => r.count));
 const maxTasks = Math.max(1, ...(tasks.data ?? []).map((r) => r.count));

 // Group stages under their pipeline for display.
 const pipelines = new Map<string, { name: string; stages: PipelineRow[] }>();
 for (const row of pipeline.data ?? []) {
 const group = pipelines.get(row.pipelineId) ?? { name: row.pipelineName, stages: [] };
 group.stages.push(row);
 pipelines.set(row.pipelineId, group);
 }

 return (
 <div className="enter">
 <h1>Reports</h1>
 <p className="muted">Aggregated on the server from your workspace only.</p>

 <Section title="Pipeline value by stage">
 <p className="muted">Open and closed deals summed in cents per stage.</p>
 {pipeline.error && (
 <p className="alert alert-error" role="alert">
 {pipeline.error}
 </p>
 )}
 {pipeline.data && pipeline.data.length === 0 && <EmptyState message="No pipelines yet." />}
 {[...pipelines.values()].map((p) => (
 <div key={p.name} className="report-group">
 <h3>{p.name}</h3>
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 <th scope="col">Stage</th>
 <th scope="col">Deals</th>
 <th scope="col">Value</th>
 <th scope="col">Share</th>
 </tr>
 </thead>
 <tbody>
 {p.stages.map((s) => (
 <tr key={s.stageId}>
 <td>{s.stageName}</td>
 <td>{s.dealCount}</td>
 <td>{money(Number(s.totalValueC) || 0)}</td>
 <td>
 <Bar fraction={(Number(s.totalValueC) || 0) / maxStageValue} />
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 ))}
 </Section>

 <Section title="Lead funnel by status">
 <p className="muted">Lead counts grouped by status.</p>
 {funnel.error && (
 <p className="alert alert-error" role="alert">
 {funnel.error}
 </p>
 )}
 {funnel.data && (
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 <th scope="col">Status</th>
 <th scope="col">Leads</th>
 <th scope="col">Share</th>
 </tr>
 </thead>
 <tbody>
 {funnel.data.map((r) => (
 <tr key={r.status}>
 <td>{r.status}</td>
 <td>{r.count}</td>
 <td>
 <Bar fraction={r.count / maxFunnel} />
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 </Section>

 <Section title="Task load by status and priority">
 <p className="muted">Non-deleted task counts.</p>
 {tasks.error && (
 <p className="alert alert-error" role="alert">
 {tasks.error}
 </p>
 )}
 {tasks.data && (
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 <th scope="col">Status</th>
 <th scope="col">Priority</th>
 <th scope="col">Tasks</th>
 <th scope="col">Share</th>
 </tr>
 </thead>
 <tbody>
 {tasks.data.map((r, i) => (
 <tr key={`${r.status}-${r.priority}-${i}`}>
 <td>{r.status}</td>
 <td>{r.priority}</td>
 <td>{r.count}</td>
 <td>
 <Bar fraction={r.count / maxTasks} />
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 </Section>
 </div>
 );
}
