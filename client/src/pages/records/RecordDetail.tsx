/**
 * Generic record detail: field grid, edit form, delete/restore.
 *
 * Read, update and delete share one page so the three states cannot disagree
 * about what a record contains. Editing is inline (no modal, no separate
 * route): the form is pre-filled from the loaded record, and a successful save
 * re-renders the detail from the server's response rather than from the form
 * state, so what the user sees is what the server stored.
 *
 * Type-specific actions live here too, behind the same permission model as the
 * API: lead conversion and deal stage advancement are offered as buttons, but
 * the server enforces the permission -- hiding the button from a viewer does not
 * grant anything, and showing it to an owner does not bypass anything.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import {
 convertLead,
 deleteRecord,
 field,
 getRecord,
 money,
 updateRecord,
} from '../../lib/records';
import type { RecordType } from '../../lib/records';
import { RECORD_CONFIGS } from '../../lib/recordConfig';
import type { FieldDef } from '../../lib/recordConfig';
import { RecordExtras } from '../../components/RecordExtras';
import { ActivityTimeline } from '../../components/ActivityTimeline';
import { RelatedDeals, RelatedTasks } from '../../components/RelatedRecords';
import { ScheduleMeetingForm } from '../../components/ScheduleMeetingForm';
import { useConfirm } from '../../components/ui';
import { Skeleton } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { AssigneeSelect, canAssignTasks, useAssignableMembers } from '../../components/AssigneeField';

export function displayValue(type: RecordType, record: unknown, key: string): string {
 if (type === 'deals' && key === 'value_c') {
 const raw = (record as Record<string, unknown>)?.['value_c'];
 const cur = (record as Record<string, unknown>)?.['currency'];
 return money(raw, cur);
 }
 return field(record, key);
}

export function inputValue(record: unknown, key: string): string {
 const v = field(record, key);
 if (v === '--') return '';
 if (key === 'due_date' || key === 'expected_close_date' || key === 'birthday') {
 const d = new Date(v);
 if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
 }
 return v;
}

export function RecordDetail({ type }: { type: RecordType }): JSX.Element {
 const config = RECORD_CONFIGS[type];
 const { id } = useParams<{ id: string }>();
 const navigate = useNavigate();

 const [record, setRecord] = useState<unknown>(null);
 const [isLoading, setIsLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [isEditing, setIsEditing] = useState(false);
 const [form, setForm] = useState<Record<string, string>>({});
 const [isSaving, setIsSaving] = useState(false);
 const [formError, setFormError] = useState<string | null>(null);
 const [actionMessage, setActionMessage] = useState<string | null>(null);
 const [timelineTick, setTimelineTick] = useState(0);
 const { confirm: confirmDelete, dialog: deleteDialog } = useConfirm();
 const { actor } = useAuth();
 const canSchedule = actor?.role !== 'viewer';
 const isViewer = actor?.role === 'viewer';
 // A viewer holds no `*.update` except `tasks.update`, so the Edit button is
 // only offered where the server would accept the write: their own tasks. The
 // task form itself is narrowed to `status` because that is the only column a
 // viewer may change.
 const canEdit = !isViewer || type === 'tasks';
 const canDelete = !isViewer;
 // Only the owner and a manager may assign; admins are maintainers.
 const canAssign = type === 'tasks' && canAssignTasks(actor?.role);
 const { members, error: membersError } = useAssignableMembers(canAssign);
 const editFields = (config.editFields ?? config.createFields).filter(
 (f) => !isViewer || type !== 'tasks' || f.key === 'status',
 );

 const load = useCallback(async () => {
 if (!id) return;
 setIsLoading(true);
 setError(null);
 try {
 setRecord(await getRecord<unknown>(type, id));
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not load this record.');
 setRecord(null);
 } finally {
 setIsLoading(false);
 }
 }, [type, id]);

 useEffect(() => {
 void load();
 }, [load]);

 function startEdit(): void {
 const initial: Record<string, string> = {};
 for (const f of editFields) {
 initial[f.key] = inputValue(record, f.key);
 }
 if (canAssign) {
 const current = field(record, 'assignee_id');
 initial['assignee_id'] = current === '--' ? '' : current;
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
 // Empty strings are omitted: sending `email: ''` would overwrite a stored
 // address with an empty one, while omitting the key leaves it untouched.
 // Number inputs arrive as strings and are converted; a non-numeric entry
 // is dropped rather than sent as NaN.
 const body: Record<string, unknown> = {};
 for (const f of editFields) {
 const raw = (form[f.key] ?? '').trim();
 if (!raw) continue;
 body[f.key] = f.input === 'number' ? Number(raw) : raw;
 }
 // Empty means "unassigned": send it explicitly, because omitting the field
 // would leave the current assignee in place instead of clearing it.
 if (canAssign) body['assignee_id'] = (form['assignee_id'] ?? '').trim() || null;
 setRecord(await updateRecord<unknown>(type, id, body));
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
 const confirmed = await confirmDelete({
 title: `Delete this ${config.singular.toLowerCase()}?`,
 message: 'It can be restored afterwards.',
 confirmLabel: 'Delete',
 });
 if (!confirmed) return;
 try {
 await deleteRecord(type, id);
 navigate('..');
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not delete this record.');
 }
 }

 async function handleConvert(): Promise<void> {
 if (!id) return;
 try {
 await convertLead(id);
 setActionMessage('Lead converted.');
 await load();
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not convert this lead.');
 }
 }

 if (isLoading) return (
<div className="grid stagger">
<div className="card section enter-fast">
<Skeleton variant="title" />
<Skeleton variant="line" />
<Skeleton variant="line" />
<Skeleton variant="line" />
</div>
</div>
);
 if (error || !record) {
 return (
 <div className="enter">
 <p>
 <Link to="..">&larr; Back to {config.plural}</Link>
 </p>
 <p className="alert alert-error" role="alert">
 {error ?? 'Record not found.'}
 </p>
 </div>
 );
 }

 const title = firstTitle(type, record, config.singular);
 const currentAssignee = type === 'tasks' ? field(record, 'assignee_id') : '--';
 const knownAssignee = members.find((m) => m.id === currentAssignee);
 const assigneeLabel = currentAssignee === '--'
 ? 'Unassigned'
 : knownAssignee?.name || knownAssignee?.email || currentAssignee;

 return (
 <div className="enter">
 <p>
 <Link to="..">&larr; Back to {config.plural}</Link>
 </p>
 <h1>{title}</h1>

 {actionMessage && (
 <p className="alert" role="status">
 {actionMessage}
 </p>
 )}

 {!isEditing ? (
 <>
 <dl className="detail-grid">
 {config.detail.map((c) => (
 <div key={c.key}>
 <dt>{c.label}</dt>
 <dd>{displayValue(type, record, c.key)}</dd>
 </div>
 ))}
 {canAssign && (
 <div>
 <dt>Assignee</dt>
 <dd>{assigneeLabel}</dd>
 </div>
 )}
 </dl>
 <div className="form-actions">
 {canEdit && (
 <button type="button" className="btn btn-secondary" onClick={startEdit}>
 Edit
 </button>
 )}
 {canDelete && (
 <button type="button" className="btn btn-secondary" onClick={() => { void handleDelete(); }}>
 Delete
 </button>
 )}
 {type === 'leads' && !isViewer && (
 <button type="button" className="btn btn-secondary" onClick={() => { void handleConvert(); }}>
 Convert lead
 </button>
 )}
 </div>
 {id && <RecordExtras type={type} id={id} />}
 {id && ['contacts', 'companies', 'leads', 'deals'].includes(type) && (
 <RelatedTasks entityType={config.entity} entityId={id} />
 )}
 {id && type === 'companies' && <RelatedDeals companyId={id} />}
 {id && (
 <ActivityTimeline
 entityType={config.entity}
 entityId={id}
 refreshSignal={timelineTick}
 />
 )}
 {id && canSchedule && (
 <ScheduleMeetingForm
 entityType={config.entity}
 entityId={id}
 onScheduled={() => setTimelineTick((t) => t + 1)}
 />
 )}
 {deleteDialog}
 </>
 ) : (
 <form onSubmit={(e) => { void saveEdit(e); }}>
 {formError && (
 <p className="alert alert-error" role="alert">
 {formError}
 </p>
 )}
 <div className="form-grid">
 {editFields.map((f) => (
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
 {canAssign && (
 <label className="field">
 <span>Assignee</span>
 <AssigneeSelect
 members={members}
 value={form['assignee_id'] ?? ''}
 onChange={(v) => setForm((prev) => ({ ...prev, assignee_id: v }))}
 />
 </label>
 )}
 </div>
 {membersError && (
 <p className="alert alert-error" role="alert">
 {membersError}
 </p>
 )}
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
 </div>
 );
}

export function firstTitle(type: RecordType, record: unknown, fallback: string): string {
 if (type === 'contacts' || type === 'leads') {
 const first = field(record, 'first_name');
 const last = field(record, 'last_name');
 const name = [first === '--' ? '' : first, last === '--' ? '' : last].join(' ').trim();
 if (name) return name;
 }
 for (const key of ['name', 'title', 'email', 'company_name']) {
 const v = field(record, key);
 if (v !== '--') return v;
 }
 return fallback;
}

export function FieldInput({
 def,
 value,
 onChange,
}: {
 def: FieldDef;
 value: string;
 onChange: (v: string) => void;
}): JSX.Element {
 if (def.input === 'select') {
 return (
 <select value={value} onChange={(e) => onChange(e.target.value)}>
 <option value="">--</option>
 {(def.options ?? []).map((o) => (
 <option key={o} value={o}>
 {o}
 </option>
 ))}
 </select>
 );
 }
 if (def.input === 'textarea') {
 return <textarea value={value} rows={3} onChange={(e) => onChange(e.target.value)} />;
 }
 return (
 <input
 type={def.input}
 value={value}
 required={def.required ?? false}
 onChange={(e) => onChange(e.target.value)}
 />
 );
}

