/**
 * Custom fields: per-organisation definitions on the five record types, values
 * stored generically in `custom_field_values`.
 *
 * Validation lives here rather than in the route, which only parses the
 * envelope. This module decides whether a value is acceptable for a field: a
 * `number` given `"twelve"`, a `select` given an undefined option, and an unknown
 * key are all rejected with 400 before any write. The database CHECK
 * constraints are the backstop, not the mechanism.
 *
 * Both tables are tenant-scoped. A field defined by org A is invisible to org B
 * even when B guesses the id, because the definition lookup filters by org and
 * the value write therefore fails closed with "unknown field".
 */
import { TenantScope } from '../repositories/base.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import type { ActorRef } from './records.ts';

const ENTITY_TYPES: readonly string[] = ['contact', 'company', 'lead', 'deal', 'task'];
const FIELD_TYPES: readonly string[] = [
 'text', 'long_text', 'number', 'currency', 'date', 'datetime',
 'boolean', 'select', 'multi_select', 'email', 'phone', 'url',
];
const KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;

export type CustomField = {
 id: string;
 entityType: string;
 key: string;
 label: string;
 fieldType: string;
 options: unknown[];
 defaultValue: unknown;
 isRequired: boolean;
 isSearchable: boolean;
 position: number;
};

export type CustomFieldValue = {
 fieldId: string;
 entityType: string;
 entityId: string;
 value: unknown;
};

const rowToField = (r: Record<string, unknown>): CustomField => ({
 id: String(r['id']),
 entityType: String(r['entity_type']),
 key: String(r['key']),
 label: String(r['label']),
 fieldType: String(r['field_type']),
 options: Array.isArray(r['options']) ? (r['options'] as unknown[]) : [],
 defaultValue: r['default_value'] ?? null,
 isRequired: r['is_required'] === true,
 isSearchable: r['is_searchable'] === true,
 position: Number(r['position'] ?? 0),
});

/** Lists an org's field definitions for one entity type, in position order. */
export async function listCustomFields(
 actor: ActorRef,
 entityType: string,
): Promise<CustomField[]> {
 if (!ENTITY_TYPES.includes(entityType)) throw badRequest(`Unknown entity type '${entityType}'.`);
 const scope = new TenantScope(actor.organizationId);
 const rows = await scope.query(
 `SELECT * FROM custom_fields
 WHERE organization_id = $1 AND entity_type = $2 AND deleted_at IS NULL
 ORDER BY position, label`,
 [actor.organizationId, entityType],
 );
 return rows.map(rowToField);
}

/** Defines a new custom field. Key must be unique per org+entity. */
export async function createCustomField(
 actor: ActorRef,
 input: {
 entityType: string; key: string; label: string; fieldType: string;
 options?: unknown[]; defaultValue?: unknown;
 isRequired?: boolean; isSearchable?: boolean; position?: number;
 },
): Promise<CustomField> {
 const { entityType, key, label, fieldType } = input;
 if (!ENTITY_TYPES.includes(entityType)) throw badRequest(`Unknown entity type '${entityType}'.`);
 if (!KEY_RE.test(key)) {
 throw badRequest("Key must start with a lowercase letter and contain only a-z, 0-9 and '_'.");
 }
 const cleanLabel = label.trim();
 if (cleanLabel.length < 1 || cleanLabel.length > 80) {
 throw badRequest('Label must be between 1 and 80 characters.');
 }
 if (!FIELD_TYPES.includes(fieldType)) throw badRequest(`Unknown field type '${fieldType}'.`);

 const options = Array.isArray(input.options) ? input.options.slice(0, 100) : [];
 if ((fieldType === 'select' || fieldType === 'multi_select') && options.length === 0) {
 throw badRequest('Select fields need at least one option.');
 }
 if (fieldType !== 'select' && fieldType !== 'multi_select' && options.length > 0) {
 throw badRequest('Only select fields take options.');
 }

 const scope = new TenantScope(actor.organizationId);
 const id = newId();
 const now = nowIso();
 try {
 await scope.query(
 `INSERT INTO custom_fields
 (id,organization_id,entity_type,key,label,field_type,options,default_value,
 is_required,is_searchable,position,created_at,updated_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$12)`,
 [id, actor.organizationId, entityType, key, cleanLabel, fieldType,
 JSON.stringify(options), JSON.stringify(input.defaultValue ?? null),
 input.isRequired === true, input.isSearchable === true,
 Number(input.position ?? 0) || 0, now],
 );
 } catch (err) {
 if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
 throw badRequest(`A field with key '${key}' already exists for ${entityType}.`);
 }
 throw err;
 }
 const rows = await scope.query(
 `SELECT * FROM custom_fields WHERE organization_id = $1 AND id = $2`,
 [actor.organizationId, id],
 );
 return rowToField(rows[0]!);
}

/** Soft-deletes a field definition. Values are left in place for audit. */
export async function deleteCustomField(actor: ActorRef, id: string): Promise<void> {
 const scope = new TenantScope(actor.organizationId);
 const r = await scope.query(
 `UPDATE custom_fields SET deleted_at = $3, updated_at = $3
 WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
 RETURNING id`,
 [actor.organizationId, id, nowIso()],
 );
 if (r.length === 0) throw notFound('Custom field not found.');
}

/**
 * Validates a value against a field definition and stores it.
 *
 * The column written depends on the type: text-ish into `value_text`, numbers
 * into `value_number`, dates into `value_date`, booleans into `value_bool`,
 * selects into `value_json`. A `null` value deletes the row -- clearing a field
 * removes it rather than storing a NULL that every reader must special-case.
 */
export async function setCustomFieldValue(
 actor: ActorRef,
 fieldId: string,
 entityId: string,
 value: unknown,
): Promise<CustomFieldValue | null> {
 const scope = new TenantScope(actor.organizationId);
 const defs = await scope.query(
 `SELECT * FROM custom_fields
 WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
 [actor.organizationId, fieldId],
 );
 if (defs.length === 0) throw notFound('Custom field not found.');
 const def = rowToField(defs[0]!);

 if (value === null || value === undefined || value === '') {
 if (def.isRequired) throw badRequest(`'${def.label}' is required.`);
 await scope.query(
 `DELETE FROM custom_field_values
 WHERE organization_id = $1 AND field_id = $2 AND entity_id = $3`,
 [actor.organizationId, fieldId, entityId],
 );
 return null;
 }

 const cols: { text: string | null; number: number | null; date: string | null; bool: boolean | null; json: string | null } =
 { text: null, number: null, date: null, bool: null, json: null };

 switch (def.fieldType) {
 case 'text': case 'long_text': case 'email': case 'phone': case 'url': {
 if (typeof value !== 'string') throw badRequest(`'${def.label}' must be text.`);
 if (value.length > 10000) throw badRequest(`'${def.label}' is too long.`);
 if (def.fieldType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
 throw badRequest(`'${def.label}' must be an email address.`);
 }
 if (def.fieldType === 'url') {
 try {
 const u = new URL(value);
 if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad scheme');
 } catch {
 throw badRequest(`'${def.label}' must be an http(s) URL.`);
 }
 }
 cols.text = value;
 break;
 }
 case 'number': case 'currency': {
 const n = typeof value === 'number' ? value : Number(value);
 if (!Number.isFinite(n)) throw badRequest(`'${def.label}' must be a number.`);
 cols.number = n;
 break;
 }
 case 'date': case 'datetime': {
 const d = new Date(String(value));
 if (Number.isNaN(d.getTime())) throw badRequest(`'${def.label}' must be a date.`);
 cols.date = d.toISOString();
 break;
 }
 case 'boolean': {
 if (typeof value !== 'boolean') throw badRequest(`'${def.label}' must be true or false.`);
 cols.bool = value;
 break;
 }
 case 'select': {
 if (typeof value !== 'string' || !def.options.includes(value)) {
 throw badRequest(`'${def.label}' must be one of: ${def.options.map(String).join(', ')}.`);
 }
 cols.json = JSON.stringify(value);
 break;
 }
 case 'multi_select': {
 if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && def.options.includes(v))) {
 throw badRequest(`'${def.label}' must be a list of: ${def.options.map(String).join(', ')}.`);
 }
 cols.json = JSON.stringify(value);
 break;
 }
 default:
 throw badRequest(`Unknown field type '${def.fieldType}'.`);
 }

 const now = nowIso();
 await scope.query(
 `INSERT INTO custom_field_values
 (organization_id,field_id,entity_type,entity_id,
 value_text,value_number,value_date,value_bool,value_json,created_at,updated_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10)
 ON CONFLICT (field_id, entity_id) DO UPDATE SET
 value_text = EXCLUDED.value_text, value_number = EXCLUDED.value_number,
 value_date = EXCLUDED.value_date, value_bool = EXCLUDED.value_bool,
 value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`,
 [actor.organizationId, fieldId, def.entityType, entityId,
 cols.text, cols.number, cols.date, cols.bool, cols.json, now],
 );
 return { fieldId, entityType: def.entityType, entityId, value };
}

/** All values on one entity, keyed by field key. */
export async function getCustomFieldValues(
 actor: ActorRef,
 entityType: string,
 entityId: string,
): Promise<Record<string, unknown>> {
 if (!ENTITY_TYPES.includes(entityType)) throw badRequest(`Unknown entity type '${entityType}'.`);
 const scope = new TenantScope(actor.organizationId);
 const rows = await scope.query(
 `SELECT f.key, v.value_text, v.value_number, v.value_date, v.value_bool, v.value_json,
 f.field_type
 FROM custom_field_values v
 JOIN custom_fields f ON f.id = v.field_id AND f.deleted_at IS NULL
 WHERE v.organization_id = $1 AND v.entity_type = $2 AND v.entity_id = $3`,
 [actor.organizationId, entityType, entityId],
 );
 const out: Record<string, unknown> = {};
 for (const r of rows) {
 const t = String(r['field_type']);
 out[String(r['key'])] =
 t === 'number' || t === 'currency' ? r['value_number']
 : t === 'date' || t === 'datetime' ? r['value_date']
 : t === 'boolean' ? r['value_bool']
 : t === 'select' || t === 'multi_select' ? r['value_json']
 : r['value_text'];
 }
 return out;
}
