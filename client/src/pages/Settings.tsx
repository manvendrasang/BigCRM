/**
 * Workspace settings: custom fields and import/export.
 *
 * Two admin-adjacent tools on one page because both are schema-level acts:
 * defining a field changes what every record of a type can hold, and
 * importing creates records in bulk past the per-record UI. Both routes
 * enforce their permissions server-side; this page only decides whether to
 * offer the buttons, and a 403 renders as an explanatory note rather than a
 * blank page — the user should know the feature exists and why they cannot
 * use it, not wonder whether the page is broken.
 */
import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
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

const ENTITY_TYPES = ['contact', 'company', 'lead', 'deal', 'task'] as const;
const EXPORTABLE = ['contacts', 'companies', 'leads', 'deals', 'tasks'] as const;
const FIELD_TYPES = [
  'text', 'long_text', 'number', 'currency', 'date', 'datetime',
  'boolean', 'select', 'multi_select', 'email', 'phone', 'url',
] as const;

export function Settings(): JSX.Element {
  return (
    <div>
      <h1>Settings</h1>
      <p className="muted">Custom fields and data transfer for your workspace.</p>
      <CustomFieldsSection />
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
            {exporting === t ? 'Exporting…' : `Export ${t}`}
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
      {importing && <p className="muted">Importing…</p>}
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
                  {importResult.totalRows} total · {importResult.createdCount} created ·{' '}
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
