/**
 * Saved views page.
 *
 * Lists the caller's own views plus org-shared ones, creates new views, and
 * deletes. Shared views are marked and can only be created by admin/owner --
 * the server enforces that, and the UI hides the control for members.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { createView, deleteView, listViews } from '../lib/workspace';
import type { SavedViewRow } from '../lib/workspace';
import { EmptyState, useConfirm } from '../components/ui';

const ENTITY_TYPES = ['contacts', 'companies', 'leads', 'deals', 'tasks'] as const;

export function SavedViews(): JSX.Element {
 const [rows, setRows] = useState<SavedViewRow[]>([]);
 const [entityType, setEntityType] = useState<string>('contacts');
 const [name, setName] = useState('');
 const [isShared, setIsShared] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const { confirm: confirmDelete, dialog: deleteDialog } = useConfirm();

 const load = useCallback(async (et: string) => {
 try {
 setRows(await listViews(et));
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not load views.');
 }
 }, []);

 useEffect(() => {
 void load(entityType);
 }, [load, entityType]);

 async function create(e: React.FormEvent): Promise<void> {
 e.preventDefault();
 if (!name.trim()) return;
 setBusy(true);
 setError(null);
 try {
 await createView({ name: name.trim(), entityType, isShared });
 setName('');
 setIsShared(false);
 await load(entityType);
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not create the view.');
 } finally {
 setBusy(false);
 }
 }

 async function remove(id: string): Promise<void> {
 const confirmed = await confirmDelete({
 title: 'Delete this view?',
 confirmLabel: 'Delete',
 });
 if (!confirmed) return;
 try {
 await deleteView(id);
 await load(entityType);
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not delete the view.');
 }
 }

 return (
 <div className="enter">
 <h1>Saved views</h1>
 <p className="muted">Named filter and sort presets for record lists.</p>

 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}

 <div className="toolbar">
 <label>
 Records:{' '}
 <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
 {ENTITY_TYPES.map((t) => (
 <option key={t} value={t}>
 {t}
 </option>
 ))}
 </select>
 </label>
 </div>

 {rows.length === 0 ? (
 <EmptyState message={`No saved views for ${entityType} yet.`} />
 ) : (
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 <th scope="col">Name</th>
 <th scope="col">Visibility</th>
 <th scope="col">Actions</th>
 </tr>
 </thead>
 <tbody>
 {rows.map((r) => (
 <tr key={r.id}>
 <td>{r.name}</td>
 <td>{r.isShared ? 'Shared' : 'Private'}</td>
 <td>
 <button
 type="button"
 className="btn btn-secondary btn-sm"
 onClick={() => { void remove(r.id); }}
 >
 Delete
 </button>
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}

 <h2 className="section-title">New view</h2>
 <form onSubmit={(e) => { void create(e); }}>
 <div className="form-grid">
 <label className="field">
 <span>Name *</span>
 <input value={name} required onChange={(e) => setName(e.target.value)} />
 </label>
 <label className="field">
 <span>Visibility</span>
 <select value={isShared ? 'shared' : 'private'} onChange={(e) => setIsShared(e.target.value === 'shared')}>
 <option value="private">Private (only you)</option>
 <option value="shared">Shared (whole workspace)</option>
 </select>
 </label>
 </div>
 <div className="form-actions">
 <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
 {busy ? 'Creating...' : 'Create view'}
 </button>
 </div>
 </form>
 {deleteDialog}
 </div>
 );
}
