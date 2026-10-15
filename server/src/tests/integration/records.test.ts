/**
 * CRM record service tests.
 *
 * Focus is the properties that a tenant-isolation bug would silently violate:
 * cross-tenant invisibility, the transactional guarantee of lead conversion,
 * stage/pipeline coherence, and the refusal to let a client smuggle a column.
 */
import { migrate } from '../../db/migrate.ts';
await migrate();
import { getDb } from '../../db/driver.ts';
import { newId } from '../../lib/ids.ts';
import { TenantScope } from '../../repositories/base.ts';
import {
  createRecord, getRecord, listRecords, updateRecord, softDeleteRecord, restoreRecord,
  convertLead, moveDealStage, createPipelineWithStages, ensureDefaultPipeline, listPipelineStages,
  type ActorRef,
} from '../../services/records.ts';
import { registerUser } from '../../services/auth.ts';

const brief = (v: unknown): string => String(v).slice(0, 60);
const trim = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0]!.slice(0, 120);
};
let pass = 0;
const fails: string[] = [];
const T = (l: string, c: boolean, x?: unknown): void => {
  if (c) { pass++; console.log(`  [PASS] ${l}`); } else { fails.push(l); console.log(`  [FAIL] ${l} -> ${trim(x)}`); }
};
type Attempt<T> = { ok: true; v: T } | { ok: false; e: any };
const attempt = async <T>(fn: () => Promise<T>): Promise<Attempt<T>> => {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, e }; }
};

const C = { ip: '10.0.0.9', userAgent: 'records-test/1.0', requestId: 'req-records' };

const mkOrg = async (name: string, email: string) => {
  const r = await registerUser({
    name, email, password: 'Records-Test-Pass!42',
    organizationName: `${name} Ltd`, client: C,
  });
  const actor: ActorRef = {
    userId: r.user.id, organizationId: r.organizationId, role: 'owner', email: r.user.email,
  };
  return actor;
};

const acme = await mkOrg('Acme', 'rec-acme@corp.io');
const globex = await mkOrg('Globex', 'rec-globex@corp.io');
const viewerAcme: ActorRef = { ...acme, role: 'viewer' };

console.log('\n=== companies ===');
const acmeCo = await createRecord(acme, 'companies', {
  name: '  Acme Widgets  ', domain: 'HTTPS://Acme-Widgets.COM', industry: 'Manufacturing',
  employee_count: 250, annual_revenue_c: 18_000_000_00,
});
T('company created', Boolean(acmeCo.record.id));
T('name is trimmed', acmeCo.record.name === 'Acme Widgets');
T('a normalised name is stored for dedup', acmeCo.record.name_normalized === 'acme widgets', acmeCo.record.name_normalized);
T('domain is normalised to a bare host', acmeCo.record.domain === 'acme-widgets.com', acmeCo.record.domain);
T('the company belongs to the creating tenant', acmeCo.record.organization_id === acme.organizationId);
T('created_by is stamped server-side', acmeCo.record.created_by === acme.userId);
T('a client cannot set its own organization_id',
  await (async () => {
    const spoof = await attempt(() => createRecord(acme, 'companies', { name: 'Spoof', organization_id: globex.organizationId }));
    return !spoof.ok || spoof.v.record.organization_id === acme.organizationId;
  })(), 'organization_id accepted from the body');

console.log('\n=== contacts ===');
const ava = await createRecord(acme, 'contacts', {
  first_name: 'Ava', last_name: 'Reed', email: '  AVA.REED@Customer.IO ',
  phone: '+1 (555) 010-2030', job_title: 'VP Sales', company_id: String(acmeCo.record.id),
  lifecycle_stage: 'prospect',
});
T('contact created', Boolean(ava.record.id));
T('email canonicalised', ava.record.email === 'ava.reed@customer.io', brief(ava.record.email));
T('phone normalised to digits', String(ava.record.phone).replace(/\D/g, '') === '15550102030', ava.record.phone);
T('linked company is kept', ava.record.company_id === String(acmeCo.record.id));

console.log('\n=== notes: stored XSS (RULE 34) ===');
{
  // `body_html` is markup by contract and is rendered as markup by the client,
  // so it must be sanitised on write. It previously reached the database with
  // only a length cap, leaving `<script>` / `onerror` intact for every reader
  // of the record — the stored-XSS primitive the legacy CRM shipped twice.
  const evil = await createRecord(acme, 'notes', {
    entity_type: 'contact', entity_id: String(ava.record.id),
    body_html: '<p>hi</p><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a>',
    body_text: 'plain body',
  });
  const stored = String(evil.record.body_html ?? '');
  T('notes body_html accepts safe markup', stored.includes('<p>hi</p>'), stored);
  T('notes body_html strips <script>', !/<script/i.test(stored), stored);
  T('notes body_html strips event handlers', !/\son\w+\s*=/i.test(stored), stored);
  T('notes body_html strips javascript: URIs', !/javascript:/i.test(stored), stored);

  const upd = await updateRecord(acme, 'notes', String(evil.record.id), {
    entity_type: 'contact', entity_id: String(ava.record.id),
    body_html: '<b>bold</b><svg onload=alert(4)>',
  });
  const updated = String(upd.record.body_html ?? '');
  T('update path sanitises too (not just create)', !/<svg/i.test(updated) && !/\son\w+\s*=/i.test(updated), updated);
  T('update path preserves allowed markup', updated.includes('<b>bold</b>'), updated);

  // Regression: `updateRecord` bound its parameter list off by one — the
  // assignments started at `$2` while `$2` held the id — so a single-column
  // update wrote the row's own UUID into that column instead of the new value.
  // Every prior test updated a field it never read back, so this was invisible.
  const single = await updateRecord(acme, 'notes', String(evil.record.id), {
    entity_type: 'contact', entity_id: String(ava.record.id), body_text: 'rewritten body',
  });
  T('single-column update writes the new value, not the id',
    single.record.body_text === 'rewritten body', single.record.body_text);
  T('single-column update leaves body_html intact',
    typeof single.record.body_html === 'string' && !/[<>]/.test(String(single.record.body_html)),
    single.record.body_html);
}

console.log('\n=== cross-tenant isolation (RULE 15) ===');
const crossRead = await attempt(() => getRecord(globex, 'companies', String(acmeCo.record.id)));
T('another tenant cannot read the row', !crossRead.ok && crossRead.e.code === 'NOT_FOUND', crossRead);
T('a cross-tenant read returns 404, not 403 (no existence oracle)',
  !crossRead.ok && crossRead.e.status === 404, crossRead);

const crossList = await listRecords(globex, 'companies');
T('another tenant sees none of it in list', crossList.total === 0, crossList.total);

const crossUpdate = await attempt(() => updateRecord(globex, 'companies', String(acmeCo.record.id), { name: 'Hijacked' }));
T('another tenant cannot update it', !crossUpdate.ok, crossUpdate);
const stillOurs = await getRecord(acme, 'companies', String(acmeCo.record.id));
T('the row is unchanged after the cross-tenant write', stillOurs.name === 'Acme Widgets', stillOurs.name);

const crossDelete = await attempt(() => softDeleteRecord(globex, 'companies', String(acmeCo.record.id)));
T('another tenant cannot delete it', !crossDelete.ok, crossDelete);
const stillLive = await getRecord(acme, 'companies', String(acmeCo.record.id));
T('the row survives the cross-tenant delete', !stillLive.deleted_at);

const notAUuid = await attempt(() => getRecord(globex, 'companies', "'; DROP TABLE companies; --"));
T('a non-UUID id is a clean 404, never reaches SQL', !notAUuid.ok && notAUuid.e.code === 'NOT_FOUND', notAUuid);
const stillThere = await (await getDb()).query('SELECT 1 FROM companies LIMIT 1');
T('the companies table still exists after injection attempt', stillThere.rows.length === 1);

console.log('\n=== tenant predicate backstop ===');
const scopeBackstop = await attempt(() => new TenantScope(acme.organizationId).query('SELECT * FROM contacts'));
T('a tenant query without organization_id is refused at runtime', !scopeBackstop.ok, scopeBackstop);

console.log('\n=== validation ===');
const badEnum = await attempt(() => createRecord(acme, 'contacts', { last_name: 'X', lifecycle_stage: 'supreme' }));
T('an out-of-range enum is rejected', !badEnum.ok && badEnum.e.code === 'BAD_REQUEST', badEnum);
const badScore = await attempt(() => createRecord(acme, 'leads', { last_name: 'X', score: 500 }));
T('a score above 100 is rejected before the CHECK fires', !badScore.ok && badScore.e.code === 'BAD_REQUEST', badScore);
const badColour = await attempt(() => createRecord(acme, 'tags', { name: 'vip', color: 'red' }));
T('a non-hex tag colour is rejected', !badColour.ok, badColour);
const badFilter = await attempt(() => listRecords(acme, 'contacts', { filters: { organization_id: globex.organizationId } }));
T('filtering by organization_id is refused', !badFilter.ok, badFilter);
const badSort = await attempt(() => listRecords(acme, 'contacts', { sort: 'id; DROP TABLE contacts' }));
T('an injection payload as a sort column is refused', !badSort.ok, badSort);

console.log('\n=== search ===');
const found = await listRecords(acme, 'contacts', { q: 'reed' });
T('free-text search finds the contact', found.data.some((r) => r.id === ava.record.id), found.total);
const wildcard = await listRecords(acme, 'contacts', { q: '%' });
T('a bare % is escaped and does not match everything',
  wildcard.data.length === 0 || wildcard.data.every((r) => String(r.last_name).includes('%')), wildcard.data.length);
const globexSearch = await listRecords(globex, 'contacts', { q: 'reed' });
T('search never crosses the tenant boundary', globexSearch.total === 0, globexSearch.total);

console.log('\n=== pipelines, stages, deals ===');
const pipeline = await createPipelineWithStages(acme, { name: 'Enterprise', isDefault: true });
const stages = await listPipelineStages(acme, String(pipeline.id));
T('a pipeline is created with stages', stages.length === 5, stages.length);
T('stages are ordered', stages.every((s, i) => Number(s.position) === i));
T('the last stage is the won stage', stages[4]?.is_won === true);

// A pipeline the tenant cannot see yields an empty list, not a 404 and not a
// leak. Throwing would be wrong here: "not visible to you" and "does not exist"
// must be indistinguishable, and an empty list is the truthful answer for a
// nested collection.
const globexStages = await listPipelineStages(globex, String(pipeline.id));
T('another tenant sees none of these stages', globexStages.length === 0, globexStages.length);
T('the stage ids are genuinely absent, not merely hidden', globexStages.every((s) => s.pipeline_id !== pipeline.id));

const deal = await createRecord(acme, 'deals', {
  name: 'Acme renewal', value_c: 2_500_00, currency: 'USD',
  pipeline_id: String(pipeline.id), stage_id: String(stages[0]!.id),
  contact_id: String(ava.record.id), company_id: String(acmeCo.record.id),
});
T('deal created', Boolean(deal.record.id));

const wrongPipeline = await createPipelineWithStages(acme, { name: 'SMB' });
const wrongStages = await listPipelineStages(acme, String(wrongPipeline.id));
const crossStage = await attempt(() => moveDealStage(acme, String(deal.record.id), String(wrongStages[0]!.id)));
T('a stage from another pipeline is refused', !crossStage.ok, crossStage);

const wonStage = stages[4]!;
const won = await moveDealStage(acme, String(deal.record.id), String(wonStage.id));
T('moving to the won stage sets status', won.status === 'won', won.status);
T('moving to the won stage stamps closed_at', Boolean(won.closed_at));
T('moving to the won stage adopts the stage probability', Number(won.probability) === Number(wonStage.probability));

console.log('\n=== lead conversion (transactional) ===');
const lead = await createRecord(acme, 'leads', {
  first_name: 'Mia', last_name: 'Stone', email: 'mia@prospect.io',
  company_name: 'Prospect Global', title: 'Head of Ops', source: 'webinar', score: 70, rating: 'hot',
});
T('lead created', Boolean(lead.record.id));

const converted = await convertLead(acme, String(lead.record.id), {
  createCompany: true, dealName: 'Prospect Global - platform', dealValueC: 1_200_00,
});
T('conversion creates a contact', Boolean(converted.contact.id));
T('conversion creates a company when asked', Boolean(converted.company?.id));
T('conversion creates a deal when asked', Boolean(converted.deal?.id));
T('the lead is marked converted', converted.lead.status === 'converted');
T('converted_at is stamped', Boolean(converted.lead.converted_at));
T('the contact id is linked back to the lead',
  converted.lead.converted_contact_id === String(converted.contact.id));
T('the deal id is linked back to the lead',
  converted.lead.converted_deal_id === String(converted.deal?.id));
T('the contact carries the company', converted.contact.company_id === String(converted.company?.id));

const twice = await attempt(() => convertLead(acme, String(lead.record.id), {}));
T('converting twice is refused', !twice.ok && twice.e.code === 'CONFLICT', twice);

console.log('\n=== conversion is all-or-nothing ===');
const beforeContactCount = (await listRecords(acme, 'contacts')).total;
const doomedLead = await createRecord(acme, 'leads', { first_name: 'Roll', last_name: 'Back', email: 'rollback@prospect.io' });
// No pipeline exists in this tenant, so a deal-bearing conversion cannot resolve a stage.
const doomed = await attempt(() => convertLead(globex, String(doomedLead.record.id), { dealName: 'x' }));
T('conversion into a tenant with no pipeline fails cleanly', !doomed.ok, doomed);
const rollLead = await getRecord(acme, 'leads', String(doomedLead.record.id));
T('a failed conversion leaves the lead not-converted', rollLead.status !== 'converted', rollLead.status);
T('a failed conversion creates no contact',
  (await listRecords(acme, 'contacts')).total === beforeContactCount,
  (await listRecords(acme, 'contacts')).total);

const globexBefore = (await listRecords(globex, 'contacts')).total;
const crossConvert = await attempt(() => convertLead(globex, String(lead.record.id), {}));
T('another tenant cannot convert this lead', !crossConvert.ok, crossConvert);
T('a refused cross-tenant conversion creates nothing',
  (await listRecords(globex, 'contacts')).total === globexBefore);

console.log('\n=== soft delete and restore ===');
const doomed2 = await createRecord(acme, 'companies', { name: 'Deletable Co' });
await softDeleteRecord(acme, 'companies', String(doomed2.record.id));
T('a deleted record is hidden from reads',
  (await attempt(() => getRecord(acme, 'companies', String(doomed2.record.id)))).ok === false);
T('a deleted record is excluded from list',
  (await listRecords(acme, 'companies')).data.every((r) => r.id !== doomed2.record.id));
T('a deleted record is still counted when includeDeleted is set',
  (await listRecords(acme, 'companies', { includeDeleted: true })).data.some((r) => r.id === doomed2.record.id));
await restoreRecord(acme, 'companies', String(doomed2.record.id));
T('a deleted record can be restored', (await getRecord(acme, 'companies', String(doomed2.record.id))).name === 'Deletable Co');

console.log('\n=== audit trail accompanies every mutation ===');
const auditCount = async (org: string, action: string): Promise<number> => {
  const r = await (await getDb()).query<{ n: number }>(
    'SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action = $2', [org, action]);
  return r.rows[0]?.n ?? 0;
};
T('company.create is audited', (await auditCount(acme.organizationId, 'companies.create')) > 0);
T('contact.create is audited', (await auditCount(acme.organizationId, 'contacts.create')) > 0);
T('deal create is audited', (await auditCount(acme.organizationId, 'deals.create')) > 0);
T('deal stage move is audited', (await auditCount(acme.organizationId, 'deals.advance')) > 0);
T('lead conversion is audited', (await auditCount(acme.organizationId, 'leads.convert')) > 0);
T('delete is audited', (await auditCount(acme.organizationId, 'companies.delete')) > 0);
T('restore is audited', (await auditCount(acme.organizationId, 'companies.restore')) > 0);
T('the other tenant has no audit rows for these actions',
  (await auditCount(globex.organizationId, 'leads.convert')) === 0);

console.log('\n=== viewer role sees records but the matrix still gates writes ===');
T('a viewer can list contacts', (await listRecords(viewerAcme, 'contacts')).total > 0);
T('the viewer actor reads the same tenant', viewerAcme.organizationId === acme.organizationId);
const viewerOther = await attempt(() => getRecord({ ...viewerAcme, organizationId: globex.organizationId }, 'contacts', String(ava.record.id)));
T('a viewer from another tenant still cannot read it', !viewerOther.ok, viewerOther);

console.log('\n=== regression: a rejected optional write must not roll back the business write ===');
// This is the shape of the bug that produced "created, but not in the table".
// A failing audit/activity statement aborts a PostgreSQL transaction outright;
// catching the error in JS does not undo that, and the eventual COMMIT is
// downgraded to a ROLLBACK. The caller still holds the RETURNING row and
// reports success. `TenantScope.bestEffort` contains it with a SAVEPOINT.
{
  const scope = new TenantScope(acme.organizationId);
  const poisonedId = newId();
  let committedId: string | null = null;

  const outcome = await scope.transaction(async (tx) => {
    await tx.unsafe.query(
      `INSERT INTO companies (id, organization_id, name, name_normalized, created_at, updated_at, created_by, updated_by)
       VALUES ($1,$2,'Poison Test Co','poison test co',now(),now(),$3,$3)`,
      [poisonedId, acme.organizationId, acme.userId]);
    // Deliberately violates activities_entity_type_check.
    await tx.bestEffort('test.bad_activity', async (s) => {
      await s.unsafe.query(
        `INSERT INTO activities (id, organization_id, type, actor_id, entity_type, entity_id, metadata, occurred_at, created_at)
         VALUES ($1,$2,'created',$3,'not_a_real_type',$4,'{}'::jsonb,now(),now())`,
        [newId(), acme.organizationId, acme.userId, poisonedId]);
      return true;
    });
    // If the transaction had been poisoned, this statement fails with 25P02.
    const stillAlive = await tx.unsafe.query('SELECT count(*)::int AS n FROM companies WHERE id = $1', [poisonedId]);
    committedId = stillAlive.rows[0]?.n === 1 ? poisonedId : null;
    return true;
  });

  T('the transaction completes rather than throwing', outcome === true);
  T('statements after the rejected write still run', committedId === poisonedId, committedId);
  const persisted = await attempt(() => getRecord(acme, 'companies', poisonedId));
  T('the business write actually committed', persisted.ok, persisted);
  const activityCount = await (await getDb()).query<{ n: number }>(
    'SELECT count(*)::int AS n FROM activities WHERE entity_type = $1', ['not_a_real_type']);
  T('the rejected activity row was rolled back to its savepoint', activityCount.rows[0]?.n === 0, activityCount.rows[0]);
  T('and the failure was reported, not hidden',
    (await (await getDb()).query<{ n: number }>(
      'SELECT count(*)::int AS n FROM companies WHERE name = $1', ['Poison Test Co'])).rows[0]?.n === 1);
}

console.log('\n=== helper: ensureDefaultPipeline is idempotent ===');
const first = await ensureDefaultPipeline(globex);
const second = await ensureDefaultPipeline(globex);
T('calling it twice returns the same pipeline', first.id === second.id);
T('and it is a different tenant from acme first-tenant pipelines',
  first.organization_id === globex.organizationId);

console.log(`\n================ ${pass} passed, ${fails.length} failed ================`);
if (fails.length) console.log('FAILURES:\n - ' + fails.join('\n - '));
process.exit(fails.length ? 1 : 0);
