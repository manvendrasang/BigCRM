/**
 * Project window: the whole deal on one screen.
 *
 * A deal clicked anywhere (board, list, calendar, search) lands here instead
 * of the generic record page: header with value and status, an interactive
 * stage stepper (clicking a stage moves the deal -- won/lost applied
 * server-side), linked company and contact, tasks, activity timeline,
 * schedule-meeting form, custom fields and attachments, plus inline edit and
 * delete. The generic RecordDetail still serves the other four types; deals
 * outgrew it, so they get a room of their own.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
 deleteRecord,
 field,
 getRecord,
 updateRecord,
} from '../../lib/records';
import { RECORD_CONFIGS } from '../../lib/recordConfig';
import type { FieldDef } from '../../lib/recordConfig';
import { listStages, moveDeal } from '../../lib/kanban';
import type { Stage } from '../../lib/kanban';
import { RecordExtras } from '../../components/RecordExtras';
import { ActivityTimeline } from '../../components/ActivityTimeline';
import { RelatedTasks } from '../../components/RelatedRecords';
import { ScheduleMeetingForm } from '../../components/ScheduleMeetingForm';
import { KpiCard, useConfirm } from '../../components/ui';
import {
 FieldInput,
 displayValue,
 firstTitle,
 inputValue,
} from './RecordDetail';

const config = RECORD_CONFIGS.deals;

export function ProjectDetail(): JSX.Element {
 const { id } = useParams<{ id: string }>();
 const navigate = useNavigate();
 const { actor } = useAuth();
 const canWrite = actor?.role !== 'viewer';

 const [record, setRecord] = useState<unknown>(null);
 const [stages, setStages] = useState<Stage[]>([]);
 const [companyName, setCompanyName] = useState<string | null>(null);
 const [contactName, setContactName] = useState<string | null>(null);
 const [isLoading, setIsLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [actionMessage, setActionMessage] = useState<string | null>(null);
 const [isEditing, setIsEditing] = useState(false);
 const [form, setForm] = useState<Record<string, string>>({});
 const [isSaving, setIsSaving] = useState(false);
 const [formError, setFormError] = useState<string | null>(null);
 const [moving, setMoving] = useState(false);
 const [timelineTick, setTimelineTick] = useState(0);
 const { confirm, dialog } = useConfirm();

 const load = useCallback(async () => {
 if (!id) return;
 setIsLoading(true);
 setError(null);
 try {
 const deal = await getRecord<unknown>('deals', id);
 setRecord(deal);
 const pipelineId = field(deal, 'pipeline_id');
 if (pipelineId !== '--') {
 try {
 setStages(await listStages(pipelineId));
 } catch {
 setStages([]);
 }
 } else {
 setStages([]);
 }
 const companyId = field(deal, 'company_id');
 if (companyId !== '--') {
 try {
 const company = await getRecord<unknown>('companies', companyId);
 setCompanyName(firstTitle('companies', company, companyId));
 } catch {
 setCompanyName(null);
 }
 } else {
 setCompanyName(null);
 }
 const contactId = field(deal, 'contact_id');
 if (contactId !== '--') {
 try {
 const contact = await getRecord<unknown>('contacts', contactId);
 setContactName(firstTitle('contacts', contact, contactId));
 } catch {
 setContactName(null);
 }
 } else {
 setContactName(null);
 }
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not load this project.');
 setRecord(null);
 } finally {
 setIsLoading(false);
 }
 }, [id]);

 useEffect(() => {
 void load();
 }, [load]);

 function startEdit(): void {
 const initial: Record<string, string> = {};
 for (const f of config.editFields ?? config.createFields) {
 initial[f.key] = inputValue(record, f.key);
 }
 setForm(initial);
 setFormError(null);
 setIsEditing(true);
 }

 async function saveEdit(e: React.FormEvent): Promise<void> {
 e.preventDefault();
 if (!id) return;
 setIsSaving(true);
 setFormError(null);
 try {
 const body: Record<string, unknown> = {};
 for (const f of config.editFields ?? config.createFields) {
 const raw = (form[f.key] ?? '').trim();
 if (!raw) continue;
 body[f.key] = f.input === 'number' ? Number(raw) : raw;
 }
 setRecord(await updateRecord<unknown>('deals', id, body));
 setIsEditing(false);
 setActionMessage('Saved.');
 } catch (err) {
 setFormError(err instanceof ApiError ? err.message : 'Could not save changes.');
 } finally {
 setIsSaving(false);
 }
 }

 async function handleDelete(): Promise<void> {
 if (!id) return;
 const confirmed = await confirm({
 title: 'Delete this project?',
 message: 'It can be restored afterwards.',
 confirmLabel: 'Delete',
 });
 if (!confirmed) return;
 try {
 await deleteRecord('deals', id);
 navigate('/deals');
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not delete this project.');
 }
 }

 async function moveToStage(stage: Stage): Promise<void> {
 if (!id || moving) return;
 const confirmed = await confirm({
 title: `Move to ${stage.name}?`,
 message: stage.is_won
 ? 'This marks the project won.'
 : stage.is_lost
 ? 'This marks the project lost.'
 : undefined,
 confirmLabel: 'Move',
 });
 if (!confirmed) return;
 setMoving(true);
 try {
 await moveDeal(id, stage.id);
 setActionMessage(`Moved to ${stage.name}.`);
 await load();
 setTimelineTick((t) => t + 1);
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not move the project.');
 } finally {
 setMoving(false);
 }
 }

 if (isLoading) return <p className="muted" role="status">Loading...</p>;
 if (error || !record) {
 return (
 <div>
 <p>
 <Link to="/deals">&larr; Back to projects</Link>
 </p>
 <p className="alert alert-error" role="alert">
 {error ?? 'Project not found.'}
 </p>
 </div>
 );
 }

 const title = firstTitle('deals', record, 'Project');
 const stageId = field(record, 'stage_id');
 const status = field(record, 'status');
 const companyId = field(record, 'company_id');
 const contactId = field(record, 'contact_id');

 return (
 <div>
 <p>
 <Link to="/deals">&larr; Back to projects</Link>
 </p>
 <h1>{title}</h1>

 {actionMessage && (
 <p className="alert" role="status">
 {actionMessage}
 </p>
 )}

 <div className="grid">
 <KpiCard title="Value" value={displayValue('deals', record, 'value_c')} />
 <KpiCard title="Status" value={status} />
 <KpiCard
 title="Probability"
 value={field(record, 'probability') === '--' ? '--' : `${field(record, 'probability')}%`}
 />
 </div>

 {stages.length > 0 && (
 <section className="card section" aria-label="Pipeline progress">
 <h2>Pipeline</h2>
 <ol className="stepper">
 {stages.map((s) => {
 const current = s.id === stageId;
 const done = stages.findIndex((x) => x.id === stageId) > stages.findIndex((x) => x.id === s.id);
 return (
 <li key={s.id} className={`step${current ? ' step-current' : ''}${done ? ' step-done' : ''}`}>
 {canWrite && !current ? (
 <button
 type="button"
 className="step-button"
 disabled={moving}
 onClick={() => { void moveToStage(s); }}
 aria-label={`Move project to ${s.name}`}
 >
 {s.name}
 </button>
 ) : (
 <span aria-current={current ? 'step' : undefined}>{s.name}</span>
 )}
 </li>
 );
 })}
 </ol>
 </section>
 )}

 <dl className="detail-grid">
 {config.detail.map((c) => (
 <div key={c.key}>
 <dt>{c.label}</dt>
 <dd>{displayValue('deals', record, c.key)}</dd>
 </div>
 ))}
 {companyId !== '--' && (
 <div>
 <dt>Company</dt>
 <dd>
 <Link to={`/companies/${companyId}`}>{companyName ?? companyId}</Link>
 </dd>
 </div>
 )}
 {contactId !== '--' && (
 <div>
 <dt>Contact</dt>
 <dd>
 <Link to={`/contacts/${contactId}`}>{contactName ?? contactId}</Link>
 </dd>
 </div>
 )}
 </dl>

 {canWrite && !isEditing && (
 <div className="form-actions">
 <button type="button" className="btn btn-secondary" onClick={startEdit}>
 Edit
 </button>
 <button type="button" className="btn btn-secondary" onClick={() => { void handleDelete(); }}>
 Delete
 </button>
 </div>
 )}

 {isEditing && (
 <form onSubmit={(e) => { void saveEdit(e); }}>
 {formError && (
 <p className="alert alert-error" role="alert">
 {formError}
 </p>
 )}
 <div className="form-grid">
 {(config.editFields ?? config.createFields).map((f: FieldDef) => (
 <label key={f.key} className="field">
 <span>
 {f.label}
 {f.required ? ' *' : ''}
 </span>
 <FieldInput
 def={f}
 value={form[f.key] ?? ''}
 onChange={(v) => setForm((prev) => ({ ...prev, [f.key]: v }))}
 />
 </label>
 ))}
 </div>
 <div className="form-actions">
 <button type="submit" className="btn btn-primary" disabled={isSaving}>
 {isSaving ? 'Saving...' : 'Save changes'}
 </button>
 <button
 type="button"
 className="btn btn-secondary"
 disabled={isSaving}
 onClick={() => setIsEditing(false)}
 >
 Cancel
 </button>
 </div>
 </form>
 )}

 {id && <RelatedTasks entityType="deal" entityId={id} />}
 {id && (
 <ActivityTimeline entityType="deal" entityId={id} refreshSignal={timelineTick} />
 )}
 {id && canWrite && (
 <ScheduleMeetingForm
 entityType="deal"
 entityId={id}
 onScheduled={() => setTimelineTick((t) => t + 1)}
 />
 )}
 {id && <RecordExtras type="deals" id={id} />}
 {dialog}
 </div>
 );
}

export default ProjectDetail;
