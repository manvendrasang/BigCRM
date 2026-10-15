/**
 * Record attachments and custom-field values.
 *
 * Rendered at the bottom of the record detail page. Two independent sections
 * sharing one component file because they share a lifecycle: both load when
 * the record loads, both degrade to a note when the permission is absent, and
 * neither blocks the other — a failed attachment list must not hide the custom
 * values, and vice versa.
 *
 * The entity-type mapping lives in the record config (`entity`): the record
 * router uses plurals (`contacts`) while custom fields and attachments use
 * singulars (`contact`). A missing entry renders nothing rather than
 * requesting with an undefined type.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import {
  deleteAttachment,
  downloadUrl,
  fileSize,
  getFieldValues,
  listAttachments,
  listFieldDefs,
  setFieldValue,
  uploadAttachment,
} from '../lib/item8';
import type { AttachmentRow, CustomFieldDef } from '../lib/item8';
import type { RecordType } from '../lib/records';
import { RECORD_CONFIGS } from '../lib/recordConfig';
import { EmptyState, Section, useConfirm } from './ui';

export function RecordExtras({ type, id }: { type: RecordType; id: string }): JSX.Element {
  const singular = RECORD_CONFIGS[type].entity;
  return (
    <>
      <CustomValues type={type} singular={singular} entityId={id} />
      <Attachments type={type} singular={singular} entityId={id} />
    </>
  );
}

function CustomValues({
  singular,
  entityId,
}: {
  type: RecordType;
  singular: string;
  entityId: string;
}): JSX.Element {
  const [defs, setDefs] = useState<CustomFieldDef[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, v] = await Promise.all([
        listFieldDefs(singular),
        getFieldValues(singular, entityId),
      ]);
      setDefs(d);
      setValues(v);
      setVisible(true);
    } catch (err) {
      // 403 (no custom_fields.read) hides the section silently: the user
      // simply has no custom fields, which is a true statement about what they
      // can see. Anything else is an error worth showing.
      if (err instanceof ApiError && err.status === 403) setVisible(false);
      else setError(err instanceof ApiError ? err.message : 'Could not load custom fields.');
    }
  }, [singular, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(fieldId: string, value: unknown): Promise<void> {
    try {
      await setFieldValue(fieldId, entityId, value);
      setValues(await getFieldValues(singular, entityId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the value.');
    }
  }

  if (!visible && !error) return <></>;
  if (error) {
    return (
      <p className="alert alert-error" role="alert">
        {error}
      </p>
    );
  }
  if (defs.length === 0) return <></>;

  return (
    <Section title="Custom fields">
      <div className="form-grid">
        {defs.map((d) => (
          <CustomInput
            key={d.id}
            def={d}
            value={values[d.key]}
            onSave={(v) => { void save(d.id, v); }}
          />
        ))}
      </div>
    </Section>
  );
}

function CustomInput({
  def,
  value,
  onSave,
}: {
  def: CustomFieldDef;
  value: unknown;
  onSave: (v: unknown) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value ?? ''));

  useEffect(() => {
    setDraft(typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  }, [value]);

  function commit(): void {
    const v = draft.trim();
    if (def.fieldType === 'boolean') {
      onSave(draft === 'true');
      return;
    }
    if (def.fieldType === 'number' || def.fieldType === 'currency') {
      onSave(v === '' ? null : Number(v));
      return;
    }
    onSave(v === '' ? null : v);
  }

  return (
    <label className="field">
      <span>
        {def.label}
        {def.isRequired ? ' *' : ''}
      </span>
      {def.fieldType === 'boolean' ? (
        <select value={draft} onChange={(e) => { setDraft(e.target.value); onSave(e.target.value === 'true'); }}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : def.fieldType === 'select' ? (
        <select
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onSave(e.target.value === '' ? null : e.target.value);
          }}
        >
          <option value="">—</option>
          {def.options.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      )}
    </label>
  );
}

function Attachments({
  singular,
  entityId,
}: {
  type: RecordType;
  singular: string;
  entityId: string;
}): JSX.Element {
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const { confirm: confirmDelete, dialog: deleteDialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      setRows(await listAttachments(singular, entityId));
      setVisible(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setVisible(false);
      else setError(err instanceof ApiError ? err.message : 'Could not load attachments.');
    }
  }, [singular, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File | undefined): Promise<void> {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadAttachment(singular, entityId, file);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string): Promise<void> {
    const confirmed = await confirmDelete({
      title: 'Delete this file?',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    try {
      await deleteAttachment(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the file.');
    }
  }

  if (!visible && !error) return <></>;
  if (error) {
    return (
      <p className="alert alert-error" role="alert">
        {error}
      </p>
    );
  }

  return (
    <Section title="Files">
      {rows.length === 0 ? (
        <EmptyState message="No files attached." />
      ) : (
        <div className="table-wrap">
          <table className="records">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Size</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={downloadUrl(r.id)} download>
                      {r.fileName}
                    </a>
                  </td>
                  <td>{fileSize(r.sizeBytes)}</td>
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
      <div className="toolbar">
        <input
          type="file"
          disabled={uploading}
          onChange={(e) => { void upload(e.target.files?.[0]); }}
          aria-label="Attach a file"
        />
        {uploading && <span className="muted">Uploading…</span>}
      </div>
      {deleteDialog}
    </Section>
  );
}
