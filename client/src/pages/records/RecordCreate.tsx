/**
 * Generic record creation form.
 *
 * One page for all five types, driven by `createFields` in the config. On
 * success it navigates to the new record's detail page using the id from the
 * server's response -- not by guessing, and not by re-listing.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { createRecord } from '../../lib/records';
import type { RecordType } from '../../lib/records';
import { RECORD_CONFIGS } from '../../lib/recordConfig';
import { AssigneeSelect, canAssignTasks, useAssignableMembers } from '../../components/AssigneeField';
import { useAuth } from '../../lib/auth';

export function RecordCreate({ type }: { type: RecordType }): JSX.Element {
 const config = RECORD_CONFIGS[type];
 const navigate = useNavigate();
 const [form, setForm] = useState<Record<string, string>>({});
 const [isSaving, setIsSaving] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const { actor } = useAuth();
 // Assignment is offered only to the roles the server would accept it from;
 // admins are maintainers, not dispatchers, so they do not get the picker.
 const canAssign = type === 'tasks' && canAssignTasks(actor?.role);
 const { members, error: membersError } = useAssignableMembers(canAssign);

 async function submit(e: React.FormEvent): Promise<void> {
 e.preventDefault();
 setIsSaving(true);
 setError(null);
 try {
 const body: Record<string, unknown> = {};
 for (const f of config.createFields) {
 const raw = (form[f.key] ?? '').trim();
 if (!raw) {
 if (f.required) {
 setError(`${f.label} is required.`);
 setIsSaving(false);
 return;
 }
 continue;
 }
 body[f.key] = f.input === 'number' ? Number(raw) : raw;
 }
 if (canAssign && form['assignee_id']) body['assignee_id'] = form['assignee_id'];
 const created = await createRecord<Record<string, unknown>>(type, body);
 const id = typeof created['id'] === 'string' ? created['id'] : null;
 // Absolute, not relative. React Router v6 resolves `..` against the route
 // *hierarchy*, and the route table is flat (`/tasks/new` is a direct child of
 // the root, not of `/tasks`), so `..` meant the root -- the browser was sent
 // to `/<id>`, which matches no route, and the catch-all sent the user to the
 // dashboard. The new record was created; the user was simply never shown it.
 navigate(id ? `/${type}/${encodeURIComponent(id)}` : `/${type}`);
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not create this record.');
 } finally {
 setIsSaving(false);
 }
 }

 return (
 <div className="enter">
 <p>
 <Link to={`/${type}`}>&larr; Back to {config.plural}</Link>
 </p>
 <h1>New {config.singular}</h1>
 <form onSubmit={(e) => { void submit(e); }}>
 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}
 <div className="form-grid">
 {config.createFields.map((f) => (
 <label key={f.key} className="field">
 <span>
 {f.label}
 {f.required ? ' *' : ''}
 </span>
 {f.input === 'select' ? (
 <select
 value={form[f.key] ?? ''}
 onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
 >
 <option value="">--</option>
 {(f.options ?? []).map((o) => (
 <option key={o} value={o}>
 {o}
 </option>
 ))}
 </select>
 ) : f.input === 'textarea' ? (
 <textarea
 value={form[f.key] ?? ''}
 rows={3}
 onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
 />
 ) : (
 <input
 type={f.input}
 value={form[f.key] ?? ''}
 required={f.required ?? false}
 onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
 />
 )}
 </label>
 ))}
 {canAssign && (
 <label className="field">
 <span>Assignee</span>
 <AssigneeSelect
 members={members}
 value={form['assignee_id'] ?? ''}
 onChange={(v) => setForm((p) => ({ ...p, assignee_id: v }))}
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
 {isSaving ? 'Creating...' : `Create ${config.singular}`}
 </button>
 <Link className="btn btn-secondary" to={`/${type}`}>
 Cancel
 </Link>
 </div>
 </form>
 </div>
 );
}
