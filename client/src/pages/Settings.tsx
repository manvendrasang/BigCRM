/**
 * Workspace settings: custom fields and import/export.
 *
 * Two admin-adjacent tools on one page because both are schema-level acts:
 * defining a field changes what every record of a type can hold, and
 * importing creates records in bulk past the per-record UI. Both routes
 * enforce their permissions server-side; this page only decides whether to
 * offer the buttons, and a 403 renders as an explanatory note rather than a
 * blank page -- the user should know the feature exists and why they cannot
 * use it, not wonder whether the page is broken.
 */
import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
 createFieldDef,
 deleteFieldDef,
 exportDownloadUrl,
 listFieldDefs,
 startExport,
 startImport,
} from '../lib/item8';
import type { CustomFieldDef, ImportResult } from '../lib/item8';
import { EmptyState, Section, useConfirm } from '../components/ui';
import { createMember, listAssignableRoles, listMembers, resetMemberPassword } from '../lib/workspace';
import type { CreatedMember, MemberRow } from '../lib/workspace';

const ENTITY_TYPES = ['contact', 'company', 'lead', 'deal', 'task'] as const;
const EXPORTABLE = ['contacts', 'companies', 'leads', 'deals', 'tasks'] as const;
const FIELD_TYPES = [
 'text', 'long_text', 'number', 'currency', 'date', 'datetime',
 'boolean', 'select', 'multi_select', 'email', 'phone', 'url',
] as const;

export function Settings(): JSX.Element {
 const { actor } = useAuth();
 // A viewer is a strictly read-only seat: custom fields are a schema-level
 // admin tool, and the server already refuses `custom_fields.read` to them.
 // Hiding the section here keeps the page from advertising a capability the
 // role deliberately does not have.
 const isViewer = actor?.role === 'viewer';
 return (
 <div className="enter">
 <h1>Settings</h1>
 <p className="muted">Custom fields, data transfer and workspace members.</p>
 {!isViewer && <CustomFieldsSection />}
 <MembersSection />
 <TransfersSection />
 </div>
 );
}

function CustomFieldsSection(): JSX.Element {
 const [entityType, setEntityType] = useState<string>('contact');
 const [fields, setFields] = useState<CustomFieldDef[]>([]);
 const [error, setError] = useState<string | null>(null);
 const [forbidden, setForbidden] = useState(false);
 const [key, setKey] = useState('');
 const [label, setLabel] = useState('');
 const [fieldType, setFieldType] = useState<string>('text');
 const [options, setOptions] = useState('');
 const { confirm: confirmDelete, dialog: deleteDialog } = useConfirm();

 async function load(et: string): Promise<void> {
 setError(null);
 setForbidden(false);
 try {
 setFields(await listFieldDefs(et));
 } catch (err) {
 if (err instanceof ApiError && err.status === 403) setForbidden(true);
 else setError(err instanceof ApiError ? err.message : 'Could not load fields.');
 setFields([]);
 }
 }

 useEffect(() => {
 void load(entityType);
 }, [entityType]);

 async function create(e: React.FormEvent): Promise<void> {
 e.preventDefault();
 setError(null);
 try {
 await createFieldDef({
 entityType,
 key: key.trim(),
 label: label.trim(),
 fieldType,
 options: fieldType === 'select' || fieldType === 'multi_select'
 ? options.split(',').map((o) => o.trim()).filter(Boolean)
 : undefined,
 });
 setKey('');
 setLabel('');
 setOptions('');
 await load(entityType);
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not create the field.');
 }
 }

 async function remove(id: string): Promise<void> {
 const confirmed = await confirmDelete({
 title: 'Delete this field?',
 message: 'Values already stored are kept for audit.',
 confirmLabel: 'Delete',
 });
 if (!confirmed) return;
 try {
 await deleteFieldDef(id);
 await load(entityType);
 } catch (err) {
 setError(err instanceof ApiError ? err.message : 'Could not delete the field.');
 }
 }

 const needsOptions = fieldType === 'select' || fieldType === 'multi_select';

 return (
 <Section title="Custom fields">
 <p className="muted">Extra fields on records, defined per workspace.</p>

 <div className="toolbar">
 <label>
 Records:{' '}
 <select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
 {ENTITY_TYPES.map((t) => (
 <option key={t} value={t}>
 {t}s
 </option>
 ))}
 </select>
 </label>
 </div>

 {forbidden && (
 <p className="muted">You need the custom-fields permission to manage fields. Ask an admin.</p>
 )}
 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}

 {!forbidden && (
 <>
 {fields.length === 0 ? (
 <EmptyState message={`No custom fields for ${entityType} yet.`} />
 ) : (
 <div className="table-wrap">
 <table className="records">
 <thead>
 <tr>
 <th scope="col">Label</th>
 <th scope="col">Key</th>
 <th scope="col">Type</th>
 <th scope="col">Required</th>
 <th scope="col">Actions</th>
 </tr>
 </thead>
 <tbody>
 {fields.map((f) => (
 <tr key={f.id}>
 <td>{f.label}</td>
 <td>
 <code>{f.key}</code>
 </td>
 <td>{f.fieldType}</td>
 <td>{f.isRequired ? 'Yes' : 'No'}</td>
 <td>
 <button
 type="button"
 className="btn btn-secondary btn-sm"
 onClick={() => { void remove(f.id); }}
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

 <h3 className="subsection-title">New field</h3>
 <form onSubmit={(e) => { void create(e); }}>
 <div className="form-grid">
 <label className="field">
 <span>Label *</span>
 <input value={label} required onChange={(e) => setLabel(e.target.value)} />
 </label>
 <label className="field">
 <span>Key * (a-z, 0-9, _)</span>
 <input value={key} required onChange={(e) => setKey(e.target.value)} />
 </label>
 <label className="field">
 <span>Type</span>
 <select value={fieldType} onChange={(e) => setFieldType(e.target.value)}>
 {FIELD_TYPES.map((t) => (
 <option key={t} value={t}>
 {t}
 </option>
 ))}
 </select>
 </label>
 {needsOptions && (
 <label className="field">
 <span>Options (comma-separated) *</span>
 <input value={options} onChange={(e) => setOptions(e.target.value)} />
 </label>
 )}
 </div>
 <div className="form-actions">
 <button type="submit" className="btn btn-primary">
 Create field
 </button>
 </div>
 </form>
 </>
 )}
 {deleteDialog}
 </Section>
 );
}

function TransfersSection(): JSX.Element {
 const [exporting, setExporting] = useState<string | null>(null);
 const [lastExport, setLastExport] = useState<{ id: string; entityType: string } | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [forbidden, setForbidden] = useState(false);
 const [importType, setImportType] = useState('contacts');
 const [importResult, setImportResult] = useState<ImportResult | null>(null);
 const [importing, setImporting] = useState(false);

 async function doExport(entityType: string): Promise<void> {
 setExporting(entityType);
 setError(null);
 setForbidden(false);
 try {
 const job = await startExport(entityType);
 setLastExport({ id: job.id, entityType });
 } catch (err) {
 if (err instanceof ApiError && err.status === 403) setForbidden(true);
 else setError(err instanceof ApiError ? err.message : 'Export failed.');
 } finally {
 setExporting(null);
 }
 }

 async function doImport(file: File | undefined): Promise<void> {
 if (!file) return;
 setImporting(true);
 setError(null);
 setImportResult(null);
 try {
 const text = await file.text();
 setImportResult(await startImport(importType, text));
 } catch (err) {
 if (err instanceof ApiError && err.status === 403) setForbidden(true);
 else setError(err instanceof ApiError ? err.message : 'Import failed.');
 } finally {
 setImporting(false);
 }
 }

 return (
 <Section title="Import / export">
 <p className="muted">Bulk transfer as CSV. Exports expire after 7 days.</p>

 {forbidden && (
 <p className="muted">You need the import/export permission. Ask an admin.</p>
 )}
 {error && (
 <p className="alert alert-error" role="alert">
 {error}
 </p>
 )}

 <h3 className="subsection-title">Export</h3>
 <div className="toolbar">
 {EXPORTABLE.map((t) => (
 <button
 key={t}
 type="button"
 className="btn btn-secondary"
 disabled={exporting !== null}
 onClick={() => { void doExport(t); }}
 >
 {exporting === t ? 'Exporting...' : `Export ${t}`}
 </button>
 ))}
 </div>
 {lastExport && (
 <p>
 Ready:{' '}
 <a href={exportDownloadUrl(lastExport.id)} download>
 Download {lastExport.entityType} CSV
 </a>
 </p>
 )}

 <h3 className="subsection-title">Import</h3>
 <p className="muted">
 CSV with a header row matching writable columns (e.g. first_name, last_name, email).
 Bad rows are reported with line numbers; valid rows still import.
 </p>
 <div className="toolbar">
 <label>
 Into:{' '}
 <select value={importType} onChange={(e) => setImportType(e.target.value)}>
 <option value="contacts">contacts</option>
 <option value="companies">companies</option>
 <option value="leads">leads</option>
 </select>
 </label>
 <input
 type="file"
 accept=".csv,text/csv"
 disabled={importing}
 onChange={(e) => { void doImport(e.target.files?.[0]); }}
 aria-label="CSV file to import"
 />
 </div>
 {importing && <p className="muted">Importing...</p>}
 {importResult && (
 <div className="table-wrap">
 <table className="records">
 <tbody>
 <tr>
 <td>Status</td>
 <td>{importResult.status}</td>
 </tr>
 <tr>
 <td>Rows</td>
 <td>
 {importResult.totalRows} total - {importResult.createdCount} created -{' '}
 {importResult.skippedCount} skipped
 </td>
 </tr>
 {importResult.errors.slice(0, 10).map((e, i) => (
 <tr key={i}>
 <td>Line {e.line}</td>
 <td>{e.message}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 </Section>
 );
}

function MembersSection(): JSX.Element {
 const [members, setMembers] = useState<MemberRow[]>([]);
 // Roles the server says this actor may grant. Empty means "no authority to
 // create members", which is the same gate the endpoint enforces.
 const [assignable, setAssignable] = useState<string[]>([]);
 const [email, setEmail] = useState('');
 const [name, setName] = useState('');
 const [role, setRole] = useState('');
 const [error, setError] = useState<string | null>(null);
 const [forbidden, setForbidden] = useState(false);
 const [busy, setBusy] = useState(false);
 const [created, setCreated] = useState<CreatedMember | null>(null);

 // Password reset (owner/admin acts on a member's request). The card collects
 // the new password twice; the server validates the single value it receives.
 const [searchParams, setSearchParams] = useSearchParams();
 const [resetTarget, setResetTarget] = useState<MemberRow | null>(null);
 const [newPassword, setNewPassword] = useState('');
 const [repeatPassword, setRepeatPassword] = useState('');
 const [resetError, setResetError] = useState<string | null>(null);
 const [resetBusy, setResetBusy] = useState(false);
 const [resetDone, setResetDone] = useState<string | null>(null);

 // Least-privileged grantable role until the user picks one. The select is
 // bound to this, so an untouched form never submits an ungrantable role.
 const selectedRole = assignable.includes(role)
 ? role
 : (assignable[assignable.length - 1] ?? '');

 const load = useCallback(async () => {
  setError(null);
  setForbidden(false);
  try {
   setMembers(await listMembers());
  } catch (err) {
   if (err instanceof ApiError && err.status === 403) setForbidden(true);
   else setError(err instanceof ApiError ? err.message : 'Could not load members.');
   setMembers([]);
  }
  // A non-admin is refused here too; that is not an error worth showing, it
  // simply means the create form stays hidden.
  try {
   setAssignable((await listAssignableRoles()).assignable);
  } catch {
   setAssignable([]);
  }
 }, []);

 useEffect(() => {
  void load();
 }, [load]);

 // A password-reset notification links to `/settings?member=<id>`. Once the
 // roster loads, open the reset card for that member if this actor may reset
 // them, then drop the param so a refresh does not reopen it.
 const requestedMemberId = searchParams.get('member');
 useEffect(() => {
  if (!requestedMemberId || members.length === 0) return;
  const target = members.find((m) => m.userId === requestedMemberId);
  if (target?.canResetPassword) setResetTarget(target);
  setSearchParams({}, { replace: true });
 }, [requestedMemberId, members, setSearchParams]);

 function openReset(m: MemberRow): void {
  setResetTarget(m);
  setNewPassword('');
  setRepeatPassword('');
  setResetError(null);
 }

 function closeReset(): void {
  setResetTarget(null);
  setNewPassword('');
  setRepeatPassword('');
  setResetError(null);
 }

 async function submitReset(e: React.FormEvent): Promise<void> {
  e.preventDefault();
  if (!resetTarget) return;
  if (newPassword.length === 0) {
   setResetError('Enter a new password.');
   return;
  }
  if (newPassword !== repeatPassword) {
   setResetError('The two passwords do not match.');
   return;
  }
  setResetBusy(true);
  setResetError(null);
  try {
   await resetMemberPassword(resetTarget.userId, newPassword);
   setResetDone(resetTarget.email);
   closeReset();
   await load();
  } catch (err) {
   setResetError(err instanceof ApiError ? err.message : 'Could not reset the password.');
  } finally {
   setResetBusy(false);
  }
 }

 async function create(e: React.FormEvent): Promise<void> {
  e.preventDefault();
  if (!email.trim() || !selectedRole) return;
  setBusy(true);
  setError(null);
  setCreated(null);
  try {
   const result = await createMember({
    email: email.trim(),
    role: selectedRole,
    name: name.trim() || undefined,
   });
   setCreated(result);
   setEmail('');
   setName('');
   setRole('');
   await load();
  } catch (err) {
   setError(err instanceof ApiError ? err.message : 'Could not create the member.');
  } finally {
   setBusy(false);
  }
 }

 return (
  <Section title="Members">
   <p className="muted">
    People in this workspace. Accounts are created here -- there is no public signup -- and the
    generated password is shown once, for you to hand over.
   </p>

   {forbidden && (
    <p className="muted">You need the users permission to view members. Ask an admin.</p>
   )}
   {error !== null && (
    <p className="alert alert-error" role="alert">{error}</p>
   )}

   {created && (
    <div className="alert" role="status">
     <strong>Account created for {created.user.email}</strong>
     <p className="muted">
      Copy the password now and hand it to the member over a secure channel. It is not stored and
      cannot be shown again.
     </p>
     <p><strong>Email:</strong> {created.user.email}</p>
     <p><strong>Password:</strong> <code>{created.generatedPassword}</code></p>
     <p><strong>Role:</strong> {created.membershipRole}</p>
     <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreated(null)}>
      Dismiss
     </button>
    </div>
   )}

   {resetDone && (
    <div className="alert" role="status">
     <strong>Password reset for {resetDone}</strong>
     <p className="muted">
      Their existing sessions were signed out. Give them the new password over a secure channel.
     </p>
     <button type="button" className="btn btn-secondary btn-sm" onClick={() => setResetDone(null)}>
      Dismiss
     </button>
    </div>
   )}

   {!forbidden && (members.length === 0 ? (
    <EmptyState message="No members yet." />
   ) : (
    <div className="table-wrap">
     <table className="records">
      <thead>
       <tr>
        <th scope="col">Name</th>
        <th scope="col">Email</th>
        <th scope="col">Role</th>
        <th scope="col">MFA</th>
        <th scope="col">Last login</th>
        {members.some((m) => m.canResetPassword) && <th scope="col">Actions</th>}
       </tr>
      </thead>
      <tbody>
       {members.map((m) => (
        <tr key={m.userId}>
         <td>
          {m.name}
          {m.passwordResetRequested && (
           <>
            {' '}
            <span className="badge" title="This member asked the office to set a new password.">
             Reset requested
            </span>
           </>
          )}
         </td>
         <td>{m.email}</td>
         <td>{m.role}</td>
         <td>{m.mfaEnabled ? 'On' : 'Off'}</td>
         <td>{m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : 'Never'}</td>
         {members.some((x) => x.canResetPassword) && (
          <td>
           {m.canResetPassword ? (
            <button
             type="button"
             className="btn btn-secondary btn-sm"
             onClick={() => openReset(m)}
            >
             Reset password
            </button>
           ) : (
            <span className="muted">--</span>
           )}
          </td>
         )}
        </tr>
       ))}
      </tbody>
     </table>
    </div>
   ))}

   {!forbidden && assignable.length > 0 && (
    <form onSubmit={(e) => { void create(e); }}>
     <h3 className="subsection-title">Create member</h3>
     <div className="form-grid">
      <label className="field">
       <span>Email</span>
       <input
        type="email"
        value={email}
        required
        onChange={(e) => setEmail(e.target.value)}
       />
      </label>
      <label className="field">
       <span>Name</span>
       <input
        type="text"
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
       />
      </label>
      <label className="field">
       <span>Role</span>
       <select value={selectedRole} onChange={(e) => setRole(e.target.value)}>
        {assignable.map((r) => (
         <option key={r} value={r}>{r}</option>
        ))}
       </select>
      </label>
     </div>
     <div className="form-actions">
      <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
       {busy ? 'Creating...' : 'Create member'}
      </button>
     </div>
    </form>
   )}

   {resetTarget && (
    <div className="modal-scrim" onClick={closeReset}>
     <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-password-title"
      onClick={(e) => e.stopPropagation()}
     >
      <h2 id="reset-password-title">Reset password</h2>
      <p className="muted">
       Set a new password for <strong>{resetTarget.email}</strong>. They will be signed out
       everywhere and must use the new password next time.
      </p>
      <form onSubmit={(e) => { void submitReset(e); }}>
       {resetError !== null && (
        <p className="alert alert-error" role="alert">{resetError}</p>
       )}
       <label className="field">
        <span>New password</span>
        <input
         type="password"
         autoComplete="new-password"
         value={newPassword}
         onChange={(e) => setNewPassword(e.target.value)}
        />
       </label>
       <label className="field">
        <span>Repeat password</span>
        <input
         type="password"
         autoComplete="new-password"
         value={repeatPassword}
         onChange={(e) => setRepeatPassword(e.target.value)}
        />
       </label>
       <div className="form-actions modal-actions">
        <button type="button" className="btn btn-secondary" onClick={closeReset} disabled={resetBusy}>
         Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={resetBusy}>
         {resetBusy ? 'Saving...' : 'OK'}
        </button>
       </div>
      </form>
     </div>
    </div>
   )}
  </Section>
 );
}
