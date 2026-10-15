/**
 * Custom fields, attachments, and import/export tests.
 *
 * The properties under test are the ones that silently fail:
 *
 * - A value for an unknown or cross-tenant field must be rejected, not stored.
 * - A select value outside the defined options must be rejected.
 * - An upload whose bytes disagree with its declared type must be rejected
 * (magic bytes, not MIME).
 * - A download for another tenant's file id must 404, not serve.
 * - An export must neutralise formula cells and stay within its own org.
 * - An import must validate headers, count failures per-row, and honour
 * idempotency keys.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { newId } from '../../lib/ids.ts';
import type { ActorRef } from '../../services/records.ts';
import { createRecord } from '../../services/records.ts';
import {
 createCustomField,
 deleteCustomField,
 getCustomFieldValues,
 listCustomFields,
 setCustomFieldValue,
} from '../../services/customFields.ts';
import {
 deleteAttachment,
 downloadAttachment,
 listAttachments,
 uploadAttachment,
} from '../../services/attachments.ts';
import {
 downloadExport,
 exportRecords,
 importRecords,
} from '../../services/transfers.ts';
import { registerUser } from '../../services/auth.ts';

let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
 const detail = x === undefined ? '' : ` -> ${String(x).slice(0, 130)}`;
 if (c) { pass++; console.log(` [PASS] ${l}`); } else { fails.push(l); console.log(` [FAIL] ${l}${detail}`); }
};

const C = { ip: '10.0.0.9', userAgent: 'item8-test/1.0', requestId: 'req-item8' };
const mkOrg = async (name: string, email: string) => {
 const r = await registerUser({
 name, email, password: 'Item8-Test-Pass!42',
 organizationName: `${name} Ltd`, client: C,
 });
 const actor: ActorRef = {
 userId: r.user.id, organizationId: r.organizationId, role: 'owner', email: r.user.email,
 };
 return actor;
};

const acme = await mkOrg('Acme', 'i8-acme@corp.io');
const globex = await mkOrg('Globex', 'i8-globex@corp.io');

const contact = await createRecord(acme, 'contacts', { first_name: 'Ada', last_name: 'L' });
const contactId = (contact as { record: Record<string, unknown> }).record['id'] as string;

console.log('\n=== custom fields: definitions ===');
const priorityField = await createCustomField(acme, {
 entityType: 'contact', key: 'priority', label: 'Priority',
 fieldType: 'select', options: ['low', 'high'],
});
T('field created with an id', typeof priorityField.id === 'string' && priorityField.id.length > 0);

{
 let dup = false;
 try {
 await createCustomField(acme, {
 entityType: 'contact', key: 'priority', label: 'Priority Again', fieldType: 'text',
 });
 } catch { dup = true; }
 T('duplicate key rejected', dup);
}
{
 let bad = false;
 try {
 await createCustomField(acme, {
 entityType: 'contact', key: 'Bad-Key!', label: 'Bad', fieldType: 'text',
 });
 } catch { bad = true; }
 T('malformed key rejected', bad);
}
{
 let bad = false;
 try {
 await createCustomField(acme, {
 entityType: 'contact', key: 'ok_key', label: 'Bad', fieldType: 'select', options: [],
 });
 } catch { bad = true; }
 T('select without options rejected', bad);
}

console.log('\n=== custom fields: values ===');
{
 const v = await setCustomFieldValue(acme, priorityField.id, contactId, 'high');
 T('valid select value stored', v?.value === 'high', v?.value);
 let bad = false;
 try {
 await setCustomFieldValue(acme, priorityField.id, contactId, 'critical');
 } catch { bad = true; }
 T('off-list select value rejected', bad);

 const cleared = await setCustomFieldValue(acme, priorityField.id, contactId, null);
 T('clearing returns null', cleared === null);
 const after = await getCustomFieldValues(acme, 'contact', contactId);
 T('cleared value reads back absent', !('priority' in after), JSON.stringify(after));

 // Cross-tenant: Globex guesses Acme's field id.
 let xTenant = false;
 try {
 await setCustomFieldValue(globex, priorityField.id, newId(), 'high');
 } catch { xTenant = true; }
 T('cross-tenant field write rejected', xTenant);

 const gxFields = await listCustomFields(globex, 'contact');
 T("Acme field invisible to Globex", gxFields.length === 0, gxFields.length);
}

console.log('\n=== attachments ===');
// Minimal valid PDF: header + one object. file-type sniffs `%PDF`.
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');
const exeBytes = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff', 'binary');
{
 const a = await uploadAttachment(acme, {
 entityType: 'contact', entityId: contactId,
 fileName: 'contract.pdf', declaredMime: 'application/pdf', buffer: pdfBytes,
 });
 T('valid PDF stored', a.contentType.includes('pdf') && a.sizeBytes === pdfBytes.length, a.contentType);

 let spoof = false;
 try {
 await uploadAttachment(acme, {
 entityType: 'contact', entityId: contactId,
 fileName: 'report.pdf', declaredMime: 'application/pdf', buffer: exeBytes,
 });
 } catch { spoof = true; }
 T('executable renamed to .pdf rejected by magic bytes', spoof);

 let html = false;
 try {
 await uploadAttachment(acme, {
 entityType: 'contact', entityId: contactId,
 fileName: 'page.html', declaredMime: 'text/html',
 buffer: Buffer.from('<html><script>alert(1)</script></html>', 'utf8'),
 });
 } catch { html = true; }
 T('HTML upload refused outright', html);

 const listed = await listAttachments(acme, 'contact', contactId);
 T('one attachment listed', listed.length === 1, listed.length);

 const { attachment, bytes } = await downloadAttachment(acme, listed[0]!.id);
 T('download returns identical bytes', bytes.equals(pdfBytes), bytes.length);
 T('download carries the stored filename', attachment.fileName === 'contract.pdf');

 let xTenant = false;
 try {
 await downloadAttachment(globex, listed[0]!.id);
 } catch { xTenant = true; }
 T("another tenant's file id 404s", xTenant);

 await deleteAttachment(acme, listed[0]!.id);
 const after = await listAttachments(acme, 'contact', contactId);
 T('deleted attachment leaves the list', after.length === 0, after.length);
}

console.log('\n=== export ===');
{
 const job = await exportRecords(acme, 'contacts', `e2e-${newId()}`);
 T('export completes', job.status === 'completed', job.status);
 T('row count recorded', typeof job.rowCount === 'number' && (job.rowCount ?? 0) >= 1, job.rowCount);
 const { bytes, fileName } = await downloadExport(acme, job.id);
 const text = bytes.toString('utf8');
 T('CSV has a header row', text.split('\n')[0]!.includes('first_name'), text.split('\n')[0]);
 T('download filename is a CSV', fileName.endsWith('.csv'), fileName);

 // Formula neutralisation: a hostile value must be quoted, not executable.
 await createRecord(acme, 'contacts', { first_name: '=cmd|evil', last_name: 'X' });
 const job2 = await exportRecords(acme, 'contacts');
 const { bytes: b2 } = await downloadExport(acme, job2.id);
 T('formula cell neutralised', b2.toString('utf8').includes("'=cmd|evil"), b2.toString('utf8').slice(0, 200));

 // Idempotency: same key returns the same job.
 const key = `idem-${newId()}`;
 const j1 = await exportRecords(globex, 'contacts', key);
 const j2 = await exportRecords(globex, 'contacts', key);
 T('idempotent export returns the same job', j1.id === j2.id, `${j1.id} vs ${j2.id}`);

 let xTenant = false;
 try {
 await downloadExport(globex, job.id);
 } catch { xTenant = true; }
 T("another tenant's export 404s", xTenant);
}

console.log('\n=== import ===');
{
 const csv = 'first_name,last_name,email\nAda,Lovelace,ada@import.test\nGrace,Hopper,grace@import.test\n';
 const job = await importRecords(acme, 'contacts', csv, `imp-${newId()}`);
 T('import completes', job.status === 'completed', job.status);
 T('two rows created', job.createdCount === 2, job.createdCount);
 T('no errors', job.errors.length === 0, job.errors.length);

 const badHeader = 'first_name,nope,email\nA,B,a@b.co\n';
 let badH = false;
 try {
 await importRecords(acme, 'contacts', badHeader);
 } catch { badH = true; }
 T('unknown column rejected', badH);

 // Partial success: one valid row, one missing its required last_name.
 // (An invalid-but-optional email would be dropped, not rejected -- so the bad
 // row omits a required column instead, which fails in createRecord.)
 const mixed = 'first_name,last_name,email\nGood,Row,good@import.test\nBad,,bad@import.test\n';
 const m = await importRecords(acme, 'contacts', mixed);
 T('partial import creates the valid row', m.createdCount === 1, m.createdCount);
 T('and reports the bad row with its line number',
 m.errors.length === 1 && m.errors[0]!.line === 3, JSON.stringify(m.errors));

 // Idempotency: same key returns the original job without re-importing.
 const key = `imp-idem-${newId()}`;
 const k1 = await importRecords(acme, 'contacts', csv, key);
 const k2 = await importRecords(acme, 'contacts', csv, key);
 T('idempotent import returns the same job', k1.id === k2.id, `${k1.id} vs ${k2.id}`);
}

console.log('\n=== field definition deletion ===');
{
 await deleteCustomField(acme, priorityField.id);
 const remaining = await listCustomFields(acme, 'contact');
 T('deleted field leaves the list', remaining.length === 0, remaining.length);
}

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
